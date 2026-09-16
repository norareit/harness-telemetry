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
  const pricing = await loadPricing({
    modelsJsonPath: config.pricing.modelsJson,
    overridesPath: config.pricing.overrides,
  });
  add(
    "price table",
    !pricing.meta.tableError,
    pricing.meta.tableError
      ? `failed to load ${pricing.meta.modelsPath}: ${pricing.meta.tableError.message}`
      : `${countModels(pricing.table)} models from ${pricing.meta.modelsPath}`,
  );

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
      const schema = await sink.schemaPresent();
      add("postgres connection", ok, redactDsn(config.postgres.dsn));
      add(
        "postgres schema",
        schema,
        schema ? "usage_event present" : "usage_event missing — run server/postgres/init/01-schema.sql",
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
