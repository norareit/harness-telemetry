-- Migration 001 — store the applied pricing rates (plans/003)
--
-- WHY THIS FILE EXISTS: scripts in postgres/init/ are run by the Postgres image
-- ONLY when the data directory is empty. A database created before a schema
-- addition therefore never sees it, and looks perfectly healthy right up until a
-- write fails on an unknown column — halfway through a sync, after the events
-- have already committed. `harness-usage doctor` detects that and points here.
--
-- Safe to re-run: every statement is idempotent.
-- Non-destructive: ADD COLUMN with no default rewrites no rows in PG 11+.
--
-- Apply on the Pi:
--   docker compose exec -T postgres psql -U harness -d harness \
--     < server/postgres/migrations/001-add-rates.sql
--
-- Then run `harness-usage backfill` on each device to populate the new columns
-- for existing rows. Until that runs, rate_* stays NULL on historical rows,
-- which is correct — their rates genuinely are not known.

BEGIN;

ALTER TABLE usage_event
    ADD COLUMN IF NOT EXISTS cache_model         text,
    ADD COLUMN IF NOT EXISTS tier_applied        bigint,
    ADD COLUMN IF NOT EXISTS rate_input          numeric(12,6),
    ADD COLUMN IF NOT EXISTS rate_output         numeric(12,6),
    ADD COLUMN IF NOT EXISTS rate_cache_read     numeric(12,6),
    ADD COLUMN IF NOT EXISTS rate_cache_write_5m numeric(12,6),
    ADD COLUMN IF NOT EXISTS rate_cache_write_1h numeric(12,6);

-- Added separately from the ADD COLUMNs so re-running the file is safe. Plain
-- SQL rather than a PL/pgSQL exception block: this file runs against a live
-- database and the simpler form is easier to verify by eye. NOT VALID skips the
-- scan of existing rows, which are all NULL anyway.
ALTER TABLE usage_event DROP CONSTRAINT IF EXISTS usage_event_cache_model_check;
ALTER TABLE usage_event
    ADD CONSTRAINT usage_event_cache_model_check
    CHECK (cache_model IN ('full', 'read-only', 'none')) NOT VALID;

ALTER TABLE usage_scenario
    ADD COLUMN IF NOT EXISTS rate_input          numeric(12,6),
    ADD COLUMN IF NOT EXISTS rate_output         numeric(12,6),
    ADD COLUMN IF NOT EXISTS rate_cache_read     numeric(12,6),
    ADD COLUMN IF NOT EXISTS rate_cache_write_5m numeric(12,6),
    ADD COLUMN IF NOT EXISTS rate_cache_write_1h numeric(12,6);

CREATE OR REPLACE VIEW usage_cost_audit AS
SELECT
    harness,
    device,
    session_id,
    message_id,
    ts,
    model,
    cache_model,
    tier_applied,
    cost_usd,
    round(( input_tokens                       * rate_input
          + (output_tokens + reasoning_tokens) * rate_output
          + cache_read_tokens                  * rate_cache_read
          + cache_write_5m_tokens              * rate_cache_write_5m
          + cache_write_1h_tokens              * rate_cache_write_1h
          ) / 1e6, 6) AS recomputed_usd,
    cost_usd - round(( input_tokens                       * rate_input
                     + (output_tokens + reasoning_tokens) * rate_output
                     + cache_read_tokens                  * rate_cache_read
                     + cache_write_5m_tokens              * rate_cache_write_5m
                     + cache_write_1h_tokens              * rate_cache_write_1h
                     ) / 1e6, 6) AS drift_usd
FROM usage_event
WHERE rate_input IS NOT NULL;

COMMIT;

-- Verify:
--   SELECT count(*) FROM usage_cost_audit WHERE abs(drift_usd) > 0.000001;  -- expect 0
--   SELECT count(*) FROM usage_event WHERE rate_input IS NULL;              -- 0 after backfill
