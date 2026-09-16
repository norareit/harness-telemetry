// The pipeline: sources -> pricing -> local archive/outbox -> Postgres.
//
// The two halves are deliberately independent:
//   * Extraction + local archive ALWAYS runs, network or not. Given Claude Code
//     prunes transcripts after ~30 days, the JSONL archive is the only durable
//     history past that window.
//   * Shipping clears the `synced` flag only on a confirmed upsert. Offline, rows
//     just accumulate; the whole backlog drains on the next successful run. The
//     stable PK makes replays idempotent.

import { loadConfig } from "./config.js";
import { loadPricing } from "./pricing.js";
import { LocalStore } from "./local-store.js";
import { PostgresSink } from "./sink-postgres.js";
import { extractClaudeCode } from "./sources/claude-code.js";
import { extractOpenCode } from "./sources/opencode.js";
import { scenarioRows } from "./reprice.js";

const SOURCES = {
  "claude-code": extractClaudeCode,
  opencode: extractOpenCode,
};

/**
 * @param {object} opts
 * @param {boolean} opts.full   ignore cursors, re-scan everything (backfill)
 * @param {boolean} opts.noShip skip the Postgres upload (local archive only)
 */
export async function runSync({ full = false, noShip = false } = {}) {
  const config = await loadConfig();
  const pricing = await loadPricing({
    modelsJsonPath: config.pricing.modelsJson,
    overridesPath: config.pricing.overrides,
  });
  const store = new LocalStore();

  const report = {
    device: config.device,
    full,
    extracted: {},
    recorded: { new: 0, changed: 0, unchanged: 0 },
    unpriced: new Set(),
    shipped: 0,
    unsynced: 0,
    shipError: null,
    repriced: 0,
    scenarioRows: 0,
    shippedScenarios: 0,
    unsyncedScenarios: 0,
    unresolvedScenarios: [],
    prunedScenarios: [],
  };

  if (full) store.resetCursors();

  try {
    for (const [name, extract] of Object.entries(SOURCES)) {
      const srcCfg = config.sources[name];
      if (!srcCfg || srcCfg.enabled === false) continue;

      const billing = srcCfg.billing || "free";
      let count = 0;

      for await (const raw of extract({ store, config, full })) {
        const priced = pricing.price(
          {
            provider: raw.provider,
            model: raw.model,
            input_tokens: raw.input_tokens,
            output_tokens: raw.output_tokens,
            reasoning_tokens: raw.reasoning_tokens,
            cache_read_tokens: raw.cache_read_tokens,
            cache_write_5m_tokens: raw.cache_write_5m_tokens,
            cache_write_1h_tokens: raw.cache_write_1h_tokens,
          },
          billing,
        );
        if (priced.priced_by === "none" && priced.billing !== "local") {
          report.unpriced.add(`${raw.provider}/${raw.model}`);
        }

        // Spread the whole priced result: cost, billing, priced_by, and the
        // applied rate card (cache_model / tier_applied / rate_*). An earlier
        // version cherry-picked three fields and silently dropped the rest.
        const state = store.record({
          ...raw,
          device: config.device,
          ...priced,
        });
        report.recorded[state]++;
        count++;
      }
      report.extracted[name] = count;
    }

    // --- reprice stored events at current rates (plans/003) ----------------
    // `sync` is now "incremental extract + full reprice". Extraction still only
    // reads new bytes, but every stored event is re-costed so a models.json
    // update is actually picked up instead of freezing until the next backfill.
    // Storing the applied rates is what makes this safe: a reprice shows up in
    // the rate_* columns rather than silently moving historical totals.
    for (const ev of [...store.allEvents()]) {
      const srcCfg = config.sources[ev.harness];
      const priced = pricing.price(ev, srcCfg?.billing || "free");
      if (store.record({ ...ev, ...priced }) === "changed") report.repriced++;
    }

    // --- counterfactual scenarios (plans/002) ------------------------------
    // Derived, not extracted: a pure function of the stored events plus the
    // price table, so they are recomputed from the whole local archive rather
    // than only from what this run happened to extract. That way a changed
    // scenario list or an updated models.json converges on the next run.
    const scenarios = config.scenarios || [];
    if (scenarios.length) {
      const pruned = store.pruneScenarios(scenarios);
      if (pruned.length) report.prunedScenarios = pruned;

      const unresolved = scenarios.filter((s) => !pricing.resolveKey(s).card);
      report.unresolvedScenarios = unresolved;

      const rows = scenarioRows({
        events: store.allEvents(),
        pricing,
        scenarios: scenarios.filter((s) => !unresolved.includes(s)),
      });
      store.recordScenarios(rows);
      report.scenarioRows = rows.length;
    }

    // --- ship ------------------------------------------------------------
    const pending = store.unsynced();
    const pendingScenarios = store.unsyncedScenarios();
    report.unsynced = pending.length;
    report.unsyncedScenarios = pendingScenarios.length;

    const haveWork = pending.length || pendingScenarios.length;
    if (!noShip && haveWork && config.postgres.dsn) {
      let sink;
      try {
        sink = new PostgresSink(config);
        // Events first — scenario rows carry a foreign key onto them.
        if (pending.length) {
          await sink.upsert(pending.map((p) => p.event));
          store.markSynced(pending.map((p) => p.pk));
          report.shipped = pending.length;
          report.unsynced = 0;
        }
        if (pendingScenarios.length) {
          await sink.upsertScenarios(pendingScenarios.map((p) => p.row));
          store.markScenariosSynced(
            pendingScenarios.map(({ pk, scenario }) => ({ pk, scenario })),
          );
          report.shippedScenarios = pendingScenarios.length;
          report.unsyncedScenarios = 0;
        }
      } catch (err) {
        report.shipError = err.message;
      } finally {
        if (sink) await sink.close();
      }
    } else if (!noShip && haveWork && !config.postgres.dsn) {
      report.shipError = "postgres.dsn not configured — rows queued locally";
    }
  } finally {
    store.close();
  }

  report.unpriced = [...report.unpriced].sort();
  return report;
}
