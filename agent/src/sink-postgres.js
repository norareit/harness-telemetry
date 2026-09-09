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

  async schemaPresent() {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'usage_event'`,
    );
    return rows.length > 0;
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
}

function normalize(col, v) {
  if (v === undefined) return null;
  if (col === "ts") return v; // ISO string; Postgres casts to timestamptz
  return v;
}
