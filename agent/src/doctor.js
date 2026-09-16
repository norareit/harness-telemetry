// `harness-usage doctor` — preflight and regression checks.
//
//   * resolves both source paths, reports history size
//   * loads the price table, lists models with no entry
//   * Claude Code dedupe regression: recompute deduped totals and compare to the
//     baseline measured for the plan
//   * OpenCode reconciliation: per-message sums vs the session rollup columns
//   * tests the Postgres connection and schema

import { existsSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, expandHome, CONFIG_PATH, DATA_DIR } from "./config.js";
import { LocalStore } from "./local-store.js";
import { loadPricing } from "./pricing.js";
import { PostgresSink } from "./sink-postgres.js";
import { reconcile } from "./sources/opencode.js";

// Dedupe regression. The absolute totals drift up as the machine keeps being
// used, so the hard assertion is on the naive/deduped RATIO, which is stable:
// Claude Code repeats usage on ~62% of requestIds, so a naive sum is ~2.2-2.5x
// the deduped one. A dedupe bug collapses that ratio to ~1.0. The 2026-09-09
// absolute figures (see plans/001) are reported for reference only.
const CC_BASELINE = {
  measuredOn: "2026-09-09",
  dedupedOutputTokens: 2_290_000, // naive sum ~5.17M  -> ratio ~2.26
  dedupedCacheCreation: 8_370_000, // naive sum ~18.45M -> ratio ~2.20
  minRatio: 1.5, // dedupe is clearly doing something
};

export async function runDoctor() {
  const config = await loadConfig();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // Loaded up front: the Claude Code section prices thinking tokens with it.
  const pricing = await loadPricing({
    modelsJsonPath: config.pricing.modelsJson,
    overridesPath: config.pricing.overrides,
  });

  // --- config -------------------------------------------------------------
  add(
    "config file",
    Boolean(config._path),
    config._path
      ? config._path
      : `not found at ${CONFIG_PATH} — running on defaults (no DSN)`,
  );
  add("device name", true, config.device);
  add("data dir", true, DATA_DIR);

  // --- Claude Code source ----------------------------------------------------
  const ccEnabled = config.sources["claude-code"]?.enabled !== false;
  const ccRoot = expandHome(config.sources["claude-code"].root);
  if (ccEnabled) {
    if (existsSync(ccRoot)) {
      const files = await listJsonl(ccRoot);
      add("claude-code transcripts", files.length > 0, `${files.length} files at ${ccRoot}`);
      try {
        const totals = await dedupeTotals(files);
        const outRatio = totals.output ? totals.naiveOutput / totals.output : 1;
        const ccRatio = totals.cacheCreation
          ? totals.naiveCacheCreation / totals.cacheCreation
          : 1;
        const ok =
          outRatio >= CC_BASELINE.minRatio &&
          ccRatio >= CC_BASELINE.minRatio &&
          totals.usageConflicts === 0;
        add(
          "claude-code dedupe regression",
          ok,
          `deduped output=${fmtM(totals.output)} vs naive ${fmtM(totals.naiveOutput)} (${outRatio.toFixed(2)}x), ` +
            `cache-creation=${fmtM(totals.cacheCreation)} vs naive ${fmtM(totals.naiveCacheCreation)} (${ccRatio.toFixed(2)}x); ` +
            `need >=${CC_BASELINE.minRatio}x. ` +
            `ref ${CC_BASELINE.measuredOn}: output≈${fmtM(CC_BASELINE.dedupedOutputTokens)}, cache≈${fmtM(CC_BASELINE.dedupedCacheCreation)}. ` +
            `${totals.multiUsageRequests}/${totals.uniqueRequests} requestIds repeat usage; ` +
            `${totals.usageConflicts} usage conflicts (must be 0)`,
        );
      } catch (err) {
        add("claude-code dedupe regression", false, err.message);
      }
    } else {
      add("claude-code transcripts", false, `path not found: ${ccRoot}`);
    }
  }

  // --- OpenCode source -----------------------------------------------------
  const ocEnabled = config.sources.opencode?.enabled !== false;
  const ocDb = expandHome(config.sources.opencode.db);
  if (ocEnabled) {
    if (existsSync(ocDb)) {
      try {
        const db = new DatabaseSync(ocDb, { readOnly: true });
        const msgs = db.prepare("SELECT COUNT(*) c FROM message").get().c;
        const sess = db.prepare("SELECT COUNT(*) c FROM session").get().c;
        db.close();
        add("opencode db", true, `${msgs} messages / ${sess} sessions at ${ocDb}`);

        const rec = reconcile(ocDb);
        add(
          "opencode reconciliation",
          rec.ok === rec.total,
          `${rec.ok}/${rec.total} sessions reconcile per-message sums vs rollup columns` +
            (rec.mismatches.length
              ? ` — first mismatch: ${JSON.stringify(rec.mismatches[0])}`
              : ""),
        );
      } catch (err) {
        add("opencode db", false, `cannot read ${ocDb}: ${err.message}`);
      }
    } else {
      add("opencode db", false, `path not found: ${ocDb}`);
    }
  }

  // --- pricing -----------------------------------------------------------
  add(
    "price table",
    !pricing.meta.tableError,
    pricing.meta.tableError
      ? `failed to load ${pricing.meta.modelsPath}: ${pricing.meta.tableError.message}`
      : `${countModels(pricing.table)} models from ${pricing.meta.modelsPath}`,
  );

  // Regression guard for the bug where extraction normalized reasoning OUT of
  // output_tokens while pricing still assumed it was IN, billing Anthropic
  // thinking tokens at $0. Asserted as a unit probe so it cannot drift with the
  // dataset: 1M reasoning tokens on opus-5 must cost the full output rate.
  const probe = {
    provider: "anthropic",
    model: "claude-opus-5",
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 1_000_000,
    cache_read_tokens: 0,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
  };
  // The probe needs its own rate card to state an expectation. A stale price
  // table has no anthropic/claude-opus-5 entry at all, and reading `.card.base`
  // off that miss threw out of runDoctor() — losing every check below to a
  // TypeError that named neither the model nor the table. A miss fails THIS
  // check and nothing else; "scenarios resolve" then says which else are gone.
  const probeCard = pricing.resolve("anthropic", "claude-opus-5").card;
  if (probeCard) {
    const probeCost = pricing.price(probe, "free").cost_usd;
    const expectedProbe = probeCard.base.output;
    add(
      "reasoning tokens billed",
      Math.abs(probeCost - expectedProbe) < 1e-6,
      `1M reasoning tokens on claude-opus-5 = $${probeCost} (must be $${expectedProbe}; ` +
        `$0 means the reasoning-exclusion regression is back)`,
    );
  } else {
    add(
      "reasoning tokens billed",
      false,
      `cannot run: no rate card for anthropic/claude-opus-5 in ${pricing.meta.modelsPath} — ` +
        `the table is refreshed by OpenCode, so a copy older than the model predates it. ` +
        `Refresh it, or pin the model in pricing-overrides.json`,
    );
  }

  // Configured counterfactual targets must all resolve, or the dashboard
  // silently loses a scenario.
  const scenarios = config.scenarios || [];
  if (scenarios.length) {
    const unresolved = scenarios.filter((s) => !pricing.resolveKey(s).card);
    add(
      "scenarios resolve",
      unresolved.length === 0,
      unresolved.length
        ? `no rate card for: ${unresolved.join(", ")}`
        : scenarios
            .map((s) => `${s} [${pricing.cacheModelOf(s)}]`)
            .join(", "),
    );
  }

  // Cost must be reproducible from the stored inputs alone (plans/003). This is
  // the one invariant that does not require trusting the pricing code path that
  // produced the number — it recomputes from the persisted rates and compares.
  {
    const store = new LocalStore();
    try {
      let total = 0;
      let checked = 0;
      let bad = 0;
      let unrated = 0;
      let firstBad = null;
      for (const e of store.allEvents()) {
        total++;
        if (e.rate_input == null) {
          // No rate card at all (ollama and friends): genuinely unpriceable, not
          // stale. Must not be reported as something a backfill would fix.
          if (e.priced_by === "none") unrated++;
          continue;
        }
        checked++;
        const recomputed =
          (e.input_tokens * e.rate_input +
            (e.output_tokens + e.reasoning_tokens) * e.rate_output +
            e.cache_read_tokens * e.rate_cache_read +
            e.cache_write_5m_tokens * e.rate_cache_write_5m +
            e.cache_write_1h_tokens * e.rate_cache_write_1h) /
          1e6;
        if (Math.abs(recomputed - e.cost_usd) > 1e-6) {
          bad++;
          firstBad ??= `${e.message_id}: stored $${e.cost_usd} vs recomputed $${recomputed.toFixed(6)}`;
        }
      }
      add(
        "cost reproducible from stored rates",
        bad === 0,
        total === 0
          ? "no events stored yet"
          : `${checked}/${total} events carry rates; ${bad} mismatch` +
            (firstBad ? ` — e.g. ${firstBad}` : "") +
            (unrated ? `; ${unrated} have no rate card (local/unpriced — expected)` : "") +
            (total - checked - unrated > 0
              ? `; ${total - checked - unrated} priced but missing rates — run backfill`
              : ""),
      );
    } finally {
      store.close();
    }
  }

  // --- price table freshness (plans/004) ---------------------------------
  // Under the freeze a stale table is PERMANENT damage: every event ingested
  // while it is stale is valued wrongly forever, with no self-correction on a
  // later sync. models.json is maintained by OpenCode, not by this repo —
  // nothing here refreshes it, so running OpenCode is what updates prices.
  try {
    const modelsPath = expandHome(config.pricing.modelsJson);
    const st = await stat(modelsPath);
    const days = (Date.now() - st.mtimeMs) / 86_400_000;
    add(
      "price table freshness",
      days <= 14,
      `${modelsPath} last updated ${days.toFixed(1)} days ago` +
        (days > 14
          ? " — run OpenCode to refresh it; with prices frozen at ingest, stale rates are baked in permanently"
          : ""),
    );
  } catch (err) {
    add("price table freshness", false, err.message);
  }

  // --- override drift ------------------------------------------------------
  // A pinned override deliberately does not track the table — that is the point
  // — but silent rot is not. Compare each pin against the live table where the
  // table actually has an entry.
  {
    const drift = [];
    const pins = Object.entries(pricing.overrides || {});
    for (const [key, ov] of pins) {
      const live = pricing.tableCard(key);
      if (!live) continue; // no table entry is usually *why* it is pinned
      for (const f of ["input", "output", "cache_read", "cache_write"]) {
        const pinned = ov[f];
        const table = live.base[f];
        if (pinned != null && table != null && Math.abs(pinned - table) > 1e-9) {
          drift.push(`${key} ${f}: pinned ${pinned} vs table ${table}`);
        }
      }
    }
    add(
      "override drift",
      drift.length === 0,
      drift.length
        ? `${drift.join("; ")} — update pricing-overrides.json if the table is now right`
        : `${pins.length} pinned override(s), none diverging from the table`,
    );
  }

  // --- unpriced non-local events ------------------------------------------
  // Frozen costs do not self-heal, so an event stored with no rate card stays
  // at $0 until someone runs `reprice`. Local models are legitimately unpriced;
  // anything else is a candidate for correction once an override is added.
  {
    const store = new LocalStore();
    try {
      const byModel = new Map();
      for (const e of store.allEvents()) {
        if (e.priced_by !== "none") continue;
        if (e.billing === "local") continue;
        const k = `${e.provider}/${e.model}`;
        byModel.set(k, (byModel.get(k) || 0) + 1);
      }
      const total = [...byModel.values()].reduce((a, b) => a + b, 0);
      add(
        "no unpriced billable events",
        byModel.size === 0,
        byModel.size === 0
          ? "every non-local event carries a rate card"
          : `${total} events with no rate card: ` +
            [...byModel].map(([k, n]) => `${k} (${n})`).join(", ") +
            ` — add to pricing-overrides.json, then 'harness-usage reprice --unpriced-only'`,
      );
    } finally {
      store.close();
    }
  }

  const seenPairs = await modelsInUse(config);
  const unpriced = pricing.unpricedModels(seenPairs);
  add(
    "models priced",
    unpriced.length === 0,
    unpriced.length
      ? `no price entry for: ${unpriced.join(", ")} — add to pricing-overrides.json`
      : `all ${seenPairs.length} provider/model pairs in use resolve to a rate card`,
  );

  // --- Postgres --------------------------------------------------------
  if (config.postgres.dsn) {
    let sink;
    try {
      sink = new PostgresSink(config);
      const ok = await sink.ping();
      const { missingTables, missingColumns } = await sink.schemaGaps();
      add("postgres connection", ok, redactDsn(config.postgres.dsn));

      const gaps = [];
      if (missingTables.length) gaps.push(`tables: ${missingTables.join(", ")}`);
      if (missingColumns.length) {
        gaps.push(
          `columns: ${missingColumns.map((m) => `${m.table}.${m.column}`).join(", ")}`,
        );
      }
      add(
        "postgres schema",
        gaps.length === 0,
        gaps.length === 0
          ? "usage_event, usage_scenario complete"
          : `missing ${gaps.join("; ")} — postgres/init only runs on an empty volume, ` +
            `so apply server/postgres/migrations/ to an existing database ` +
            `(psql -f). Do NOT 'down -v' unless you mean to destroy stored history.`,
      );
    } catch (err) {
      add("postgres connection", false, `${redactDsn(config.postgres.dsn)}: ${err.message}`);
    } finally {
      if (sink) await sink.close();
    }
  } else {
    add("postgres connection", false, "postgres.dsn not configured");
  }

  return checks;
}

// --- helpers -------------------------------------------------------------

async function listJsonl(root) {
  const out = [];
  for (const d of await readdir(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    for (const f of await readdir(dir)) {
      if (f.endsWith(".jsonl")) out.push(join(dir, f));
    }
  }
  return out;
}

async function dedupeTotals(files) {
  const seen = new Map(); // requestId -> { sig, count }
  const usageByReq = new Map();
  let naiveOutput = 0;
  let naiveCacheCreation = 0;
  let usageConflicts = 0;

  for (const file of files) {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.type !== "assistant" || !rec.message?.usage) continue;
      if (rec.message.model === "<synthetic>") continue;

      const u = rec.message.usage;
      naiveOutput += u.output_tokens || 0;
      naiveCacheCreation += u.cache_creation_input_tokens || 0;

      const key = rec.requestId || rec.uuid;
      const sig = [
        u.input_tokens,
        u.output_tokens,
        u.cache_creation_input_tokens,
        u.cache_read_input_tokens,
      ].join(",");
      if (seen.has(key)) {
        const s = seen.get(key);
        s.count++;
        if (s.sig !== sig) usageConflicts++;
      } else {
        seen.set(key, { sig, count: 1 });
      }
      usageByReq.set(key, u);
    }
  }

  let output = 0;
  let cacheCreation = 0;
  for (const u of usageByReq.values()) {
    output += u.output_tokens || 0;
    cacheCreation += u.cache_creation_input_tokens || 0;
  }

  let multiUsageRequests = 0;
  for (const s of seen.values()) if (s.count > 1) multiUsageRequests++;

  return {
    output,
    cacheCreation,
    naiveOutput,
    naiveCacheCreation,
    uniqueRequests: usageByReq.size,
    multiUsageRequests,
    usageConflicts,
  };
}

async function modelsInUse(config) {
  const pairs = [];

  const ccRoot = expandHome(config.sources["claude-code"].root);
  if (config.sources["claude-code"]?.enabled !== false && existsSync(ccRoot)) {
    const models = new Set();
    for (const file of await listJsonl(ccRoot)) {
      const rl = createInterface({
        input: createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.includes('"assistant"')) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const m = rec.message?.model;
        if (m && m !== "<synthetic>") models.add(m);
      }
    }
    for (const m of models) pairs.push([m.startsWith("claude-") ? "anthropic" : "openai", m]);
  }

  const ocDb = expandHome(config.sources.opencode.db);
  if (config.sources.opencode?.enabled !== false && existsSync(ocDb)) {
    const db = new DatabaseSync(ocDb, { readOnly: true });
    const combos = new Set();
    for (const r of db.prepare("SELECT data FROM message").all()) {
      let d;
      try {
        d = JSON.parse(r.data);
      } catch {
        continue;
      }
      if (d.role === "assistant" && d.modelID) combos.add(`${d.providerID}\t${d.modelID}`);
    }
    db.close();
    for (const c of combos) pairs.push(c.split("\t"));
  }

  return pairs;
}

function countModels(table) {
  let n = 0;
  for (const p of Object.values(table || {})) n += Object.keys(p.models || {}).length;
  return n;
}

function fmtM(n) {
  return (n / 1e6).toFixed(2) + "M";
}

// Redact the password from a DSN for display.
//
// Must NOT use a lazy /[^@]+@/ for the password: a password containing '@'
// (legal, and common in generated passwords) would end the match early and
// print the remainder of the secret verbatim. The host separator is the LAST
// '@' in the string, so anchor on that.
function redactDsn(dsn) {
  const s = String(dsn);
  const schemeEnd = s.indexOf("://");
  const at = s.lastIndexOf("@");
  if (schemeEnd === -1 || at === -1 || at < schemeEnd) return s;

  const userinfo = s.slice(schemeEnd + 3, at);
  const colon = userinfo.indexOf(":");
  if (colon === -1) return s; // no password present

  return `${s.slice(0, schemeEnd + 3)}${userinfo.slice(0, colon)}:***${s.slice(at)}`;
}
