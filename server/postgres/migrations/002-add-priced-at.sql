-- Migration 002 — record when each valuation was made (plans/004)
--
-- Context: as of plans/004 a row is priced ONCE, at ingest, and never
-- recomputed. Postgres is a ledger of what each request would have cost when it
-- happened, not a running revaluation at today's rates.
--
-- priced_at dates that valuation. For an event priced at ingest it lands ~= ts.
-- For a scenario added later it lands far after its event's ts — which is the
-- visible marker that the counterfactual could NOT use contemporaneous rates,
-- because no archive of past rate tables exists to price it against.
--
-- NULLABLE ON PURPOSE. Rows written before this migration were last valued at
-- an indeterminate moment under the plans/003 reprice-everything behaviour, and
-- that moment is not recoverable. NULL means "valued before the freeze, date
-- unknown". Do NOT backfill it with now() — that would assert a valuation date
-- we do not actually know.
--
-- Safe to re-run. Non-destructive: ADD COLUMN with no default rewrites no rows.
--
-- Apply on the Pi:
--   docker compose exec -T postgres psql -U harness -d harness \
--     < server/postgres/migrations/002-add-priced-at.sql

BEGIN;

ALTER TABLE usage_event    ADD COLUMN IF NOT EXISTS priced_at timestamptz;
ALTER TABLE usage_scenario ADD COLUMN IF NOT EXISTS priced_at timestamptz;

COMMIT;

-- Verify:
--   SELECT count(*) FILTER (WHERE priced_at IS NULL)  AS pre_freeze,
--          count(*) FILTER (WHERE priced_at IS NOT NULL) AS frozen
--     FROM usage_event;
--
-- Scenario rows whose valuation is NOT contemporaneous with their event
-- (added after the fact, so priced at rates from a later date):
--   SELECT s.scenario, count(*), max(s.priced_at - e.ts) AS worst_lag
--     FROM usage_scenario s
--     JOIN usage_event e USING (harness, session_id, message_id)
--    WHERE s.priced_at IS NOT NULL AND s.priced_at - e.ts > interval '1 day'
--    GROUP BY s.scenario;
