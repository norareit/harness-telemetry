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
import {
  mkdirSync,
  appendFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import {
  makeEvent,
  eventKey,
  eventDay,
  FIELD_ORDER,
  DERIVED_FIELDS,
} from "./record.js";

// Prefix on stored archive hashes. Bumped when the hash BASIS changes, so a
// legacy hash can be recognised and re-stamped without re-appending the line.
const HASH_VERSION = "v2:";

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

  /**
   * Run `fn` inside a single SQLite transaction.
   *
   * record() issues 2 SELECTs and up to 2 INSERTs per event. Outside a
   * transaction each of those is its own implicit transaction, and WAL fsyncs
   * every one: repricing 4,214 events cost 26.0s — ~6.2ms per event, essentially
   * all of it disk sync. Batched, the same work is milliseconds. recordScenarios()
   * already did this, which is why it upserts 29,498 rows in 110ms.
   *
   * Caveat: record() also appends to the JSONL archive, which is NOT part of the
   * transaction. A crash mid-transaction can leave an appended line whose
   * `archived` row rolled back, so the next run re-appends it. That is benign —
   * `compact-archive` removes the duplicate and Postgres upserts on the PK
   * regardless — but it is why the archive must always be read last-wins.
   */
  transaction(fn) {
    this.db.prepare("BEGIN").run();
    try {
      const out = fn();
      this.db.prepare("COMMIT").run();
      return out;
    } catch (e) {
      this.db.prepare("ROLLBACK").run();
      throw e;
    }
  }

  /**
   * Async variant, for bodies that await — notably the extraction loop, which
   * is an async generator.
   *
   * Extraction must be wrapped as a WHOLE, cursors included, not batched in
   * chunks: the generator advances per-file cursors into this same database as
   * it goes. If cursors committed independently of the events they cover, a
   * crash could leave a cursor pointing past events that were never stored, and
   * the next run would skip them permanently. Wrapping everything means a crash
   * rolls the cursor back too, and re-reading is harmless because the PK upsert
   * is idempotent.
   *
   * Holding a write transaction across the generator's file I/O is acceptable
   * here: that I/O measures ~0.5s for the full history, and this store has a
   * single writer by construction.
   */
  async transactionAsync(fn) {
    this.db.prepare("BEGIN").run();
    try {
      const out = await fn();
      this.db.prepare("COMMIT").run();
      return out;
    } catch (e) {
      this.db.prepare("ROLLBACK").run();
      throw e;
    }
  }

  // --- outbox --------------------------------------------------------------

  /**
   * Record one event: upsert into the outbox and, when the SOURCE data is new
   * or changed, append to the day's JSONL archive. Returns 'new', 'changed' or
   * 'unchanged', describing the shipped payload.
   *
   * Two different questions, deliberately answered by two different hashes:
   *
   *   re-ship?    any change matters — Postgres must receive corrected costs.
   *   re-archive? only SOURCE data matters. The archive exists because Claude
   *               Code prunes transcripts after ~30 days, so its job is
   *               preserving token counts, which never change. Costs are
   *               derived and recomputable from them plus the price table.
   *
   * Hashing the whole payload for both meant a reprice appended a second line
   * per event differing only in rate metadata — 4,177 duplicate lines in a
   * single backfill, and a naive sum over the archive overcounted by 96.8%.
   * Cost fields in an archived line are therefore as-of-first-archival and may
   * be stale; Postgres is authoritative for cost.
   */
  record(partial) {
    const ev = makeEvent(partial);
    const key = eventKey(ev);
    const payload = JSON.stringify(orderFields(ev));
    const sourceHash =
      HASH_VERSION + createHash("sha1").update(sourceOf(ev)).digest("hex");

    const prevOutbox = this.db
      .prepare("SELECT payload FROM outbox WHERE pk = ?")
      .get(key);
    const state = !prevOutbox
      ? "new"
      : prevOutbox.payload === payload
        ? "unchanged"
        : "changed";

    this.db
      .prepare(
        `INSERT INTO outbox (pk, harness, device, day, ts, payload, synced, first_seen)
         VALUES (?, ?, ?, ?, ?, ?, 0, strftime('%s','now'))
         ON CONFLICT(pk) DO UPDATE SET
           payload = excluded.payload,
           synced = CASE WHEN outbox.payload = excluded.payload THEN outbox.synced ELSE 0 END`,
      )
      .run(key, ev.harness, ev.device, eventDay(ev), ev.ts, payload);

    const prevArchived = this.db
      .prepare("SELECT hash FROM archived WHERE pk = ?")
      .get(key);

    let shouldAppend;
    if (!prevArchived) {
      shouldAppend = true;
    } else if (!prevArchived.hash.startsWith(HASH_VERSION)) {
      // Legacy full-payload hash: the event is already on disk. Re-stamp it
      // with a source hash WITHOUT appending — otherwise switching the hash
      // basis would duplicate every line a second time.
      shouldAppend = false;
    } else {
      shouldAppend = prevArchived.hash !== sourceHash;
    }

    if (shouldAppend) {
      appendFileSync(join(this.eventsDir, `${eventDay(ev)}.jsonl`), payload + "\n");
    }
    if (!prevArchived || prevArchived.hash !== sourceHash) {
      this.db
        .prepare(
          `INSERT INTO archived (pk, hash) VALUES (?, ?)
           ON CONFLICT(pk) DO UPDATE SET hash = excluded.hash`,
        )
        .run(key, sourceHash);
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

  // --- scenarios (derived; see plans/002) ----------------------------------

  /** Every stored event, for repricing / `compare`. */
  *allEvents() {
    for (const r of this.db.prepare("SELECT payload FROM outbox ORDER BY ts").all()) {
      yield JSON.parse(r.payload);
    }
  }

  /**
   * Upsert derived scenario rows. A changed cost (reprice, or a models.json
   * update) clears `synced` so the row re-ships; an unchanged one is left
   * alone so re-runs stay cheap.
   */
  recordScenarios(rows) {
    const stmt = this.db.prepare(
      `INSERT INTO outbox_scenario (pk, scenario, payload, synced)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(pk, scenario) DO UPDATE SET
         payload = excluded.payload,
         synced = CASE WHEN outbox_scenario.payload = excluded.payload
                       THEN outbox_scenario.synced ELSE 0 END`,
    );
    this.db.prepare("BEGIN").run();
    try {
      for (const row of rows) {
        const pk = `${row.harness}${row.session_id}${row.message_id}`;
        stmt.run(pk, row.scenario, JSON.stringify(row));
      }
      this.db.prepare("COMMIT").run();
    } catch (e) {
      this.db.prepare("ROLLBACK").run();
      throw e;
    }
  }

  unsyncedScenarios(limit = 200000) {
    return this.db
      .prepare(
        "SELECT pk, scenario, payload FROM outbox_scenario WHERE synced = 0 LIMIT ?",
      )
      .all(limit)
      .map((r) => ({ pk: r.pk, scenario: r.scenario, row: JSON.parse(r.payload) }));
  }

  markScenariosSynced(pairs) {
    if (!pairs.length) return;
    const stmt = this.db.prepare(
      "UPDATE outbox_scenario SET synced = 1 WHERE pk = ? AND scenario = ?",
    );
    this.db.prepare("BEGIN").run();
    try {
      for (const { pk, scenario } of pairs) stmt.run(pk, scenario);
      this.db.prepare("COMMIT").run();
    } catch (e) {
      this.db.prepare("ROLLBACK").run();
      throw e;
    }
  }

  /** Drop locally-queued rows for scenarios no longer configured. */
  pruneScenarios(keep) {
    const rows = this.db
      .prepare("SELECT DISTINCT scenario FROM outbox_scenario")
      .all()
      .map((r) => r.scenario);
    const stale = rows.filter((s) => !keep.includes(s));
    for (const s of stale) {
      this.db.prepare("DELETE FROM outbox_scenario WHERE scenario = ?").run(s);
    }
    return stale;
  }

  /**
   * Rewrite the JSONL archive keeping only the last line per event.
   *
   * Needed once, to clean up duplicates written before record() split the
   * archive hash from the ship hash. Last-wins matches how every consumer is
   * meant to read the archive, and the duplicate lines differ only in derived
   * pricing metadata, so nothing extracted is lost.
   *
   * Rewrites each day file atomically (temp file + rename).
   */
  compactArchive() {
    const files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".jsonl"));
    let linesBefore = 0;
    let linesAfter = 0;

    for (const f of files) {
      const path = join(this.eventsDir, f);
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
      linesBefore += lines.length;

      const lastByKey = new Map();
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          lastByKey.set(eventKey(e), line);
        } catch {
          // Unparseable line: keep it rather than silently discard data.
          lastByKey.set(`__raw__${lastByKey.size}`, line);
        }
      }

      const out = [...lastByKey.values()];
      linesAfter += out.length;
      if (out.length === lines.length) continue;

      const tmp = `${path}.tmp`;
      writeFileSync(tmp, out.join("\n") + "\n");
      renameSync(tmp, path);
    }

    return { files: files.length, linesBefore, linesAfter, removed: linesBefore - linesAfter };
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

/**
 * Canonical JSON of the EXTRACTED fields only — everything the harness told us,
 * with the derived pricing fields removed. This is what decides whether a line
 * is appended to the archive.
 */
function sourceOf(ev) {
  const out = {};
  for (const k of FIELD_ORDER) if (!DERIVED_FIELDS.has(k)) out[k] = ev[k];
  return JSON.stringify(out);
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
    -- Counterfactual scenario costs (plans/002). Unlike events these are
    -- DERIVED — recomputable at any time from the events plus the price table —
    -- so they are not written to the JSONL archive, only queued for shipping.
    CREATE TABLE IF NOT EXISTS outbox_scenario (
      pk        TEXT NOT NULL,
      scenario  TEXT NOT NULL,
      payload   TEXT NOT NULL,
      synced    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pk, scenario)
    );
    CREATE INDEX IF NOT EXISTS outbox_scenario_unsynced
      ON outbox_scenario (synced);
  `);
}
