// Counterfactual repricing — "what would this token stream have cost elsewhere?"
//
// Every function here is a pure fold over events that are already stored. No
// re-extraction, no network. The pricing rules live solely in pricing.js; this
// module only groups and totals.
//
// The one thing callers must not lose along the way is `cache_model`. A target
// with no prompt caching bills cache-read tokens at its full input rate, and on
// a cache-heavy workload that dominates the comparison far more than the
// headline per-token rate does. A scenario that looks 10x cheaper because its
// caching support was ignored is the exact failure this module exists to avoid.

const GROUPS = {
  project: (e) => e.project || "(unknown)",
  model: (e) => `${e.provider || "?"}/${e.model || "?"}`,
  agent: (e) => e.agent || "(none)",
  day: (e) => e.ts.slice(0, 10),
  harness: (e) => e.harness,
  device: (e) => e.device,
};

export const GROUP_KEYS = Object.keys(GROUPS);

/**
 * Reprice a set of events against one or more scenarios.
 *
 * @param {object}   opts
 * @param {Iterable} opts.events     canonical UsageEvents
 * @param {Pricing}  opts.pricing
 * @param {string[]} opts.scenarios  fully-qualified '<provider>/<model>' keys
 * @param {string}   [opts.groupBy]  one of GROUP_KEYS; omit for totals only
 * @param {function} [opts.filter]   predicate on the event
 * @returns {{ rows, totals, meta }}
 */
export function compare({ events, pricing, scenarios, groupBy = null, filter = null }) {
  const keyOf = groupBy ? GROUPS[groupBy] : () => "(all)";
  if (groupBy && !keyOf) {
    throw new Error(`unknown --group ${groupBy}; expected one of ${GROUP_KEYS.join(", ")}`);
  }

  // Resolve each scenario once — a target with no rate card is reported as
  // unresolved rather than silently contributing $0 to every group.
  const meta = scenarios.map((s) => {
    const { card, source } = pricing.resolveKey(s);
    return {
      scenario: s,
      resolved: Boolean(card),
      priced_by: source || "none",
      cache_model: card ? pricing.cacheModelOf(s) : null,
    };
  });
  const usable = meta.filter((m) => m.resolved).map((m) => m.scenario);

  const groups = new Map();
  const totals = blankRow("(total)", usable);

  for (const ev of events) {
    if (filter && !filter(ev)) continue;

    const k = keyOf(ev);
    let row = groups.get(k);
    if (!row) {
      row = blankRow(k, usable);
      groups.set(k, row);
    }

    const tokens = billableTokens(ev);
    row.responses++;
    row.tokens += tokens;
    row.actual_cost_usd += ev.cost_usd || 0;
    totals.responses++;
    totals.tokens += tokens;
    totals.actual_cost_usd += ev.cost_usd || 0;

    for (const s of usable) {
      const r = pricing.repriceEvent(ev, s);
      row.scenarios[s].cost_usd += r.cost_usd;
      row.scenarios[s].cache_model = r.cache_model;
      totals.scenarios[s].cost_usd += r.cost_usd;
      totals.scenarios[s].cache_model = r.cache_model;
    }
  }

  const rows = [...groups.values()].sort((a, b) => b.actual_cost_usd - a.actual_cost_usd);
  for (const r of [...rows, totals]) round(r, usable);

  return { rows, totals, meta };
}

/**
 * Flatten events x scenarios into per-event rows for the `usage_scenario`
 * table. Unresolved targets are skipped entirely — an unpriced scenario must
 * never land in the database looking like a free one.
 */
export function scenarioRows({ events, pricing, scenarios }) {
  const out = [];
  for (const ev of events) {
    for (const s of scenarios) {
      const r = pricing.repriceEvent(ev, s);
      if (r.priced_by === "none") continue;
      out.push({
        harness: ev.harness,
        session_id: ev.session_id,
        message_id: ev.message_id,
        scenario: s,
        cost_usd: r.cost_usd,
        cache_model: r.cache_model,
        priced_by: r.priced_by,
        tier_applied: r.tier_applied,
        rate_input: r.rate_input,
        rate_output: r.rate_output,
        rate_cache_read: r.rate_cache_read,
        rate_cache_write_5m: r.rate_cache_write_5m,
        rate_cache_write_1h: r.rate_cache_write_1h,
      });
    }
  }
  return out;
}

function billableTokens(e) {
  return (
    e.input_tokens +
    e.output_tokens +
    e.reasoning_tokens +
    e.cache_read_tokens +
    e.cache_write_5m_tokens +
    e.cache_write_1h_tokens
  );
}

function blankRow(key, scenarios) {
  const row = { key, responses: 0, tokens: 0, actual_cost_usd: 0, scenarios: {} };
  for (const s of scenarios) row.scenarios[s] = { cost_usd: 0, cache_model: null };
  return row;
}

function round(row, scenarios) {
  row.actual_cost_usd = r4(row.actual_cost_usd);
  for (const s of scenarios) row.scenarios[s].cost_usd = r4(row.scenarios[s].cost_usd);
}

function r4(n) {
  return Math.round(n * 1e4) / 1e4;
}
