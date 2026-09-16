-- Harness usage telemetry — schema.
--
-- One fact row per LLM API response. PK (harness, session_id, message_id) makes
-- re-syncing and overlapping runs idempotent. Session / day / project views are
-- derived, not stored.

CREATE TABLE IF NOT EXISTS usage_event (
    harness                 text        NOT NULL,
    device                  text        NOT NULL,
    session_id              text        NOT NULL,
    message_id              text        NOT NULL,
    ts                      timestamptz NOT NULL,

    provider                text,
    model                   text,
    agent                   text,
    project                 text,
    git_branch              text,
    is_sidechain            boolean     NOT NULL DEFAULT false,

    input_tokens            bigint      NOT NULL DEFAULT 0,
    output_tokens           bigint      NOT NULL DEFAULT 0,  -- excludes reasoning
    reasoning_tokens        bigint      NOT NULL DEFAULT 0,
    cache_read_tokens       bigint      NOT NULL DEFAULT 0,
    cache_write_5m_tokens   bigint      NOT NULL DEFAULT 0,
    cache_write_1h_tokens   bigint      NOT NULL DEFAULT 0,

    cost_usd                numeric(14,6) NOT NULL DEFAULT 0,   -- potential cost, computed by the agent
    billing                 text        NOT NULL DEFAULT 'free' -- 'api' | 'local' | 'free'
                              CHECK (billing IN ('api', 'local', 'free')),
    priced_by               text        NOT NULL DEFAULT 'none' -- 'table' | 'override' | 'none'
                              CHECK (priced_by IN ('table', 'override', 'none')),

    -- The rate card actually APPLIED (plans/003): post-tier-selection and
    -- post-fallback, USD per 1e6 tokens. Storing these makes cost_usd
    -- reproducible from stored data (see usage_cost_audit) and makes a
    -- models.json price change visible instead of a silent step in the totals.
    -- Nullable on purpose: a row priced with no rate card has UNKNOWN rates,
    -- and 0 would be a lie that satisfies the audit check.
    cache_model             text        CHECK (cache_model IN ('full', 'read-only', 'none')),
    tier_applied            bigint,
    rate_input              numeric(12,6),
    rate_output             numeric(12,6),
    rate_cache_read         numeric(12,6),
    rate_cache_write_5m     numeric(12,6),
    rate_cache_write_1h     numeric(12,6),

    synced_at               timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (harness, session_id, message_id)
);

CREATE INDEX IF NOT EXISTS usage_event_ts_idx        ON usage_event (ts);
CREATE INDEX IF NOT EXISTS usage_event_device_ts_idx ON usage_event (device, ts);
CREATE INDEX IF NOT EXISTS usage_event_project_idx   ON usage_event (project);
CREATE INDEX IF NOT EXISTS usage_event_model_idx     ON usage_event (provider, model);

-- Per-session rollup.
CREATE OR REPLACE VIEW usage_session AS
SELECT
    harness,
    device,
    session_id,
    max(project)                          AS project,
    mode() WITHIN GROUP (ORDER BY model)   AS model,
    min(ts)                               AS started_at,
    max(ts)                               AS last_event_at,
    max(ts) - min(ts)                     AS duration,
    count(*)                              AS responses,
    sum(input_tokens)                     AS input_tokens,
    sum(output_tokens)                    AS output_tokens,
    sum(reasoning_tokens)                 AS reasoning_tokens,
    sum(cache_read_tokens)               AS cache_read_tokens,
    sum(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens,
    sum(input_tokens + output_tokens + reasoning_tokens
        + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens) AS total_tokens,
    sum(cost_usd)                         AS cost_usd,
    bool_or(billing = 'api')              AS has_api_spend
FROM usage_event
GROUP BY harness, device, session_id;

-- Per-day rollup (UTC day), split by device / harness / model / billing.
CREATE OR REPLACE VIEW usage_daily AS
SELECT
    date_trunc('day', ts)                 AS day,
    device,
    harness,
    provider,
    model,
    billing,
    count(*)                              AS responses,
    count(DISTINCT session_id)            AS sessions,
    sum(input_tokens)                     AS input_tokens,
    sum(output_tokens)                    AS output_tokens,
    sum(reasoning_tokens)                 AS reasoning_tokens,
    sum(cache_read_tokens)               AS cache_read_tokens,
    sum(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens,
    sum(input_tokens + output_tokens + reasoning_tokens
        + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens) AS total_tokens,
    sum(cost_usd)                         AS cost_usd
FROM usage_event
GROUP BY date_trunc('day', ts), device, harness, provider, model, billing;

-- Per-project rollup.
CREATE OR REPLACE VIEW usage_project AS
SELECT
    coalesce(project, '(unknown)')        AS project,
    device,
    harness,
    count(*)                              AS responses,
    count(DISTINCT session_id)            AS sessions,
    min(ts)                               AS first_event_at,
    max(ts)                               AS last_event_at,
    sum(input_tokens + output_tokens + reasoning_tokens
        + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens) AS total_tokens,
    sum(cost_usd)                         AS cost_usd
FROM usage_event
GROUP BY coalesce(project, '(unknown)'), device, harness;

-- ---------------------------------------------------------------------------
-- Counterfactual repricing (plans/002)
--
-- One row per (event, scenario): what this exact token stream would have cost
-- at another model's rates. The agent computes these in JS so the pricing rules
-- live in exactly one place; this table is only the materialized result for the
-- configured shortlist. Ad-hoc comparison across the whole price table happens
-- via `harness-usage compare`.
--
-- cache_model records whether the target actually supports prompt caching:
-- 'none' means its cache-read tokens were billed at the full input rate, which
-- dominates the comparison on a cache-heavy workload. Never read a cheap
-- headline rate without it.

CREATE TABLE IF NOT EXISTS usage_scenario (
    harness      text NOT NULL,
    session_id   text NOT NULL,
    message_id   text NOT NULL,
    scenario     text NOT NULL,              -- 'openrouter/qwen/qwen3.7-flash'
    cost_usd     numeric(14,6) NOT NULL DEFAULT 0,
    cache_model  text NOT NULL DEFAULT 'none'
                   CHECK (cache_model IN ('full', 'read-only', 'none')),
    priced_by    text NOT NULL DEFAULT 'none'
                   CHECK (priced_by IN ('table', 'override', 'none')),
    tier_applied bigint,                     -- context-tier size in effect, or NULL
    -- Applied rates, as on usage_event (plans/003).
    rate_input          numeric(12,6),
    rate_output         numeric(12,6),
    rate_cache_read     numeric(12,6),
    rate_cache_write_5m numeric(12,6),
    rate_cache_write_1h numeric(12,6),
    synced_at    timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (harness, session_id, message_id, scenario),
    FOREIGN KEY (harness, session_id, message_id)
        REFERENCES usage_event (harness, session_id, message_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS usage_scenario_scenario_idx ON usage_scenario (scenario);

-- Actual vs counterfactual per day. Joins back to usage_event for ts/device so
-- the scenario table itself stays narrow.
CREATE OR REPLACE VIEW usage_scenario_daily AS
SELECT
    date_trunc('day', e.ts)        AS day,
    e.device,
    e.harness,
    s.scenario,
    s.cache_model,
    count(*)                       AS responses,
    sum(e.cost_usd)                AS actual_cost_usd,
    sum(s.cost_usd)                AS scenario_cost_usd,
    sum(s.cost_usd) - sum(e.cost_usd) AS delta_usd
FROM usage_event e
JOIN usage_scenario s
  ON s.harness = e.harness AND s.session_id = e.session_id AND s.message_id = e.message_id
WHERE s.priced_by <> 'none'
GROUP BY date_trunc('day', e.ts), e.device, e.harness, s.scenario, s.cache_model;

-- Actual vs counterfactual per project — the decision aid.
CREATE OR REPLACE VIEW usage_scenario_project AS
SELECT
    coalesce(e.project, '(unknown)') AS project,
    e.harness,
    s.scenario,
    s.cache_model,
    count(*)                         AS responses,
    sum(e.cost_usd)                  AS actual_cost_usd,
    sum(s.cost_usd)                  AS scenario_cost_usd,
    sum(s.cost_usd) - sum(e.cost_usd) AS delta_usd
FROM usage_event e
JOIN usage_scenario s
  ON s.harness = e.harness AND s.session_id = e.session_id AND s.message_id = e.message_id
WHERE s.priced_by <> 'none'
GROUP BY coalesce(e.project, '(unknown)'), e.harness, s.scenario, s.cache_model;

-- What the local GPU is saving: local-billed events repriced onto hosted models.
CREATE OR REPLACE VIEW usage_local_savings AS
SELECT
    s.scenario,
    s.cache_model,
    e.device,
    count(*)                     AS responses,
    sum(e.input_tokens + e.output_tokens + e.reasoning_tokens) AS tokens,
    sum(s.cost_usd)              AS would_have_cost_usd
FROM usage_event e
JOIN usage_scenario s
  ON s.harness = e.harness AND s.session_id = e.session_id AND s.message_id = e.message_id
WHERE e.billing = 'local' AND s.priced_by <> 'none'
GROUP BY s.scenario, s.cache_model, e.device;

-- ---------------------------------------------------------------------------
-- Cost audit (plans/003)
--
-- Recomputes cost_usd from the stored token counts and the stored applied
-- rates. Any row where the two disagree is a bug in the agent or a corrupted
-- write. This is the only invariant in the system that can be checked WITHOUT
-- trusting the client that produced the number.
--
-- Note the (output_tokens + reasoning_tokens) term: reasoning is normalized out
-- of output_tokens at extraction and billed at the output rate, which is exactly
-- the regression that once billed Anthropic thinking tokens at $0. It is now
-- permanently guarded here, in SQL, not only by a unit probe in the agent.

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
    round(( input_tokens                          * rate_input
          + (output_tokens + reasoning_tokens)    * rate_output
          + cache_read_tokens                     * rate_cache_read
          + cache_write_5m_tokens                 * rate_cache_write_5m
          + cache_write_1h_tokens                 * rate_cache_write_1h
          ) / 1e6, 6) AS recomputed_usd,
    cost_usd - round(( input_tokens                       * rate_input
                     + (output_tokens + reasoning_tokens) * rate_output
                     + cache_read_tokens                  * rate_cache_read
                     + cache_write_5m_tokens              * rate_cache_write_5m
                     + cache_write_1h_tokens              * rate_cache_write_1h
                     ) / 1e6, 6) AS drift_usd
FROM usage_event
WHERE rate_input IS NOT NULL;
