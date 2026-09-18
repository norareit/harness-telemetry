// Canonical UsageEvent — one object per LLM API response, identical shape
// regardless of which harness it came from. This is what gets written to the
// local JSONL archive and upserted to Postgres.
//
// Primary key is (harness, session_id, message_id). For Claude Code, message_id
// is the API requestId (see sources/claude-code.js for why that is the dedupe
// key). For OpenCode it is the message row id.

const FIELD_ORDER = [
  "harness",
  "device",
  "session_id",
  "message_id",
  "ts", // ISO 8601 string, UTC
  "provider",
  "model",
  "agent",
  "project", // repository root when one is detectable, else the working directory (plans/008)
  "git_branch",
  "is_sidechain",
  "input_tokens",
  "output_tokens", // EXCLUDES reasoning/thinking tokens for every harness (normalized at extraction)
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "cost_usd",
  "billing", // 'api' | 'local' | 'free'
  "priced_by", // 'table' | 'override' | 'none'
  // The rate card actually applied (plans/003), so cost_usd is reproducible
  // from stored data alone. These are post-tier, post-fallback values — see
  // computeCost in pricing.js — and USD per 1e6 tokens like everywhere else.
  "cache_model", // 'full' | 'read-only' | 'none'
  "tier_applied", // context-tier size in effect, or null
  "rate_input",
  "rate_output",
  "rate_cache_read",
  "rate_cache_write_5m",
  "rate_cache_write_1h",
  // When the rates above were captured (plans/004). For an event priced at
  // ingest this is ~= ts. For a scenario added later it is visibly much later,
  // which is the signal that the counterfactual did NOT use contemporaneous
  // rates — there is no archive of past rate tables to price it against.
  "priced_at",
];

// Fields DERIVED from the source data plus the price table, as opposed to
// extracted from the harness. Everything here is recomputable and none of it is
// load-bearing for durability, which is why the JSONL archive does not re-append
// a line when only these change — see local-store.js.
export const DERIVED_FIELDS = new Set([
  "cost_usd",
  "billing",
  "priced_by",
  "cache_model",
  "tier_applied",
  "rate_input",
  "rate_output",
  "rate_cache_read",
  "rate_cache_write_5m",
  "rate_cache_write_1h",
  "priced_at",
]);

// Nullable numerics: null means "not known", which is NOT the same as 0 and
// must not be coerced to it.
const RATE_FIELDS = [
  "tier_applied",
  "rate_input",
  "rate_output",
  "rate_cache_read",
  "rate_cache_write_5m",
  "rate_cache_write_1h",
];

const INT_FIELDS = [
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
];

/**
 * Build a fully-populated UsageEvent from a partial one, coercing types and
 * filling defaults. Pricing fields (cost_usd/billing/priced_by) are expected to
 * be set already by pricing.js; they default to the "unpriced" state.
 */
export function makeEvent(partial) {
  const e = {};
  for (const k of FIELD_ORDER) e[k] = partial[k];

  e.harness = String(e.harness);
  e.device = String(e.device);
  e.session_id = String(e.session_id);
  e.message_id = String(e.message_id);
  e.ts = toIso(e.ts);
  e.provider = e.provider ? String(e.provider) : null;
  e.model = e.model ? String(e.model) : null;
  e.agent = e.agent ? String(e.agent) : null;
  e.project = e.project ? String(e.project) : null;
  e.git_branch = e.git_branch ? String(e.git_branch) : null;
  e.is_sidechain = Boolean(e.is_sidechain);

  for (const k of INT_FIELDS) e[k] = int(e[k]);

  e.cost_usd = Number.isFinite(e.cost_usd) ? e.cost_usd : 0;
  e.billing = e.billing ?? "free";
  e.priced_by = e.priced_by ?? "none";

  e.cache_model = e.cache_model ?? null;
  for (const k of RATE_FIELDS) e[k] = Number.isFinite(e[k]) ? e[k] : null;

  // null means "valued before plans/004 existed, date unknown". Never defaulted
  // to now() — that would assert a valuation date we do not actually know.
  e.priced_at = e.priced_at ? toIso(e.priced_at) : null;

  return e;
}

/** Stable primary key string for the local outbox. */
export function eventKey(e) {
  return `${e.harness}${e.session_id}${e.message_id}`;
}

/** YYYY-MM-DD (UTC) of the event timestamp — the archive shard it belongs in. */
export function eventDay(e) {
  return e.ts.slice(0, 10);
}

export function totalTokens(e) {
  return (
    e.input_tokens +
    e.output_tokens +
    e.reasoning_tokens +
    e.cache_read_tokens +
    e.cache_write_5m_tokens +
    e.cache_write_1h_tokens
  );
}

function int(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toIso(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return new Date(v).toISOString();
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  throw new Error(`record: cannot parse timestamp ${JSON.stringify(v)}`);
}

export { FIELD_ORDER };
