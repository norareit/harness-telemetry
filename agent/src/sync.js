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
import { eventKey } from "./record.js";

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
    frozen: 0, // re-extracted events whose stored valuation was reused
    scenariosInvalidated: 0, // events whose tokens changed, dropping stale scenarios
    unpriced: new Set(),
    shipped: 0,
    unsynced: 0,
    shipError: null,
    scenarioRows: 0,
    shippedScenarios: 0,
    unsyncedScenarios: 0,
    unresolvedScenarios: [],
    prunedScenarios: [],
  };

  if (full) store.resetCursors();

  // Event keys whose pricing inputs changed on this run (an OpenCode boundary
  // row self-corrected, say). Their frozen scenario rows are now stale and must
  // be dropped before the scenario pass regenerates them — see below (C1).
  const invalidated = new Set();

  try {
    for (const [name, extract] of Object.entries(SOURCES)) {
      const srcCfg = config.sources[name];
      if (!srcCfg || srcCfg.enabled === false) continue;

      const billing = srcCfg.billing || "free";
      let count = 0;

      // One transaction around the whole extraction pass, cursors included.
      // record() is ~12.5ms per event unbatched because WAL fsyncs each implicit
      // transaction: a cold start cost 53.7s, of which only ~0.5s was actually
      // reading the sources. Cursors must be inside the same transaction — see
      // LocalStore.transactionAsync for why committing them separately could
      // permanently skip events.
      await store.transactionAsync(async () => {
        for await (const raw of extract({ store, config, full })) {
          const inputs = {
            provider: raw.provider,
            model: raw.model,
            input_tokens: raw.input_tokens,
            output_tokens: raw.output_tokens,
            reasoning_tokens: raw.reasoning_tokens,
            cache_read_tokens: raw.cache_read_tokens,
            cache_write_5m_tokens: raw.cache_write_5m_tokens,
            cache_write_1h_tokens: raw.cache_write_1h_tokens,
          };

          // plans/004: an event is valued ONCE. Re-extraction must reuse that
          // valuation rather than restamp it at today's rates — which matters
          // because re-extraction is routine, not exceptional: `backfill`
          // re-yields the entire history, and OpenCode re-yields its watermark
          // boundary row on every single run. Deliberate re-valuation is
          // `harness-usage reprice`, never a side effect of reading.
          const frozen = store.frozenValuation(eventKey(raw), inputs);
          const priced = frozen || pricing.price(inputs, billing);
          if (frozen) report.frozen++;

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
          // An EXISTING event that re-priced (frozen was null) means its pricing
          // inputs moved. Its scenario rows are keyed off the same event and are
          // now stale — mark for invalidation. A 'changed' with frozen set is a
          // non-pricing field (project, branch) moving, which scenarios ignore.
          if (state === "changed" && !frozen) invalidated.add(eventKey(raw));
          count++;
        }
      });
      report.extracted[name] = count;
    }

    // NOTE (plans/004): there is deliberately NO reprice pass here.
    //
    // Events are priced once, in the extraction loop above, and never
    // recomputed. Postgres is a ledger of what each request would have cost
    // WHEN IT HAPPENED. plans/003 repriced everything on every run, which meant
    // a vendor price change silently rewrote history — storing the rates did
    // not prevent that, because the upsert overwrites rate_* alongside cost_usd.
    //
    // "What would this cost at today's rates" is still answerable on demand via
    // `harness-usage compare`, without mutating anything. Deliberate correction
    // — a pricing bug, or a newly added override — is `harness-usage reprice`.

    // --- counterfactual scenarios (plans/002, frozen per plans/004) ---------
    // Derived, but frozen like events: a pair is priced once and kept. Only
    // pairs that do not exist yet are computed, so a sync with no new events
    // does no scenario work at all.
    //
    // A scenario added later CANNOT be priced historically — no archive of past
    // rate tables exists — so such rows carry a priced_at far after their event's
    // ts. That is the visible marker of a non-contemporaneous comparison.
    // Stale counterfactuals first: an event whose tokens changed keeps its
    // scenario rows frozen otherwise (existingScenarioPairs would skip them),
    // leaving the dashboard comparing a corrected actual against an uncorrected
    // alternative (C1). Dropping them here lets the incremental pass below
    // regenerate them with a fresh priced_at.
    if (invalidated.size) {
      report.scenariosInvalidated = store.dropScenariosFor([...invalidated]);
    }

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
        alreadyPriced: store.existingScenarioPairs(),
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
