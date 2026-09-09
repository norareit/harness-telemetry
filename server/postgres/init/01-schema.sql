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
