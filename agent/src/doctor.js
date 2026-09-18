// `harness-usage doctor` — preflight and regression checks.
//
// Each check is a named function of a shared context. It returns { ok, detail },
// or null to mean "not applicable" (omitted from the output), or throws — a
// throw becomes { ok: false, detail: err.message } for THAT check only, so one
// failure can never take the rest down with it (commit 8c4d862).
//
// The checks that read a transcript or the OpenCode DB import the sources' own
// parsers (parseRecord / providerOf / listTranscripts / listModels) rather than
// re-implementing them — there is one definition of "which model is this", so
// doctor and extraction cannot disagree (review finding C7).

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, expandHome, CONFIG_PATH, DATA_DIR } from "./config.js";
import { LocalStore } from "./local-store.js";
import { loadPricing } from "./pricing.js";
import { PostgresSink } from "./sink-postgres.js";
import { reconcile, listModels } from "./sources/opencode.js";
import { parseRecord, providerOf, listTranscripts } from "./sources/claude-code.js";

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

// The check registry — order IS the output order. runDoctor() with no `only`
// produces the same array, in the same order, with the same names and details,
// as the flat function it replaced.
export const CHECKS = [
  { name: "config file", run: checkConfigFile },
  { name: "device name", run: checkDeviceName },
  { name: "data dir", run: checkDataDir },
  { name: "claude-code transcripts", run: checkClaudeCodeTranscripts },
  { name: "claude-code dedupe regression", run: checkClaudeCodeDedupe },
  { name: "opencode db", run: checkOpenCodeDb },
  { name: "opencode reconciliation", run: checkOpenCodeReconciliation },
  { name: "price table", run: checkPriceTable },
  { name: "reasoning tokens billed", run: checkReasoningBilled },
  { name: "scenarios resolve", run: checkScenariosResolve },
  { name: "cost reproducible from stored rates", run: checkCostReproducible },
  { name: "price table freshness", run: checkPriceTableFreshness },
  { name: "override drift", run: checkOverrideDrift },
  { name: "no unpriced billable events", run: checkNoUnpricedBillable },
  { name: "models priced", run: checkModelsPriced },
  { name: "postgres connection", run: checkPostgresConnection },
  { name: "postgres schema", run: checkPostgresSchema },
  { name: "last sync", run: checkLastSync },
  { name: "last ship", run: checkLastShip },
];

export const CHECK_NAMES = CHECKS.map((c) => c.name);

/**
 * Run the checks. `only` (array of names) restricts the run — the payoff of the
 * registry — but with no argument the result is byte-identical to before.
 *
 * Context is built once: config, the price table, and a single LocalStore that
 * the store-reading checks share (previously two were opened and closed inside
 * blocks). The Postgres pair shares one sink via ctx.
 */
export async function runDoctor({ only = null } = {}) {
  const config = await loadConfig();
  // Loaded up front: the reasoning probe prices thinking tokens with it.
  const pricing = await loadPricing({
    modelsJsonPath: config.pricing.modelsJson,
    overridesPath: config.pricing.overrides,
  });
  const store = new LocalStore();

  // Two expensive things are each done at most once, on demand, and shared by
  // whichever checks need them — memoised on the context rather than passed
  // between checks through mutable fields. That side channel (a check stashing
  // state for a later one) made `doctor --only "postgres schema"` a no-op when
  // run alone, in a registry whose whole point is checks that stand on their
  // own (review finding C1).
  let pgSink = null;
  const ctx = {
    config,
    pricing,
    store,
    ccEnabled: config.sources["claude-code"]?.enabled !== false,
    ccRoot: expandHome(config.sources["claude-code"].root),
    ocEnabled: config.sources.opencode?.enabled !== false,
    ocDb: expandHome(config.sources.opencode.db),

    // One walk of the transcripts, yielding both the dedupe totals and the set
    // of models in use — the dedupe and models-priced checks used to walk and
    // fully parse every line separately (review finding C3).
    ccScan() {
      this._ccScan ??= scanTranscripts(this.ccRoot);
      return this._ccScan;
    },

    // One Postgres connection, pinged and schema-checked once; the connection
    // and schema checks both await it. The sink is closed in runDoctor's finally.
    postgres() {
      this._pg ??= (async () => {
        pgSink = new PostgresSink(this.config);
        const ok = await pgSink.ping();
        const gaps = await pgSink.schemaGaps();
        return { ok, gaps };
      })();
      return this._pg;
    },
  };

  const checks = [];
  try {
    for (const { name, run } of CHECKS) {
      if (only && !only.includes(name)) continue;
      let result;
      try {
        result = await run(ctx);
      } catch (err) {
        result = { ok: false, detail: err.message };
      }
      if (result == null) continue; // not applicable — omit
      checks.push({ name, ok: result.ok, detail: result.detail });
    }
  } finally {
    if (pgSink) await pgSink.close();
    store.close();
  }
  return checks;
}

// --- checks ----------------------------------------------------------------

function checkConfigFile(ctx) {
  return {
    ok: Boolean(ctx.config._path),
    detail: ctx.config._path
      ? ctx.config._path
      : `not found at ${CONFIG_PATH} — running on defaults (no DSN)`,
  };
}

function checkDeviceName(ctx) {
  return { ok: true, detail: ctx.config.device };
}

function checkDataDir() {
  return { ok: true, detail: DATA_DIR };
}

async function checkClaudeCodeTranscripts(ctx) {
  if (!ctx.ccEnabled) return null;
  if (!existsSync(ctx.ccRoot)) return { ok: false, detail: `path not found: ${ctx.ccRoot}` };
  const files = await listTranscripts(ctx.ccRoot);
  return { ok: files.length > 0, detail: `${files.length} files at ${ctx.ccRoot}` };
}

async function checkClaudeCodeDedupe(ctx) {
  if (!ctx.ccEnabled || !existsSync(ctx.ccRoot)) return null;
  const { totals } = await ctx.ccScan();
  const outRatio = totals.output ? totals.naiveOutput / totals.output : 1;
  const ccRatio = totals.cacheCreation
    ? totals.naiveCacheCreation / totals.cacheCreation
    : 1;
  const ok =
    outRatio >= CC_BASELINE.minRatio &&
    ccRatio >= CC_BASELINE.minRatio &&
    totals.usageConflicts === 0;
  return {
    ok,
    detail:
      `deduped output=${fmtM(totals.output)} vs naive ${fmtM(totals.naiveOutput)} (${outRatio.toFixed(2)}x), ` +
      `cache-creation=${fmtM(totals.cacheCreation)} vs naive ${fmtM(totals.naiveCacheCreation)} (${ccRatio.toFixed(2)}x); ` +
      `need >=${CC_BASELINE.minRatio}x. ` +
      `ref ${CC_BASELINE.measuredOn}: output≈${fmtM(CC_BASELINE.dedupedOutputTokens)}, cache≈${fmtM(CC_BASELINE.dedupedCacheCreation)}. ` +
      `${totals.multiUsageRequests}/${totals.uniqueRequests} requestIds repeat usage; ` +
      `${totals.usageConflicts} usage conflicts (must be 0)`,
  };
}

function checkOpenCodeDb(ctx) {
  if (!ctx.ocEnabled) return null;
  if (!existsSync(ctx.ocDb)) return { ok: false, detail: `path not found: ${ctx.ocDb}` };
  try {
    const db = new DatabaseSync(ctx.ocDb, { readOnly: true });
    const msgs = db.prepare("SELECT COUNT(*) c FROM message").get().c;
    const sess = db.prepare("SELECT COUNT(*) c FROM session").get().c;
    db.close();
    return { ok: true, detail: `${msgs} messages / ${sess} sessions at ${ctx.ocDb}` };
  } catch (err) {
    return { ok: false, detail: `cannot read ${ctx.ocDb}: ${err.message}` };
  }
}

function checkOpenCodeReconciliation(ctx) {
  if (!ctx.ocEnabled || !existsSync(ctx.ocDb)) return null;
  const rec = reconcile(ctx.ocDb);
  return {
    ok: rec.ok === rec.total,
    detail:
      `${rec.ok}/${rec.total} sessions reconcile per-message sums vs rollup columns` +
      (rec.mismatches.length
        ? ` — first mismatch: ${JSON.stringify(rec.mismatches[0])}`
        : ""),
  };
}

function checkPriceTable(ctx) {
  return {
    ok: !ctx.pricing.meta.tableError,
    detail: ctx.pricing.meta.tableError
      ? `failed to load ${ctx.pricing.meta.modelsPath}: ${ctx.pricing.meta.tableError.message}`
      : `${countModels(ctx.pricing.table)} models from ${ctx.pricing.meta.modelsPath}`,
  };
}

// Regression guard for the bug where extraction normalized reasoning OUT of
// output_tokens while pricing still assumed it was IN, billing Anthropic
// thinking tokens at $0. A unit probe so it cannot drift with the dataset.
function checkReasoningBilled(ctx) {
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
  // A stale price table has no anthropic/claude-opus-5 entry; reading .card.base
  // off that miss must fail THIS check and nothing else.
  const probeCard = ctx.pricing.resolve("anthropic", "claude-opus-5").card;
  if (!probeCard) {
    return {
      ok: false,
      detail:
        `cannot run: no rate card for anthropic/claude-opus-5 in ${ctx.pricing.meta.modelsPath} — ` +
        `the table is refreshed by OpenCode, so a copy older than the model predates it. ` +
        `Refresh it, or pin the model in pricing-overrides.json`,
    };
  }
  const probeCost = ctx.pricing.price(probe, "free").cost_usd;
  const expectedProbe = probeCard.base.output;
  return {
    ok: Math.abs(probeCost - expectedProbe) < 1e-6,
    detail:
      `1M reasoning tokens on claude-opus-5 = $${probeCost} (must be $${expectedProbe}; ` +
      `$0 means the reasoning-exclusion regression is back)`,
  };
}

function checkScenariosResolve(ctx) {
  const scenarios = ctx.config.scenarios || [];
  if (!scenarios.length) return null;
  const unresolved = scenarios.filter((s) => !ctx.pricing.resolveKey(s).card);
  return {
    ok: unresolved.length === 0,
    detail: unresolved.length
      ? `no rate card for: ${unresolved.join(", ")}`
      : scenarios.map((s) => `${s} [${ctx.pricing.cacheModelOf(s)}]`).join(", "),
  };
}

// Cost must be reproducible from the stored inputs alone (plans/003): recompute
// from the persisted rates and compare. The one invariant that does not require
// trusting the pricing code path that produced the number.
function checkCostReproducible(ctx) {
  let total = 0;
  let checked = 0;
  let bad = 0;
  let unrated = 0;
  let firstBad = null;
  for (const e of ctx.store.allEvents()) {
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
  return {
    ok: bad === 0,
    detail:
      total === 0
        ? "no events stored yet"
        : `${checked}/${total} events carry rates; ${bad} mismatch` +
          (firstBad ? ` — e.g. ${firstBad}` : "") +
          (unrated ? `; ${unrated} have no rate card (local/unpriced — expected)` : "") +
          (total - checked - unrated > 0
            ? `; ${total - checked - unrated} priced but missing rates — run 'harness-usage reprice --model <provider/model>' (a backfill reuses the frozen nulls)`
            : ""),
  };
}

// Under the freeze a stale table is PERMANENT damage: every event ingested while
// it is stale is valued wrongly forever. models.json is maintained by OpenCode.
async function checkPriceTableFreshness(ctx) {
  const modelsPath = expandHome(ctx.config.pricing.modelsJson);
  const st = await stat(modelsPath);
  const days = (Date.now() - st.mtimeMs) / 86_400_000;
  return {
    ok: days <= 14,
    detail:
      `${modelsPath} last updated ${days.toFixed(1)} days ago` +
      (days > 14
        ? " — run OpenCode to refresh it; with prices frozen at ingest, stale rates are baked in permanently"
        : ""),
  };
}

function checkOverrideDrift(ctx) {
  const { pins, checked, drift, unverifiable } = overrideDrift(ctx.pricing);
  // A pin the table cannot confirm is NOT a pass — it is exactly the one plan
  // 004 named as apt to "silently rot" (the Vercel-sourced terra-fast rate,
  // whose only table entry lives under a different provider). Report it rather
  // than count it as verified (review finding C4).
  const note = unverifiable.length
    ? ` — ${unverifiable.length} unverifiable, no table entry to check against: ${unverifiable.join(", ")}`
    : "";
  return {
    ok: drift.length === 0,
    detail: drift.length
      ? `${drift.join("; ")} — update pricing-overrides.json if the table is now right${note}`
      : `${checked}/${pins} pin(s) checked against the table, none diverging${note}`,
  };
}

// Frozen costs do not self-heal, so an event stored with no rate card stays at
// $0 until someone runs `reprice`. Local models are legitimately unpriced.
function checkNoUnpricedBillable(ctx) {
  const byModel = new Map();
  for (const e of ctx.store.allEvents()) {
    if (e.priced_by !== "none") continue;
    if (e.billing === "local") continue;
    const k = `${e.provider}/${e.model}`;
    byModel.set(k, (byModel.get(k) || 0) + 1);
  }
  const total = [...byModel.values()].reduce((a, b) => a + b, 0);
  return {
    ok: byModel.size === 0,
    detail:
      byModel.size === 0
        ? "every non-local event carries a rate card"
        : `${total} events with no rate card: ` +
          [...byModel].map(([k, n]) => `${k} (${n})`).join(", ") +
          ` — add to pricing-overrides.json, then 'harness-usage reprice --unpriced-only'`,
  };
}

async function checkModelsPriced(ctx) {
  const seenPairs = [];
  if (ctx.ccEnabled && existsSync(ctx.ccRoot)) {
    const { models } = await ctx.ccScan();
    for (const m of models) seenPairs.push([providerOf(m), m]);
  }
  if (ctx.ocEnabled && existsSync(ctx.ocDb)) {
    for (const pair of listModels(ctx.ocDb)) seenPairs.push(pair);
  }
  const unpriced = ctx.pricing.unpricedModels(seenPairs);
  return {
    ok: unpriced.length === 0,
    detail: unpriced.length
      ? `no price entry for: ${unpriced.join(", ")} — add to pricing-overrides.json`
      : `all ${seenPairs.length} provider/model pairs in use resolve to a rate card`,
  };
}

async function checkPostgresConnection(ctx) {
  if (!ctx.config.postgres.dsn) return { ok: false, detail: "postgres.dsn not configured" };
  try {
    const { ok } = await ctx.postgres();
    return { ok, detail: redactDsn(ctx.config.postgres.dsn) };
  } catch (err) {
    return { ok: false, detail: `${redactDsn(ctx.config.postgres.dsn)}: ${err.message}` };
  }
}

async function checkPostgresSchema(ctx) {
  // Unconfigured, or the connection failed: reported on the connection check
  // alone, as before. Otherwise this makes its OWN connection when run in
  // isolation — it no longer depends on the connection check having run first
  // (review finding C1).
  if (!ctx.config.postgres.dsn) return null;
  let pg;
  try {
    pg = await ctx.postgres();
  } catch {
    return null;
  }
  const { missingTables, missingColumns } = pg.gaps;
  const gaps = [];
  if (missingTables.length) gaps.push(`tables: ${missingTables.join(", ")}`);
  if (missingColumns.length) {
    gaps.push(`columns: ${missingColumns.map((m) => `${m.table}.${m.column}`).join(", ")}`);
  }
  return {
    ok: gaps.length === 0,
    detail:
      gaps.length === 0
        ? "usage_event, usage_scenario complete"
        : `missing ${gaps.join("; ")} — postgres/init only runs on an empty volume, ` +
          `so apply server/postgres/migrations/ to an existing database ` +
          `(psql -f). Do NOT 'down -v' unless you mean to destroy stored history.`,
  };
}

// Liveness (plans/007). Two clocks stamped by runSync in kv: `sync:last_run`
// (extraction ran to the end, written even on --no-ship) and `sync:last_ship_ok`
// (a clean ship, nothing left queued). These are the ONLY signals that catch a
// dead timer — the outbox, Postgres and every other check froze at the last
// good run on 2026-09-17 and all looked healthy while nothing had run for 13h.
function checkLastSync(ctx) {
  return stalenessCheck(ctx, "sync:last_run", "run 'harness-usage sync'");
}

// Skipped (not applicable) when no DSN is configured: a --no-ship-only setup
// never ships, so there is no last-ship to be stale.
function checkLastShip(ctx) {
  if (!ctx.config.postgres.dsn) return null;
  return stalenessCheck(ctx, "sync:last_ship_ok", "run 'harness-usage sync'");
}

function stalenessCheck(ctx, key, absentHint) {
  const raw = ctx.store.getKV(key);
  if (raw == null) return { ok: false, detail: `never recorded — ${absentHint}` };

  const threshold = ctx.config.sync?.staleAfterMinutes ?? 60;
  const ageMin = (Date.now() / 1000 - Number(raw)) / 60;
  const when = new Date(Number(raw) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const age =
    ageMin < 60 ? `${Math.round(ageMin)} min ago` : `${(ageMin / 60).toFixed(1)} h ago`;
  if (ageMin <= threshold) return { ok: true, detail: `${age} (${when})` };
  return {
    ok: false,
    detail: `${age} (${when}) — exceeds sync.staleAfterMinutes=${threshold}; ${livenessHint()}`,
  };
}

// Where to look when the agent has stopped running — the two places that
// actually carry the failure, per platform.
function livenessHint() {
  return process.platform === "darwin"
    ? "check 'launchctl print gui/$(id -u)/com.ritenoar.harness-usage' and ~/Library/Logs/harness-usage.log"
    : "check 'systemctl --user status harness-usage.timer' / 'journalctl --user -u harness-usage'";
}

// --- helpers -------------------------------------------------------------

// One walk of the transcripts producing everything the checks need: the dedupe
// totals AND the set of models in use. Previously these were two functions that
// each read and fully parsed every line (review finding C3).
async function scanTranscripts(root) {
  const seen = new Map(); // dedupeKey -> { sig, count }
  const usageByReq = new Map();
  const models = new Set();
  let naiveOutput = 0;
  let naiveCacheCreation = 0;
  let usageConflicts = 0;

  for (const file of await listTranscripts(root)) {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const rec = parseRecord(line);
      if (!rec) continue;
      models.add(rec.model);

      const u = rec.usage;
      naiveOutput += u.output_tokens || 0;
      naiveCacheCreation += u.cache_creation_input_tokens || 0;

      const key = rec.dedupeKey;
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
    totals: {
      output,
      cacheCreation,
      naiveOutput,
      naiveCacheCreation,
      uniqueRequests: usageByReq.size,
      multiUsageRequests,
      usageConflicts,
    },
    models,
  };
}

function countModels(table) {
  let n = 0;
  for (const p of Object.values(table || {})) n += Object.keys(p.models || {}).length;
  return n;
}

function fmtM(n) {
  return (n / 1e6).toFixed(2) + "M";
}

/**
 * Compare each pinned override against the live table, and split the result:
 * `drift` are pins whose rates now diverge from the table (fix the pin);
 * `unverifiable` are pins the table has no entry for, so rot cannot be detected
 * — reported, never silently skipped (review finding C4). A pin deliberately
 * does not track the table; the point is to notice when it should.
 */
export function overrideDrift(pricing) {
  const drift = [];
  const unverifiable = [];
  const pins = Object.entries(pricing.overrides || {});
  for (const [key, ov] of pins) {
    const live = pricing.tableCard(key);
    if (!live) {
      unverifiable.push(key);
      continue;
    }
    for (const f of ["input", "output", "cache_read", "cache_write"]) {
      const pinned = ov[f];
      const table = live.base[f];
      if (pinned != null && table != null && Math.abs(pinned - table) > 1e-9) {
        drift.push(`${key} ${f}: pinned ${pinned} vs table ${table}`);
      }
    }
  }
  return { pins: pins.length, checked: pins.length - unverifiable.length, drift, unverifiable };
}

// Redact the password from a DSN for display.
//
// Must NOT use a lazy /[^@]+@/ for the password: a password containing '@'
// (legal, and common in generated passwords) would end the match early and
// print the remainder of the secret verbatim. The host separator is the LAST
// '@' in the string, so anchor on that.
export function redactDsn(dsn) {
  const s = String(dsn);
  const schemeEnd = s.indexOf("://");
  const at = s.lastIndexOf("@");
  if (schemeEnd === -1 || at === -1 || at < schemeEnd) return s;

  const userinfo = s.slice(schemeEnd + 3, at);
  const colon = userinfo.indexOf(":");
  if (colon === -1) return s; // no password present

  return `${s.slice(0, schemeEnd + 3)}${userinfo.slice(0, colon)}:***${s.slice(at)}`;
}
