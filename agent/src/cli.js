#!/usr/bin/env node
// harness-usage — per-device telemetry agent.
//
//   sync       incremental extract -> local JSONL archive -> Postgres upsert
//   backfill   ignore cursors, re-scan everything, drain the outbox
//   show       print the local summary (totals, per-model, unsynced backlog)
//   compare    counterfactual repricing against other models
//   doctor     preflight + regression checks
//
// Short-lived: it wakes, syncs, exits. A missed run is harmless — the next one
// just has more to do.

import { runSync } from "./sync.js";
import { runDoctor } from "./doctor.js";
import { LocalStore } from "./local-store.js";
import { loadConfig, CONFIG_PATH } from "./config.js";
import { loadPricing } from "./pricing.js";
import { compare, GROUP_KEYS } from "./reprice.js";

const [cmd, ...args] = process.argv.slice(2);
const opts = parseArgs(args);

try {
  switch (cmd) {
    case "sync":
      await cmdSync({ full: false });
      break;
    case "backfill":
      await cmdSync({ full: true });
      break;
    case "show":
      await cmdShow();
      break;
    case "compare":
      await cmdCompare();
      break;
    case "compact-archive":
      await cmdCompactArchive();
      break;
    case "restore-archive":
      await cmdRestoreArchive();
      break;
    case "reprice":
      await cmdReprice();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "-h":
    case "--help":
    case undefined:
      usage();
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      usage();
      process.exit(2);
  }
} catch (err) {
  console.error(`harness-usage ${cmd}: ${err.stack || err.message}`);
  process.exit(1);
}

/**
 * Strict by design: an unrecognised flag is an ERROR, never something to skip.
 *
 * `reprice` rewrites the stored ledger, so silently ignoring a mistyped
 * `--dryrun` turned a rehearsal into a real, unfiltered re-valuation — the one
 * command where a typo costs the most. Missing values are rejected for the same
 * reason: `--model --dry-run` used to swallow the next flag as the model name
 * and then reprice nothing at all, reporting success.
 */
function parseArgs(argv) {
  const o = {
    as: [],
    group: null,
    since: null,
    onlyLocal: false,
    noShip: false,
    unpricedOnly: false,
    model: null,
    scenario: null,
    dryRun: false,
  };
  let i = 0;
  const value = (flag) => {
    const v = argv[++i];
    if (v === undefined || v.startsWith("-")) bail(`${flag} needs a value`);
    return v;
  };
  for (; i < argv.length; i++) {
    switch (argv[i]) {
      case "--as":
        o.as.push(value("--as"));
        break;
      case "--group":
        o.group = value("--group");
        break;
      case "--since":
        o.since = value("--since");
        break;
      case "--only-local":
        o.onlyLocal = true;
        break;
      case "--no-ship":
        o.noShip = true;
        break;
      case "--unpriced-only":
        o.unpricedOnly = true;
        break;
      case "--model":
        o.model = value("--model");
        break;
      case "--scenario":
        o.scenario = value("--scenario");
        break;
      case "--dry-run":
        o.dryRun = true;
        break;
      default:
        bail(`unknown option ${argv[i]}`);
    }
  }
  return o;
}

function bail(msg) {
  console.error(`harness-usage: ${msg}\n`);
  usage();
  process.exit(2);
}

async function cmdSync({ full }) {
  const r = await runSync({ full, noShip: opts.noShip });
  const label = full ? "backfill" : "sync";
  const parts = Object.entries(r.extracted)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(
    `${label} [${r.device}] extracted { ${parts} }  ` +
      `recorded new=${r.recorded.new} changed=${r.recorded.changed} unchanged=${r.recorded.unchanged}`,
  );
  // Worth surfacing: on a backfill this should account for essentially the whole
  // history. If it ever reads 0 there, the plans/004 freeze is not holding and
  // the run just re-valued everything at today's rates.
  if (r.frozen) {
    console.log(
      `  frozen: ${r.frozen} re-extracted events kept their stored valuation (plans/004)`,
    );
  }
  if (r.unpriced.length) {
    console.log(`  unpriced models: ${r.unpriced.join(", ")}`);
  }
  if (r.scenarioRows) {
    console.log(`  scenarios: ${r.scenarioRows} rows across the configured targets`);
  }
  if (r.unresolvedScenarios?.length) {
    console.log(`  UNRESOLVED scenarios (skipped): ${r.unresolvedScenarios.join(", ")}`);
  }
  if (r.prunedScenarios?.length) {
    console.log(`  pruned de-configured scenarios: ${r.prunedScenarios.join(", ")}`);
  }
  if (r.shipError) {
    console.log(
      `  ship: FAILED (${r.shipError}); ${r.unsynced} events + ` +
        `${r.unsyncedScenarios} scenario rows queued locally`,
    );
    process.exitCode = 3;
  } else if (r.shipped || r.shippedScenarios) {
    console.log(
      `  ship: ${r.shipped} events + ${r.shippedScenarios} scenario rows upserted; backlog clear`,
    );
  } else {
    console.log(`  ship: nothing to send`);
  }
}

/**
 * Deliberate re-valuation. Stored costs are frozen at ingest (plans/004), so
 * this is the ONLY way to correct one — after fixing a pricing bug or adding an
 * override. Without it the gpt-5.6-terra-fast incident, where 171 events sat at
 * $0 while a lookup bug was live, would have been permanent.
 */
async function cmdReprice() {
  const config = await loadConfig();
  const pricing = await loadPricing({
    modelsJsonPath: config.pricing.modelsJson,
    overridesPath: config.pricing.overrides,
  });
  const store = new LocalStore();
  try {
    if (opts.scenario) {
      if (opts.dryRun) {
        console.log(`dry-run: would drop all stored rows for scenario ${opts.scenario}`);
      } else {
        const n = store.dropScenario(opts.scenario);
        console.log(
          `dropped ${n} rows for ${opts.scenario}; the next sync reprices them at current rates`,
        );
      }
      return;
    }

    let examined = 0;
    const updates = [];
    for (const ev of store.allEvents()) {
      if (opts.model && `${ev.provider}/${ev.model}` !== opts.model) continue;
      if (opts.unpricedOnly && ev.priced_by !== "none") continue;
      examined++;

      const srcCfg = config.sources[ev.harness];
      const priced = pricing.price(ev, srcCfg?.billing || "free");
      const moved =
        Math.abs((priced.cost_usd || 0) - (ev.cost_usd || 0)) > 1e-9 ||
        priced.priced_by !== ev.priced_by;
      if (moved) updates.push({ ev, priced });
    }

    const scope =
      (opts.model ? ` model=${opts.model}` : "") +
      (opts.unpricedOnly ? " unpriced-only" : "");
    if (!updates.length) {
      console.log(`reprice:${scope || " all"} — ${examined} events examined, none would change`);
      return;
    }

    const delta = updates.reduce(
      (s, u) => s + (u.priced.cost_usd || 0) - (u.ev.cost_usd || 0),
      0,
    );
    const sample = updates
      .slice(0, 3)
      .map(
        (u) =>
          `${u.ev.provider}/${u.ev.model} $${(u.ev.cost_usd || 0).toFixed(6)} -> $${u.priced.cost_usd.toFixed(6)}`,
      );

    if (opts.dryRun) {
      console.log(
        `dry-run:${scope || " all"} — ${examined} examined, ${updates.length} would change, ` +
          `net $${delta.toFixed(2)}\n  e.g. ${sample.join("\n       ")}`,
      );
      return;
    }

    store.transaction(() => {
      for (const { ev, priced } of updates) store.record({ ...ev, ...priced });
    });
    console.log(
      `repriced ${updates.length}/${examined} events, net $${delta.toFixed(2)}; ` +
        `queued for shipping\n  e.g. ${sample.join("\n       ")}`,
    );
  } finally {
    store.close();
  }
}

/**
 * Recovery for a lost state.sqlite. `backfill` only re-reads the harnesses,
 * which have pruned anything past their own retention, so the JSONL archive is
 * the only way back to older history.
 */
async function cmdRestoreArchive() {
  const store = new LocalStore();
  try {
    const r = store.importArchive();
    console.log(
      `restore-archive: ${r.events} events across ${r.files} files ` +
        `(last-wins per event)\n` +
        `  restored ${r.restored} missing from the outbox; left ${r.present} existing rows untouched`,
    );
    if (r.unreadable) {
      console.log(`  ${r.unreadable} unparseable lines skipped`);
    }
    if (r.restored) {
      console.log(
        `  queued for shipping — run 'harness-usage sync' to send them, then\n` +
          `  'harness-usage backfill' to pick up anything newer from the harnesses`,
      );
    }
  } finally {
    store.close();
  }
}

async function cmdCompactArchive() {
  const store = new LocalStore();
  try {
    const r = store.compactArchive();
    if (r.removed === 0) {
      console.log(`archive already compact: ${r.linesAfter} lines across ${r.files} files`);
      return;
    }
    console.log(
      `compacted ${r.files} files: ${r.linesBefore} -> ${r.linesAfter} lines ` +
        `(${r.removed} superseded duplicates removed, last-wins per event)`,
    );
  } finally {
    store.close();
  }
}

async function cmdShow() {
  const store = new LocalStore();
  try {
    const s = store.summary();
    console.log("Harness usage — local archive\n");
    for (const t of s.totals) {
      console.log(
        `  ${t.harness.padEnd(12)} ${String(t.events).padStart(6)} events  ` +
          `${String(t.unsynced).padStart(5)} unsynced  ${t.first_ts?.slice(0, 10)} .. ${t.last_ts?.slice(0, 10)}`,
      );
    }
    console.log(
      `\n  total: ${s.totalEvents} events, ${s.totalUnsynced} unsynced, ` +
        `$${(s.totalCost || 0).toFixed(2)} (potential) cost\n`,
    );
    console.log("  by model:");
    for (const m of s.byModel) {
      console.log(
        `    ${String(m.provider || "?") + "/" + String(m.model || "?")}`.padEnd(34) +
          `${String(m.events).padStart(6)} ev  ` +
          `${fmtTokens(m.tokens).padStart(9)} tok  ` +
          `$${(m.cost_usd || 0).toFixed(4)}`,
      );
    }
  } finally {
    store.close();
  }
}

async function cmdCompare() {
  const config = await loadConfig();
  const pricing = await loadPricing({
    modelsJsonPath: config.pricing.modelsJson,
    overridesPath: config.pricing.overrides,
  });

  const scenarios = opts.as.length ? opts.as : config.scenarios || [];
  if (!scenarios.length) {
    console.error(
      "compare: no targets. Pass --as <provider/model> (repeatable), or set `scenarios` in config.json.",
    );
    process.exit(2);
  }
  if (opts.group && !GROUP_KEYS.includes(opts.group)) {
    console.error(`compare: --group must be one of ${GROUP_KEYS.join(", ")}`);
    process.exit(2);
  }

  const store = new LocalStore();
  try {
    const filter = (e) => {
      if (opts.onlyLocal && e.billing !== "local") return false;
      if (opts.since && e.ts.slice(0, 10) < opts.since) return false;
      return true;
    };

    const { rows, totals, meta } = compare({
      events: store.allEvents(),
      pricing,
      scenarios,
      groupBy: opts.group,
      filter,
    });

    if (!totals.responses) {
      console.log("compare: no events matched. Run `harness-usage sync` first?");
      return;
    }

    const usable = meta.filter((m) => m.resolved);
    console.log(
      `Counterfactual repricing — ${totals.responses} events` +
        (opts.onlyLocal ? ", local models only" : "") +
        (opts.since ? `, since ${opts.since}` : "") +
        "\n",
    );

    console.log("  targets:");
    meta.forEach((m, i) => {
      if (!m.resolved) {
        console.log(`    [${i + 1}] ${m.scenario}  — NO RATE CARD, skipped`);
        return;
      }
      const warn = m.cache_model === "none" ? "  <- no prompt caching" : "";
      console.log(
        `    [${i + 1}] ${m.scenario.padEnd(44)} cache: ${m.cache_model}${warn}`,
      );
    });
    console.log();

    const label = opts.group ? opts.group : "scope";
    const w = Math.max(
      label.length,
      ...rows.map((r) => String(r.key).length),
      totals.key.length,
    );
    const head =
      `  ${label.padEnd(w)}  ${"resp".padStart(6)}  ${"tokens".padStart(9)}  ${"actual".padStart(10)}` +
      usable.map((_, i) => `  ${`[${i + 1}]`.padStart(10)}`).join("");
    console.log(head);
    console.log("  " + "-".repeat(head.length - 2));

    const line = (r) =>
      `  ${shorten(String(r.key), w).padEnd(w)}  ${String(r.responses).padStart(6)}  ` +
      `${fmtTokens(r.tokens).padStart(9)}  ${("$" + r.actual_cost_usd.toFixed(2)).padStart(10)}` +
      usable
        .map((m) => `  ${("$" + r.scenarios[m.scenario].cost_usd.toFixed(2)).padStart(10)}`)
        .join("");

    for (const r of rows) console.log(line(r));
    if (rows.length > 1) console.log("  " + "-".repeat(head.length - 2));
    console.log(line(totals));

    // Multiplier vs actual makes the decision legible at a glance.
    if (totals.actual_cost_usd > 0) {
      console.log(
        `\n  vs actual:` +
          usable
            .map(
              (m, i) =>
                `  [${i + 1}] ${(totals.scenarios[m.scenario].cost_usd / totals.actual_cost_usd).toFixed(2)}x`,
            )
            .join(""),
      );
    }

    console.log(
      "\n  Estimates only — token counts are not portable across tokenizers.\n" +
        "  A target marked cache:none bills cache reads at its full input rate.",
    );
  } finally {
    store.close();
  }
}

async function cmdDoctor() {
  const config = await loadConfig();
  console.log(`harness-usage doctor  (config: ${config._path || `${CONFIG_PATH} [missing]`})\n`);
  const checks = await runDoctor();
  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? "ok  " : "FAIL";
    if (!c.ok) failed++;
    console.log(`  [${mark}] ${c.name}`);
    if (c.detail) console.log(`         ${c.detail}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed) process.exit(1);
}

function shorten(s, w) {
  return s.length <= w ? s : "…" + s.slice(-(w - 1));
}

function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function usage() {
  console.log(`harness-usage <command> [--flags]

  sync              incremental extract -> local archive -> Postgres
  backfill          re-scan everything (ignores cursors), drain the outbox
  show              print the local summary
  compare           reprice stored usage against other models
  compact-archive   rewrite events/*.jsonl keeping the last line per event
  restore-archive   reload the JSONL archive into the outbox (lost state.sqlite)
  reprice           deliberately re-value stored events (costs are frozen at ingest)
  doctor            preflight + regression checks

  --no-ship         sync/backfill: write the local archive only, skip Postgres

  compare flags:
  --as <prov/model> target to reprice against; repeatable.
                    Defaults to the 'scenarios' list in config.json.
  --group <key>     ${GROUP_KEYS.join(" | ")}
  --since <YYYY-MM-DD>
  --only-local      only events billed 'local' (what your Ollama box saves)

  reprice flags:
  --unpriced-only   only events with no rate card (after adding an override)
  --model <prov/model>  restrict to one model
  --scenario <key>  drop that scenario's rows; next sync reprices them
  --dry-run         report what would change, write nothing

config: ${CONFIG_PATH}`);
}
