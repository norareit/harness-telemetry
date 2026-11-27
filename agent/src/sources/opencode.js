// OpenCode source — reads ~/.local/share/opencode/opencode.db (SQLite), and the
// same file under each extra home (plans/018).
//
// Opened READ-ONLY (`{ readOnly: true }`); SQLite readers do not block writers,
// so this is safe against a running OpenCode (verified against the live DB, 984
// messages, no locking issue).
//
// One row per assistant message; no dedupe needed — per-message token sums
// reconcile exactly with the session rollup columns.
//
// A database has a 1.x part, a 2.x part, or both (plans/025):
//
//   1.x (1.19.6): message(id, session_id, time_created, time_updated, data)
//                 session(id, directory, parent_id, workspace_id, tokens_*, ...)
//                 workspace(id, branch, ...)
//     `data` holds role/tokens/model (providerID, modelID) but NOT id/sessionID,
//     which are columns. 1.19.6 ALSO has an empty `session_message` whose
//     foreign key is on `session`, so that table alone does not mean 2.x.
//   2.x (2.4.2):  session_message(id, session_id, type, seq, time_created,
//                                 time_updated, data)
//                 session_v2(id, directory, parent_id, workspace_id, tokens_*, ...)
//     The role is the `type` column; `data` has no role, and the model is
//     data.model.{providerID, id, variant}. `workspace` is replaced by a table
//     without `branch`, so a branch is read only where 1.x's column exists.
//
// OpenCode 2 converts a 1.x database in the background and leaves the 1.x
// tables untouched. A converted message keeps its id, session id and
// time_updated, but 2.4.2 moves time.completed by 1 ms and stores compaction
// calls with no tokens at all. So a 2.x row whose id is also in `message` is
// skipped: converted messages are read from 1.x only, and would otherwise be
// re-recorded as `changed` (or lose their usage).
//
// tokens: { input, output, reasoning, cache:{read,write} } in both versions.
// Reasoning: for OpenCode/OpenAI it is a SEPARATE counter (verified: total ==
// input + output + reasoning + cache_read for 435 messages, and 0 the other
// way). We keep output_tokens exclusive of it and let pricing.js add it back at
// the output rate.
//
// Resume: a `time_updated` watermark per part. We re-read the boundary (>=)
// each run and rely on the idempotent PK upsert, so edited/streamed rows
// self-correct.

import { DatabaseSync } from "node:sqlite";
import { expandHome } from "../config.js";
import { databaseInHome, inputsFor, wellFormed } from "../homes.js";
import { projectRootOf } from "../project.js";

const HARNESS = "opencode";
// The 1.x keys are the original ones, so nothing is re-read after an upgrade.
const WATERMARK_KEY = { v1: "watermark:opencode:time_updated", v2: "watermark:opencode-v2:time_updated" };

/**
 * Which parts a database has, plus the two optional tables. Only ordinary
 * tables count: a view of one of these names could hide an arbitrarily
 * expensive query behind a plain SELECT.
 *
 * @returns {{v1: boolean, v2: boolean, branch: boolean, kv: boolean}}
 */
export function schemaOf(db) {
  const tables = new Set(
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'
           AND name IN ('message', 'session', 'workspace', 'session_v2', 'session_message', 'kv')`,
      )
      .all()
      .map((r) => r.name),
  );
  const branch =
    tables.has("workspace") &&
    db.prepare("SELECT 1 FROM pragma_table_info('workspace') WHERE name = 'branch'").get() !== undefined;
  return {
    v1: tables.has("message") && tables.has("session"),
    v2: tables.has("session_v2") && tables.has("session_message"),
    branch,
    kv: tables.has("kv"),
  };
}

const NOT_OPENCODE =
  "not an OpenCode database: needs message and session, or session_v2 and session_message, as tables";

// What extraction reads, per part.
function messageQuery(part, schema) {
  if (part === "v1") {
    return `SELECT
       m.id           AS message_id,
       m.session_id   AS session_id,
       m.time_updated AS time_updated,
       m.data         AS data,
       s.directory    AS session_dir,
       s.parent_id    AS parent_id,
       ${schema.branch ? "w.branch" : "NULL"} AS branch
     FROM message m
     JOIN session s ON s.id = m.session_id
     ${schema.branch ? "LEFT JOIN workspace w ON w.id = s.workspace_id" : ""}
     WHERE m.time_updated >= ?
     ORDER BY m.time_updated ASC`;
  }
  return `SELECT
     m.id           AS message_id,
     m.session_id   AS session_id,
     m.time_updated AS time_updated,
     m.data         AS data,
     s.directory    AS session_dir,
     s.parent_id    AS parent_id,
     NULL           AS branch
   FROM session_message m
   JOIN session_v2 s ON s.id = m.session_id
   WHERE m.type = 'assistant' AND m.time_updated >= ?
     ${schema.v1 ? "AND NOT EXISTS (SELECT 1 FROM message o WHERE o.id = m.id)" : ""}
   ORDER BY m.time_updated ASC`;
}

// The same rows from a home's database (plans/018), where a column may hold
// anything: SQLite does not enforce column types. A row is kept only when its
// key columns are text and its time is an integer JavaScript can represent —
// node:sqlite throws on a larger one, and it does so while fetching, before any
// check on our side could look at the row. The optional columns are passed on
// when they are text and read as NULL otherwise.
function homeMessageQuery(part, schema) {
  return `SELECT
     message_id, session_id, time_updated, data,
     CASE WHEN typeof(session_dir) = 'text' THEN session_dir END AS session_dir,
     CASE WHEN typeof(parent_id)   = 'text' THEN parent_id   END AS parent_id,
     CASE WHEN typeof(branch)      = 'text' THEN branch      END AS branch
   FROM (${messageQuery(part, schema)})
   WHERE typeof(message_id) = 'text'
     AND typeof(session_id) = 'text'
     AND typeof(data) = 'text'
     AND typeof(time_updated) = 'integer'
     AND time_updated BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
   ORDER BY time_updated ASC`;
}

const partsOf = (schema) => ["v1", "v2"].filter((p) => schema[p]);

export async function* extractOpenCode({ store, config, full = false }) {
  // plans/018: the device's own database, then one per extra home.
  for (const input of inputsFor(HARNESS, config)) {
    yield* extractDatabase({ store, config, full, input });
  }
}

async function* extractDatabase({ store, config, full, input }) {
  if (input.home) {
    yield* extractHomeDatabase({ store, full, input });
    return;
  }

  let db;
  try {
    db = new DatabaseSync(input.path, { readOnly: true });
  } catch (err) {
    if (err.code === "ERR_SQLITE_ERROR" || err.code === "ENOENT") return;
    throw err;
  }

  try {
    // Neither part: nothing to read here, and doctor's "opencode db" says why.
    const schema = schemaOf(db);

    // plans/008: same repository-root rule as Claude Code, applied here where
    // `config` is available. See extractClaudeCode for why not inside toEvent.
    const detectRoot = config.project?.detectRoot !== false;
    for (const part of partsOf(schema)) {
      const since = full ? 0 : Number(store.getKV(WATERMARK_KEY[part]) || 0);
      let maxWatermark = since;
      for (const row of db.prepare(messageQuery(part, schema)).all(since)) {
        maxWatermark = Math.max(maxWatermark, row.time_updated);
        const ev = toEvent(row, part);
        if (ev) {
          if (detectRoot) ev.project = projectRootOf(ev.project);
          yield ev;
        }
      }
      if (maxWatermark > since) store.setKV(WATERMARK_KEY[part], maxWatermark);
    }
  } finally {
    db.close();
  }
}

// The database of an extra home (plans/018). Its events are filed under the
// home's project. The watermarks are per database and part. Whatever goes wrong
// while reading it — not a database, not OpenCode's schema, a value SQLite or
// JavaScript cannot hand over — the database is skipped for this run and the
// other inputs are still read. doctor's "extra homes" check reads it the same
// way (readHomeDatabase) and reports the failure.
async function* extractHomeDatabase({ store, full, input }) {
  // Opened only when it, and any -wal/-shm beside it, really are files inside
  // the home.
  if (!databaseInHome(input.home, input.path)) return;

  const key = (part) => `${WATERMARK_KEY[part]}:${input.path}`;
  const since = {};
  for (const part of ["v1", "v2"]) since[part] = full ? 0 : Number(store.getKV(key(part)) || 0);
  let read;
  try {
    read = readHomeDatabase(input.path, since);
  } catch {
    return;
  }
  for (const ev of read.events) {
    ev.project = input.project;
    yield ev;
  }
  for (const part of ["v1", "v2"]) {
    if (read.watermarks[part] != null && read.watermarks[part] > since[part]) {
      store.setKV(key(part), read.watermarks[part]);
    }
  }
}

/**
 * The well-formed events of a home's database with `time_updated >= since`
 * (per part), and the highest `time_updated` read per part (null for a part
 * the database does not have). Throws when the file cannot be read as an
 * OpenCode database. Shared by the extractor and by `doctor`, so doctor judges
 * a database by exactly what extraction does with it; the caller must have
 * checked `databaseInHome` first.
 *
 * @param {{v1?: number, v2?: number}} since
 * @returns {{events: object[], watermarks: {v1: number|null, v2: number|null}}}
 */
export function readHomeDatabase(dbPath, since = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const schema = schemaOf(db);
    if (!schema.v1 && !schema.v2) throw new Error(NOT_OPENCODE);
    const events = [];
    const watermarks = { v1: null, v2: null };
    for (const part of partsOf(schema)) {
      let max = since[part] || 0;
      for (const row of db.prepare(homeMessageQuery(part, schema)).all(since[part] || 0)) {
        max = Math.max(max, row.time_updated);
        const ev = toEvent(row, part);
        if (ev && wellFormed(ev)) events.push(ev);
      }
      watermarks[part] = max;
    }
    return { events, watermarks };
  } finally {
    db.close();
  }
}

// Never throws: a row it cannot make an event of is null, like a row it would
// ignore. One such row must not end the read of the database.
function toEvent(row, part) {
  try {
    return toEventUnguarded(row, part);
  } catch {
    return null;
  }
}

function toEventUnguarded(row, part) {
  let d;
  try {
    d = JSON.parse(row.data);
  } catch {
    return null;
  }
  // Valid JSON need not be a message: `null`, a number, a string.
  if (!d || typeof d !== "object") return null;
  // 2.x has no role in `data`: its query selects assistant rows by `type`.
  if (part === "v1" && d.role !== "assistant") return null;
  if (!d.tokens || typeof d.tokens !== "object") return null;

  const t = d.tokens;
  const cache = t.cache || {};
  const tsMs = d.time?.completed || d.time?.created || row.time_updated;
  const { provider, model } = modelOf(d, part);

  return {
    harness: HARNESS,
    session_id: row.session_id,
    message_id: row.message_id,
    ts: tsMs,
    provider,
    model,
    agent: d.agent || d.mode || null,
    // Raw working directory; projectRootOf resolves it in the extractor.
    // NOT d.path?.root — OpenCode sets that to '/' when there is no repository,
    // which would make the two harnesses disagree on the rule (plans/008).
    project: row.session_dir || d.path?.cwd || null,
    git_branch: row.branch || null,
    is_sidechain: Boolean(row.parent_id),
    input_tokens: t.input ?? 0,
    output_tokens: t.output ?? 0, // already exclusive of reasoning
    reasoning_tokens: t.reasoning ?? 0,
    cache_read_tokens: cache.read ?? 0,
    cache_write_5m_tokens: cache.write ?? 0, // OpenCode has no TTL split
    cache_write_1h_tokens: 0,
  };
}

// 1.x: data.providerID / data.modelID. 2.x: data.model.{providerID, id}; the
// model's `variant` (the effort level) does not change the id pricing looks up.
function modelOf(d, part) {
  if (part === "v1") return { provider: d.providerID || null, model: d.modelID || null };
  const m = d.model && typeof d.model === "object" ? d.model : {};
  return { provider: m.providerID || null, model: m.id || null };
}

/**
 * Distinct (providerID, modelID) pairs across assistant messages of both
 * parts. Read-only, for `doctor`'s "models priced" check — so it reads the
 * OpenCode DB the same way the extractor does rather than keeping its own copy
 * of the loop.
 */
export function listModels(dbPath) {
  const db = new DatabaseSync(expandHome(dbPath), { readOnly: true });
  const combos = new Set();
  try {
    const schema = schemaOf(db);
    const sql = {
      v1: "SELECT data FROM message",
      v2: "SELECT data FROM session_message WHERE type = 'assistant'",
    };
    for (const part of partsOf(schema)) {
      for (const r of db.prepare(sql[part]).all()) {
        let d;
        try {
          d = JSON.parse(r.data);
        } catch {
          continue;
        }
        if (!d || typeof d !== "object" || (part === "v1" && d.role !== "assistant")) continue;
        const { provider, model } = modelOf(d, part);
        if (model) combos.add(`${provider}\t${model}`);
      }
    }
  } finally {
    db.close();
  }
  return [...combos].map((c) => c.split("\t"));
}

/**
 * Read-only helper for `doctor`: per-session sums vs the session rollup
 * columns, per part. 1.x is checked over `session`. 2.x only over the sessions
 * OpenCode 2 created (not in `session`): a converted session's 2.x rows lack
 * its compaction calls' tokens, while its rollups equal 1.x's.
 *
 * @returns {{v1: object|null, v2: object|null}} each {total, ok, mismatches},
 *   null for a part the database does not have.
 */
export function reconcile(dbPath) {
  const db = new DatabaseSync(expandHome(dbPath), { readOnly: true });
  try {
    const schema = schemaOf(db);
    return {
      v1: schema.v1
        ? reconcilePart(db, "SELECT * FROM session", "SELECT data FROM message WHERE session_id = ?", "v1")
        : null,
      v2: schema.v2
        ? reconcilePart(
            db,
            `SELECT * FROM session_v2 ${schema.v1 ? "WHERE id NOT IN (SELECT id FROM session)" : ""}`,
            "SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant'",
            "v2",
          )
        : null,
    };
  } finally {
    db.close();
  }
}

function reconcilePart(db, sessionsSql, messagesSql, part) {
  const sessions = db.prepare(sessionsSql).all();
  const messages = db.prepare(messagesSql);
  let ok = 0;
  const mismatches = [];
  for (const s of sessions) {
    const msgs = messages
      .all(s.id)
      .map((r) => {
        try {
          return JSON.parse(r.data);
        } catch {
          return null;
        }
      })
      .filter((d) => d && d.tokens && (part === "v2" || d.role === "assistant"));

    const sum = (f) => msgs.reduce((a, d) => a + (f(d.tokens) || 0), 0);
    const got = {
      input: sum((t) => t.input),
      output: sum((t) => t.output),
      reasoning: sum((t) => t.reasoning),
      cache_read: sum((t) => t.cache?.read),
      cache_write: sum((t) => t.cache?.write),
    };
    const want = {
      input: s.tokens_input,
      output: s.tokens_output,
      reasoning: s.tokens_reasoning,
      cache_read: s.tokens_cache_read,
      cache_write: s.tokens_cache_write,
    };
    if (Object.keys(got).every((k) => got[k] === want[k])) ok++;
    else mismatches.push({ session: s.id, got, want });
  }
  return { total: sessions.length, ok, mismatches };
}

/**
 * Row counts per part and OpenCode 2's conversion phase, for `doctor`'s
 * "opencode db" check. Throws on a database with neither part.
 */
export function describeDatabase(dbPath) {
  const db = new DatabaseSync(expandHome(dbPath), { readOnly: true });
  try {
    const schema = schemaOf(db);
    if (!schema.v1 && !schema.v2) throw new Error(NOT_OPENCODE);
    const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    return {
      v1: schema.v1 ? { messages: count("message"), sessions: count("session") } : null,
      v2: schema.v2 ? { messages: count("session_message"), sessions: count("session_v2") } : null,
      phase: conversionPhase(db, schema),
    };
  } finally {
    db.close();
  }
}

/**
 * The `phase` of kv row `migration.v1-v2` (2.4.2 writes "completed" when the
 * conversion is done), or null: no `kv` table (every 1.19.6 database), no such
 * row, or a value that is not an object with a text phase.
 */
export function conversionPhase(db, schema = schemaOf(db)) {
  if (!schema.kv) return null;
  const row = db.prepare("SELECT value FROM kv WHERE key = 'migration.v1-v2'").get();
  if (!row || typeof row.value !== "string") return null;
  try {
    const phase = JSON.parse(row.value)?.phase;
    return typeof phase === "string" ? phase : null;
  } catch {
    return null;
  }
}
