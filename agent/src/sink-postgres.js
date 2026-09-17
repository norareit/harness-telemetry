// Postgres sink — idempotent upsert of canonical events into usage_event.
//
// PK is (harness, session_id, message_id). ON CONFLICT DO UPDATE so that a
// re-synced row (e.g. reprice, or an OpenCode message edited after first read)
// converges instead of duplicating. Re-running sync twice must leave both the
// row count and SUM(cost_usd) unchanged.
//
// `pg` is pure JS — no native build on any platform.

import pg from "pg";
import { FIELD_ORDER } from "./record.js";

const { Pool } = pg;

// Columns we write, in a fixed order. (device stays; it is part of the row but
// not the PK.)
const COLUMNS = FIELD_ORDER.slice();

const UPDATE_SET = COLUMNS.filter(
  (c) => !["harness", "session_id", "message_id"].includes(c),
)
  .map((c) => `${c} = EXCLUDED.${c}`)
  .concat("synced_at = now()")
  .join(", ");

export class PostgresSink {
  constructor(config) {
    const pgCfg = config.postgres || {};
    if (!pgCfg.dsn) {
      throw new Error(
        "postgres.dsn is not set in config. See config.example.json / README.",
      );
    }
    this.pool = new Pool({
      connectionString: pgCfg.dsn,
      connectionTimeoutMillis: pgCfg.connectionTimeoutMillis ?? 10000,
      statement_timeout: pgCfg.statementTimeoutMillis ?? 30000,
      max: 4,
    });
  }

  async close() {
    await this.pool.end();
  }

  async ping() {
    const { rows } = await this.pool.query("SELECT 1 AS ok");
    return rows[0].ok === 1;
  }

  /**
   * Which expected tables are absent. Checks every table we write to, not just
   * usage_event — the init script only runs on a fresh volume, so a database
   * created before a schema addition looks healthy right up until a sync fails
   * partway through with a missing relation.
   */
  async missingTables() {
    const expected = ["usage_event", "usage_scenario"];
    const { rows } = await this.pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [expected],
    );
    const present = new Set(rows.map((r) => r.table_name));
    return expected.filter((t) => !present.has(t));
  }

  /**
   * Missing tables AND missing columns. Columns matter for the same reason
   * tables do: postgres/init only runs on an empty volume, so a database
   * created before a schema addition looks healthy right up until a write
   * fails on an unknown column — halfway through, after the events committed.
   */
  async schemaGaps() {
    const missingTables = await this.missingTables();
    const expected = {
      usage_event: COLUMNS,
      usage_scenario: SCENARIO_COLUMNS,
    };
    const missingColumns = [];
    for (const [table, cols] of Object.entries(expected)) {
      if (missingTables.includes(table)) continue;
      const { rows } = await this.pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const present = new Set(rows.map((r) => r.column_name));
      for (const c of cols) if (!present.has(c)) missingColumns.push({ table, column: c });
    }
    return { missingTables, missingColumns };
  }

  /**
   * Upsert a batch of canonical events. Returns the number of rows sent.
   * Throws on any failure so the caller leaves them unsynced for the next run.
   */
  async upsert(events, { batchSize = 500 } = {}) {
    if (!events.length) return 0;
    const client = await this.pool.connect();
    try {
      for (let i = 0; i < events.length; i += batchSize) {
        const chunk = events.slice(i, i + batchSize);
        const values = [];
        const params = [];
        chunk.forEach((ev, r) => {
          const base = r * COLUMNS.length;
          values.push(`(${COLUMNS.map((_, c) => `$${base + c + 1}`).join(", ")})`);
          for (const col of COLUMNS) params.push(normalize(col, ev[col]));
        });
        const sql = `
          INSERT INTO usage_event (${COLUMNS.join(", ")})
          VALUES ${values.join(", ")}
          ON CONFLICT (harness, session_id, message_id)
          DO UPDATE SET ${UPDATE_SET}
        `;
        await client.query(sql, params);
      }
    } finally {
      client.release();
    }
    return events.length;
  }

  /**
   * Upsert counterfactual scenario rows. Same idempotency contract as
   * `upsert`: PK is (harness, session_id, message_id, scenario), so replays
   * converge instead of duplicating.
   *
   * These rows FK back to usage_event, so they must be sent only after the
   * events they reference are committed.
   */
  async upsertScenarios(rows, { batchSize = 500 } = {}) {
    if (!rows.length) return 0;
    const client = await this.pool.connect();
    try {
      for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        const values = [];
        const params = [];
        chunk.forEach((row, r) => {
          const base = r * SCENARIO_COLUMNS.length;
          values.push(
            `(${SCENARIO_COLUMNS.map((_, c) => `$${base + c + 1}`).join(", ")})`,
          );
          for (const col of SCENARIO_COLUMNS) params.push(row[col] ?? null);
        });
        const sql = `
          INSERT INTO usage_scenario (${SCENARIO_COLUMNS.join(", ")})
          VALUES ${values.join(", ")}
          ON CONFLICT (harness, session_id, message_id, scenario)
          DO UPDATE SET ${SCENARIO_UPDATE_SET}
        `;
        await client.query(sql, params);
      }
    } finally {
      client.release();
    }
    return rows.length;
  }
}

const SCENARIO_COLUMNS = [
  "harness",
  "session_id",
  "message_id",
  "scenario",
  "cost_usd",
  "cache_model",
  "priced_by",
  "tier_applied",
  "rate_input",
  "rate_output",
  "rate_cache_read",
  "rate_cache_write_5m",
  "rate_cache_write_1h",
  // scenarioRows() has always produced this, but it was missing here, so every
  // shipped scenario row landed with priced_at NULL — and schemaGaps() derives
  // its expectations from this same list, so nothing could detect the gap. It
  // is the plans/004 marker for a counterfactual priced at rates from long
  // after its event's ts, which is the only honest reading of those rows.
  "priced_at",
];

const SCENARIO_UPDATE_SET = SCENARIO_COLUMNS.filter(
  (c) => !["harness", "session_id", "message_id", "scenario"].includes(c),
)
  .map((c) => `${c} = EXCLUDED.${c}`)
  .concat("synced_at = now()")
  .join(", ");

function normalize(col, v) {
  if (v === undefined) return null;
  if (col === "ts") return v; // ISO string; Postgres casts to timestamptz
  return v;
}
