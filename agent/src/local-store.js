// Local store — the on-device half of the pipeline. Two things live here:
//
//   1. events/YYYY-MM-DD.jsonl   the readable archive, one JSON object per line,
//      jq-friendly. Given that Claude Code prunes its own transcripts after
//      ~30 days, this is the only durable history past that window, so it is
//      written on every sync regardless of whether Postgres is reachable.
//
//   2. state.sqlite              sync cursors + the outbox. Rows are inserted
//      here (idempotently, keyed by the canonical PK) at the same time they are
//      appended to the JSONL, and flipped to synced=1 only on a confirmed
//      Postgres upsert. If shipping is down the backlog just accumulates.
//
// SQLite comes from the built-in node:sqlite (Node >=22.5) — no native build.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { makeEvent, eventKey, eventDay, FIELD_ORDER } from "./record.js";

export class LocalStore {
  constructor({ dataDir = DATA_DIR } = {}) {
    this.dataDir = dataDir;
    this.eventsDir = join(dataDir, "events");
    mkdirSync(this.eventsDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "state.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    migrate(this.db);
  }

  close() {
    this.db.close();
  }

  // --- cursors: Claude Code per-file (inode, byte offset) --------------------

  getFileCursor(path) {
    return (
      this.db
        .prepare("SELECT inode, offset, size FROM cc_cursor WHERE path = ?")
        .get(path) || null
    );
  }

  setFileCursor(path, { inode, offset, size }) {
    this.db
      .prepare(
        `INSERT INTO cc_cursor (path, inode, offset, size, updated_at)
         VALUES (?, ?, ?, ?, strftime('%s','now'))
         ON CONFLICT(path) DO UPDATE SET
           inode = excluded.inode, offset = excluded.offset,
           size = excluded.size, updated_at = excluded.updated_at`,
      )
      .run(path, inode, offset, size);
  }

  // --- cursors: generic key/value (OpenCode time_updated watermark) ---------

  getKV(key) {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  setKV(key, value) {
    this.db
      .prepare(
        `INSERT INTO kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, String(value));
  }

  resetCursors() {
    this.db.exec("DELETE FROM cc_cursor; DELETE FROM kv WHERE key LIKE 'watermark:%';");
  }

  // --- outbox --------------------------------------------------------------

  /**
   * Record one event: upsert into the outbox (idempotent on PK) and append to
   * the day's JSONL archive if this exact payload has not been archived before.
   * A changed payload (e.g. a reprice on backfill) re-appends and re-queues for
   * shipping; downstream consumers take last-wins by PK. Returns 'new',
   * 'changed', or 'unchanged'.
   */
  record(partial) {
    const ev = makeEvent(partial);
    const key = eventKey(ev);
    const payload = JSON.stringify(orderFields(ev));
    const hash = createHash("sha1").update(payload).digest("hex");

    const prev = this.db
      .prepare("SELECT hash FROM archived WHERE pk = ?")
      .get(key);
    const state = !prev ? "new" : prev.hash === hash ? "unchanged" : "changed";

    this.db
      .prepare(
        `INSERT INTO outbox (pk, harness, device, day, ts, payload, synced, first_seen)
         VALUES (?, ?, ?, ?, ?, ?, 0, strftime('%s','now'))
         ON CONFLICT(pk) DO UPDATE SET
           payload = excluded.payload,
           synced = CASE WHEN outbox.payload = excluded.payload THEN outbox.synced ELSE 0 END`,
      )
      .run(key, ev.harness, ev.device, eventDay(ev), ev.ts, payload);

    if (state !== "unchanged") {
      appendFileSync(join(this.eventsDir, `${eventDay(ev)}.jsonl`), payload + "\n");
      this.db
        .prepare(
          `INSERT INTO archived (pk, hash) VALUES (?, ?)
           ON CONFLICT(pk) DO UPDATE SET hash = excluded.hash`,
        )
        .run(key, hash);
    }
    return state;
  }

  unsynced(limit = 100000) {
    return this.db
      .prepare("SELECT pk, payload FROM outbox WHERE synced = 0 ORDER BY ts LIMIT ?")
      .all(limit)
      .map((r) => ({ pk: r.pk, event: JSON.parse(r.payload) }));
  }

  markSynced(pks) {
    if (!pks.length) return;
    const stmt = this.db.prepare(
      "UPDATE outbox SET synced = 1, synced_at = strftime('%s','now') WHERE pk = ?",
    );
    const tx = this.db.prepare("BEGIN");
    tx.run();
    try {
      for (const pk of pks) stmt.run(pk);
      this.db.prepare("COMMIT").run();
    } catch (e) {
      this.db.prepare("ROLLBACK").run();
      throw e;
    }
  }

  // --- reporting -----------------------------------------------------------

  summary() {
    const totals = this.db
      .prepare(
        `SELECT
           harness,
           COUNT(*) AS events,
           SUM(synced = 0) AS unsynced,
           MIN(ts) AS first_ts,
           MAX(ts) AS last_ts
         FROM outbox GROUP BY harness ORDER BY harness`,
      )
      .all();

    const agg = (sqlExpr) =>
      this.db.prepare(`SELECT ${sqlExpr} AS v FROM outbox`).get().v || 0;

    const byModel = this.db
      .prepare(
        `SELECT
           json_extract(payload,'$.provider') AS provider,
           json_extract(payload,'$.model') AS model,
           COUNT(*) AS events,
           ROUND(SUM(json_extract(payload,'$.cost_usd')), 4) AS cost_usd,
           SUM(json_extract(payload,'$.input_tokens')
             + json_extract(payload,'$.output_tokens')
             + json_extract(payload,'$.reasoning_tokens')
             + json_extract(payload,'$.cache_read_tokens')
             + json_extract(payload,'$.cache_write_5m_tokens')
             + json_extract(payload,'$.cache_write_1h_tokens')) AS tokens
         FROM outbox GROUP BY provider, model ORDER BY cost_usd DESC`,
      )
      .all();

    return {
      totals,
      totalEvents: agg("COUNT(*)"),
      totalUnsynced: agg("SUM(synced = 0)"),
      totalCost: this.db
        .prepare(
          "SELECT ROUND(SUM(json_extract(payload,'$.cost_usd')), 4) AS v FROM outbox",
        )
        .get().v || 0,
      byModel,
    };
  }
}

function orderFields(ev) {
  const out = {};
  for (const k of FIELD_ORDER) out[k] = ev[k];
  return out;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cc_cursor (
      path       TEXT PRIMARY KEY,
      inode      INTEGER NOT NULL,
      offset     INTEGER NOT NULL,
      size       INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      pk         TEXT PRIMARY KEY,
      harness    TEXT NOT NULL,
      device     TEXT NOT NULL,
      day        TEXT NOT NULL,
      ts         TEXT NOT NULL,
      payload    TEXT NOT NULL,
      synced     INTEGER NOT NULL DEFAULT 0,
      first_seen INTEGER NOT NULL,
      synced_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS outbox_unsynced ON outbox (synced, ts);
    CREATE TABLE IF NOT EXISTS archived (
      pk   TEXT PRIMARY KEY,
      hash TEXT NOT NULL
    );
  `);
}
