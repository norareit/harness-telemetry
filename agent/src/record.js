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
  "project",
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
