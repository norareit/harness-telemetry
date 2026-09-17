// Valuation policy — what an event's stored cost, billing and rate card SHOULD
// be, both at ingest (plans/004 freeze) and when deliberately re-valued
// (`harness-usage reprice`). This is the one place that decides "has the
// valuation changed"; the store (local-store.js) only reads and writes rows,
// and the CLI (cli.js) only formats. Both decisions were previously inline in
// sync.js and cli.js, next to I/O and console.log, and untested — review
// finding C2 lived there.

import { eventKey, DERIVED_FIELDS } from "./record.js";

// Everything a valuation actually depends on. Deliberately NOT the whole source
// record: project, branch and sidechain can change without affecting cost, and
// re-pricing on those would reopen the freeze hole from the other side.
export const PRICING_INPUT_FIELDS = [
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
];

/** Would pricing these two records produce the same answer? */
export function samePricingInputs(a, b) {
  if (str(a.provider) !== str(b.provider)) return false;
  if (str(a.model) !== str(b.model)) return false;
  for (const k of PRICING_INPUT_FIELDS) {
    if ((Number(a[k]) || 0) !== (Number(b[k]) || 0)) return false;
  }
  return true;
}

// Matches makeEvent's normalization, so a raw extractor value and a stored one
// compare equal: both '' and undefined mean "absent", i.e. null.
function str(v) {
  return v ? String(v) : null;
}

/**
 * Ingest valuation (plans/004): reuse the stored valuation when the pricing
 * inputs are unchanged, otherwise price now. Returns { priced, frozen }.
 *
 * This is what actually ENFORCES the freeze. Pricing happens in the extraction
 * loop, which runs over every row a source yields — and `backfill` yields all
 * of them. Without this reuse a backfill silently re-values the entire history
 * at today's rates, which is exactly what the freeze exists to prevent; storing
 * the applied rates does not help, because the upsert overwrites them alongside
 * cost_usd. Before this existed the freeze held only as an accident of cursors
 * being incremental.
 *
 * The freeze is CONDITIONAL on the pricing inputs being unchanged. OpenCode
 * deliberately re-reads its `>=` watermark boundary so edited or streamed
 * messages can self-correct their token counts; if that happens, the stored
 * cost no longer follows from the stored tokens, and keeping it would make
 * usage_cost_audit report drift forever. Changed inputs therefore re-price
 * honestly, with a new priced_at.
 *
 * A pre-freeze row (priced_at NULL) is reused AS IS, null included: that null
 * means "valued before the freeze, date unknown", and stamping it with now()
 * would assert a valuation date that never happened.
 *
 * Note `billing` is frozen too, since it is part of the valuation. Changing a
 * source's billing in config.json therefore needs an explicit `reprice`.
 */
export function valueAtIngest({ store, pricing, raw, billing }) {
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

  const prev = store.storedEvent(eventKey(raw));
  if (prev && samePricingInputs(prev, inputs)) {
    // DERIVED_FIELDS is precisely the valuation: cost, billing, priced_by, the
    // applied rate card, and priced_at.
    const frozen = {};
    for (const k of DERIVED_FIELDS) frozen[k] = prev[k];
    return { priced: frozen, frozen: true };
  }

  return { priced: pricing.price(inputs, billing), frozen: false };
}

/**
 * Would storing `next` in place of `prev` change the valuation? Compares every
 * DERIVED_FIELD except priced_at (which is set fresh on every reprice and so
 * always "moves"): numbers to 1e-9, null !== 0, strings by equality.
 *
 * An earlier version looked only at cost_usd and priced_by, so a billing change
 * was never re-applied (review finding C2) and a pre-plan-003 row with null
 * rates but an unchanged price could never be healed — and under the freeze a
 * backfill won't heal it either (C3), which is why reprice is the documented
 * repair path. null and 0 are kept distinct: "unknown rate" must not read as
 * "free".
 */
export function valuationChanged(prev, next) {
  for (const f of DERIVED_FIELDS) {
    if (f === "priced_at") continue;
    const a = prev[f];
    const b = next[f];
    if ((a == null) !== (b == null)) return true;
    if (a == null) continue; // both null → equal
    if (typeof a === "number" || typeof b === "number") {
      if (Math.abs(Number(a) - Number(b)) > 1e-9) return true;
    } else if (a !== b) {
      return true;
    }
  }
  return false;
}

/**
 * Plan a deliberate re-valuation (`harness-usage reprice`). Reads the store,
 * prices every in-scope event at today's rates, and returns what WOULD change
 * without writing anything.
 *
 *   scope: { model?: 'provider/model', unpricedOnly?: boolean }
 *   → { examined, updates: [{ ev, priced }], deltaUsd }
 */
export function planRevaluation({ store, pricing, config, scope = {} }) {
  let examined = 0;
  const updates = [];
  for (const ev of store.allEvents()) {
    if (scope.model && `${ev.provider}/${ev.model}` !== scope.model) continue;
    if (scope.unpricedOnly && ev.priced_by !== "none") continue;
    examined++;

    const srcCfg = config.sources[ev.harness];
    const priced = pricing.price(ev, srcCfg?.billing || "free");
    if (valuationChanged(ev, priced)) updates.push({ ev, priced });
  }
  const deltaUsd = updates.reduce(
    (s, u) => s + (u.priced.cost_usd || 0) - (u.ev.cost_usd || 0),
    0,
  );
  return { examined, updates, deltaUsd };
}

/** Apply a revaluation plan in one transaction. Returns the rows written. */
export function applyRevaluation({ store, updates }) {
  store.transaction(() => {
    for (const { ev, priced } of updates) store.record({ ...ev, ...priced });
  });
  return updates.length;
}
