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

        const state = store.record({
          ...raw,
          device: config.device,
          cost_usd: priced.cost_usd,
          billing: priced.billing,
          priced_by: priced.priced_by,
        });
        report.recorded[state]++;
        count++;
      }
      report.extracted[name] = count;
    }

    // --- ship ------------------------------------------------------------
    const pending = store.unsynced();
    report.unsynced = pending.length;

    if (!noShip && pending.length && config.postgres.dsn) {
      let sink;
      try {
        sink = new PostgresSink(config);
        await sink.upsert(pending.map((p) => p.event));
        store.markSynced(pending.map((p) => p.pk));
        report.shipped = pending.length;
        report.unsynced = 0;
      } catch (err) {
        report.shipError = err.message;
      } finally {
        if (sink) await sink.close();
      }
    } else if (!noShip && pending.length && !config.postgres.dsn) {
      report.shipError = "postgres.dsn not configured — rows queued locally";
    }
  } finally {
    store.close();
  }

  report.unpriced = [...report.unpriced].sort();
  return report;
}
