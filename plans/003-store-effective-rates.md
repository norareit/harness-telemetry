# Plan 003 — Store the effective rates, so costs are reproducible

Status: **implemented 2026-09-16** (commit e5827b8).
Builds on `plans/001` (pipeline) and `plans/002` (counterfactual repricing), both implemented.
State as of 2026-09-16: 4,177 events + 29,239 scenario rows live in Postgres on `rpi5`.

## Context

Cost is computed entirely on each device, in JS, before anything reaches Postgres
(`agent/src/sync.js:64` for actual cost, `agent/src/reprice.js:76,99` for counterfactuals).
The database only ever `SUM()`s a finished `cost_usd` column — there is no rate arithmetic
anywhere in `01-schema.sql`, by design, so the pricing rules live in exactly one place.

The problem is what that leaves behind. **The rates themselves are never stored.** The
schema keeps breadcrumbs *about* the rate card — `priced_by` (table vs override),
`cache_model` and `tier_applied` on scenarios — but not the numbers. Those exist only in
`~/.cache/opencode/models.json` on whichever device did the arithmetic, at that moment,
and that file auto-updates.

Three consequences:

- **Historical costs are not auditable.** Given a row reading `$0.145313` you cannot
  reconstruct what produced it. You have the tokens and the total but not the multiplier.
- **Price changes are invisible.** If Opus pricing moves, old rows keep old costs and new
  rows get new costs with nothing marking the boundary. A cost-over-time chart shows a step
  that looks like a behaviour change but is a repricing.
- **It undercuts plan 001's own stated goal.** `pricing-overrides.json` exists to "pin rates
  so historical rows don't silently reprice", but pinning only covers models explicitly
  listed there. Everything priced from the live table has no record of what was applied.

This is also the root cause of the asymmetry noted at the end of plan 002: scenario costs
refresh on every sync (they are recomputed over `store.allEvents()`), while base `cost_usd`
freezes until a `backfill`. After a `models.json` update, `delta_usd` briefly compares a
fresh counterfactual against a stale actual.

## What the research established

Read directly from the shipped code, 2026-09-16.

### Five rates are applied, not four

`computeCost()` in `agent/src/pricing.js` derives five distinct effective rates, and the
fallbacks mean they differ from the raw card:

```js
const { rates, tierSize } = selectTier(card, ev.input_tokens + ev.cache_read_tokens);
const cacheReadRate  = rates.cache_read  ?? rates.input;   // no caching -> input rate
const cacheWriteRate = rates.cache_write ?? rates.input;   // read-only  -> input rate
const cacheWrite1hRate = targetProvider === "anthropic" && rates.cache_write != null
  ? rates.input * 2                                        // Anthropic-only rule
  : cacheWriteRate;
```

So what must be stored is the **post-tier, post-fallback applied** rate — not the card as
written. Storing the raw card would not let you reproduce the cost.

### `usage_event` is missing `cache_model` entirely

`Pricing.price()` returns `{cost_usd, billing, priced_by, cache_model}`, but `sync.js:70`
spreads only three of those into the record — `cache_model` is computed and thrown away.
`usage_event` therefore has no record of how caching was treated for the actual cost, even
though `usage_scenario` does. Same for `tier_applied`, which `price()` does not return at
all (`repriceEvent()` does).

That asymmetry is invisible today and becomes glaring the moment rates are stored.

### Migration is non-destructive

`ADD COLUMN ... DEFAULT NULL` rewrites nothing in PG 11+. The init script in
`postgres/init/` only runs on an empty volume, so an existing database needs the ALTERs
applied by hand — which is exactly the failure mode `doctor` already catches for missing
*tables* (`sink-postgres.js: missingTables`). Extending that check to columns keeps the
pattern.

`down -v` is no longer free: it would destroy 33K rows. They are rebuildable from the local
JSONL archive via `backfill`, but there is no reason to.

## Decision

**Reprice both actuals and scenarios on every sync**, resolving the plan-002 asymmetry in
favour of "what would this cost at today's rates". Storing the rates is what makes this safe
— a repricing becomes visible and diffable instead of silent. This changes `sync` semantics
from *incremental* to *incremental extract + full reprice*; state that plainly in the README.

(The alternative — freezing scenarios to match frozen actuals — preserves history but
answers a question nobody is asking, since the whole point is a forward-looking switching
decision.)

## Design

### Columns

Seven new columns on `usage_event`, five on `usage_scenario`:

```sql
ALTER TABLE usage_event
  ADD COLUMN IF NOT EXISTS rate_input           numeric(12,6),
  ADD COLUMN IF NOT EXISTS rate_output          numeric(12,6),
  ADD COLUMN IF NOT EXISTS rate_cache_read      numeric(12,6),
  ADD COLUMN IF NOT EXISTS rate_cache_write_5m  numeric(12,6),
  ADD COLUMN IF NOT EXISTS rate_cache_write_1h  numeric(12,6),
  ADD COLUMN IF NOT EXISTS cache_model          text,
  ADD COLUMN IF NOT EXISTS tier_applied         bigint;

ALTER TABLE usage_scenario
  ADD COLUMN IF NOT EXISTS rate_input           numeric(12,6),
  ADD COLUMN IF NOT EXISTS rate_output          numeric(12,6),
  ADD COLUMN IF NOT EXISTS rate_cache_read      numeric(12,6),
  ADD COLUMN IF NOT EXISTS rate_cache_write_5m  numeric(12,6),
  ADD COLUMN IF NOT EXISTS rate_cache_write_1h  numeric(12,6);
```

Rates are USD per 1e6 tokens, as everywhere else. `numeric(12,6)` covers sub-cent rates
(`qwen3.7-flash` cache_read is `0.006`) with headroom.

Nullable, not `NOT NULL DEFAULT 0`: a row synced before this change has *unknown* rates, and
`0` would be a lie that silently satisfies the reconciliation check below. Rows backfill to
non-null on the next sync.

### The payoff — cost becomes checkable in SQL

```sql
CREATE OR REPLACE VIEW usage_cost_audit AS
SELECT harness, session_id, message_id, model, cost_usd,
       round(( input_tokens          * rate_input
             + (output_tokens + reasoning_tokens) * rate_output
             + cache_read_tokens     * rate_cache_read
             + cache_write_5m_tokens * rate_cache_write_5m
             + cache_write_1h_tokens * rate_cache_write_1h) / 1e6, 6) AS recomputed_usd
FROM usage_event
WHERE rate_input IS NOT NULL;
```

Any row where `cost_usd <> recomputed_usd` is a bug in the agent or a corrupted write. This
is the first invariant in the whole system that can be verified without trusting the client
— note the `output + reasoning` term, which is exactly the Bug A regression from plan 002,
now permanently guarded in SQL.

### Files

| File | Change |
|---|---|
| `agent/src/pricing.js` | `computeCost` already derives all five rates — return them. Propagate through `price()` (which must also start returning `tier_applied`) and `repriceEvent()`. |
| `agent/src/record.js` | Add the seven fields to `FIELD_ORDER`. This is the single list that drives the JSONL archive and the Postgres column order, so the sink follows automatically. |
| `agent/src/sync.js` | Stop discarding `priced.cache_model` (line ~70). Reprice all stored events each run, not just newly extracted ones — mirror the existing `store.allEvents()` pass used for scenarios. |
| `agent/src/reprice.js` | Carry the rate fields into `scenarioRows()` output. |
| `agent/src/sink-postgres.js` | `SCENARIO_COLUMNS` gains the five rates. Event columns come from `FIELD_ORDER` automatically. Extend `missingTables()` to a `schemaGaps()` that also reports missing *columns*. |
| `agent/src/doctor.js` | Report missing columns with the exact ALTER to run. Add a reconciliation check: recompute cost from stored rates for a sample and assert it matches. |
| `server/postgres/init/01-schema.sql` | Columns inline in the CREATE TABLEs (fresh installs) + the `usage_cost_audit` view. |
| `server/postgres/migrations/001-add-rates.sql` *(new)* | The ALTERs above, for the existing database. New directory; document that `postgres/init/` only runs on an empty volume. |
| `server/grafana/dashboards/harness-usage.json` | Optional panel: effective rate per model over time, which makes a price change visible at a glance. |
| `README.md` | Document the rate columns, the migration step, and the changed `sync` semantics. |

## Verification

1. **Reconciliation**: `SELECT count(*) FROM usage_cost_audit WHERE abs(cost_usd - recomputed_usd) > 0.000001` must be **0**.
2. **Anthropic 1h rule persisted**: for a Claude Code row with `cache_write_1h_tokens > 0`,
   assert `rate_cache_write_1h = 2 * rate_input`.
3. **Fallbacks persisted**: for a `cache_model = 'none'` scenario row, assert
   `rate_cache_read = rate_input`; for `'read-only'`, assert `rate_cache_write_5m = rate_input`.
4. **Tier recorded**: a row whose `input_tokens + cache_read_tokens > 256000` priced against
   `openrouter/qwen/qwen3.7-flash` must have `tier_applied = 256000` and `rate_input = 0.2`.
5. **Nulls only where expected**: after a full `backfill`, no row has `rate_input IS NULL`.
6. **Idempotency unchanged**: `sync` twice — row counts and `SUM(cost_usd)` stable.
7. **Migration on the live DB**: apply `migrations/001-add-rates.sql` to rpi5, confirm
   `doctor` goes green, `backfill` populates every rate column, and the 33K existing rows
   are preserved (no `down -v`).
8. **Repricing is visible**: edit a rate in `pricing-overrides.json`, `backfill`, and confirm
   the affected rows show both the new `cost_usd` and the new `rate_*` — the change that was
   previously silent is now legible.

## Out of scope

Storing a `models.json` version or hash (the applied rates *are* the information);
per-row pricing timestamps beyond the existing `synced_at`; any move of pricing arithmetic
into SQL — the audit view recomputes for verification only, and `pricing.js` remains the
single source of truth.
