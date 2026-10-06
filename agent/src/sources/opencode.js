// OpenCode source — reads ~/.local/share/opencode/opencode.db (SQLite), and the
// same file under each extra home (plans/018).
//
// Opened READ-ONLY (`{ readOnly: true }`); SQLite readers do not block writers,
// so this is safe against a running OpenCode (verified against the live DB, 984
// messages, no locking issue).
//
// One row per assistant message; no dedupe needed — per-message token sums
// reconcile exactly with the `session` rollup columns for all 82/82 sessions.
//
// Schema notes (OpenCode 1.18.29):
//   message(id, session_id, time_created, time_updated, data JSON)
//   session(id, directory, title, parent_id, workspace_id, agent, model, ...)
//   workspace(id, branch, directory, ...)
// The message `data` JSON holds role/tokens/cost/model but NOT id/sessionID —
// those are table columns. tokens: { input, output, reasoning, cache:{read,write} }.
//
// Reasoning: for OpenCode/OpenAI it is a SEPARATE counter (verified: total ==
// input + output + reasoning + cache_read for 435 messages, and 0 the other
// way). We keep output_tokens exclusive of it and let pricing.js add it back at
// the output rate for non-Anthropic providers.
//
// Resume: a `time_updated` watermark. We re-read the boundary (>=) each run and
// rely on the idempotent PK upsert, so edited/streamed rows self-correct.

import { DatabaseSync } from "node:sqlite";
import { expandHome } from "../config.js";
import { databaseInHome, inputsFor, wellFormed } from "../homes.js";
import { projectRootOf } from "../project.js";

const HARNESS = "opencode";
const WATERMARK_KEY = "watermark:opencode:time_updated";

// What extraction reads.
const MESSAGE_QUERY = `SELECT
     m.id           AS message_id,
     m.session_id   AS session_id,
     m.time_updated AS time_updated,
     m.data         AS data,
     s.directory    AS session_dir,
     s.parent_id    AS parent_id,
     w.branch       AS branch
   FROM message m
   JOIN session s ON s.id = m.session_id
   LEFT JOIN workspace w ON w.id = s.workspace_id
   WHERE m.time_updated >= ?
   ORDER BY m.time_updated ASC`;

// The same rows from a home's database (plans/018), where a column may hold
// anything: SQLite does not enforce column types. A row is kept only when its
// key columns are text and its time is an integer JavaScript can represent —
// node:sqlite throws on a larger one, and it does so while fetching, before any
// check on our side could look at the row. The optional columns are passed on
// when they are text and read as NULL otherwise.
const HOME_MESSAGE_QUERY = `SELECT
     message_id, session_id, time_updated, data,
     CASE WHEN typeof(session_dir) = 'text' THEN session_dir END AS session_dir,
     CASE WHEN typeof(parent_id)   = 'text' THEN parent_id   END AS parent_id,
     CASE WHEN typeof(branch)      = 'text' THEN branch      END AS branch
   FROM (${MESSAGE_QUERY})
   WHERE typeof(message_id) = 'text'
     AND typeof(session_id) = 'text'
     AND typeof(data) = 'text'
     AND typeof(time_updated) = 'integer'
     AND time_updated BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
   ORDER BY time_updated ASC`;

// The three names the query reads must be ordinary tables. A view of that name
// could hide an arbitrarily expensive query behind a plain SELECT.
const HOME_TABLES_QUERY = `SELECT COUNT(*) AS c FROM sqlite_master
   WHERE type = 'table' AND name IN ('message', 'session', 'workspace')
     AND sql NOT LIKE 'CREATE VIRTUAL%'`;

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
    const since = full ? 0 : Number(store.getKV(WATERMARK_KEY) || 0);
    const rows = db.prepare(MESSAGE_QUERY).all(since);

    // plans/008: same repository-root rule as Claude Code, applied here where
    // `config` is available. See extractClaudeCode for why not inside toEvent.
    const detectRoot = config.project?.detectRoot !== false;
    let maxWatermark = since;
    for (const row of rows) {
      maxWatermark = Math.max(maxWatermark, row.time_updated);
      const ev = toEvent(row);
      if (ev) {
        if (detectRoot) ev.project = projectRootOf(ev.project);
        yield ev;
      }
    }

    if (maxWatermark > since) store.setKV(WATERMARK_KEY, maxWatermark);
  } finally {
    db.close();
  }
}

// The database of an extra home (plans/018). Its events are filed under the
// home's project. The watermark is per database; the device's own keeps the
// original key, so nothing is re-read after an upgrade. Whatever goes wrong
// while reading it — not a database, not OpenCode's schema, a value SQLite or
// JavaScript cannot hand over — the database is skipped for this run and the
// other inputs are still read. doctor's "extra homes" check reads it the same
// way (readHomeDatabase) and reports the failure.
async function* extractHomeDatabase({ store, full, input }) {
  // Opened only when it, and any -wal/-shm beside it, really are files inside
  // the home.
  if (!databaseInHome(input.home, input.path)) return;

  const watermarkKey = `${WATERMARK_KEY}:${input.path}`;
  const since = full ? 0 : Number(store.getKV(watermarkKey) || 0);
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
  if (read.maxWatermark > since) store.setKV(watermarkKey, read.maxWatermark);
}

/**
 * The well-formed events of a home's database with `time_updated >= since`,
 * and the highest `time_updated` among the rows read. Throws when the file
 * cannot be read as an OpenCode database. Shared by the extractor and by
 * `doctor`, so doctor judges a database by exactly what extraction does with
 * it; the caller must have checked `databaseInHome` first.
 *
 * @returns {{events: object[], maxWatermark: number}}
 */
export function readHomeDatabase(dbPath, since = 0) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (db.prepare(HOME_TABLES_QUERY).get().c !== 3) {
      throw new Error("not an OpenCode database: message, session and workspace must be tables");
    }
    const events = [];
    let maxWatermark = since;
    for (const row of db.prepare(HOME_MESSAGE_QUERY).all(since)) {
      maxWatermark = Math.max(maxWatermark, row.time_updated);
      const ev = toEvent(row);
      if (ev && wellFormed(ev)) events.push(ev);
    }
    return { events, maxWatermark };
  } finally {
    db.close();
  }
}

// Never throws: a row it cannot make an event of is null, like a row it would
// ignore. One such row must not end the read of the database.
function toEvent(row) {
  try {
    return toEventUnguarded(row);
  } catch {
    return null;
  }
}

function toEventUnguarded(row) {
  let d;
  try {
    d = JSON.parse(row.data);
  } catch {
    return null;
  }
  // Valid JSON need not be a message: `null`, a number, a string.
  if (!d || typeof d !== "object") return null;
  if (d.role !== "assistant" || !d.tokens || typeof d.tokens !== "object") return null;

  const t = d.tokens;
  const cache = t.cache || {};
  const tsMs = d.time?.completed || d.time?.created || row.time_updated;

  return {
    harness: HARNESS,
    session_id: row.session_id,
    message_id: row.message_id,
    ts: tsMs,
    provider: d.providerID || null,
    model: d.modelID || null,
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

/**
 * Distinct (providerID, modelID) pairs across assistant messages. Read-only,
 * for `doctor`'s "models priced" check — so it reads the OpenCode DB the same
 * way the extractor does rather than keeping its own copy of the loop.
 */
export function listModels(dbPath) {
  const db = new DatabaseSync(expandHome(dbPath), { readOnly: true });
  const combos = new Set();
  try {
    for (const r of db.prepare("SELECT data FROM message").all()) {
      let d;
      try {
        d = JSON.parse(r.data);
      } catch {
        continue;
      }
      if (d.role === "assistant" && d.modelID) combos.add(`${d.providerID}\t${d.modelID}`);
    }
  } finally {
    db.close();
  }
  return [...combos].map((c) => c.split("\t"));
}

/** Read-only helper for `doctor`: per-session sums vs the session rollup columns. */
export function reconcile(dbPath) {
  const db = new DatabaseSync(expandHome(dbPath), { readOnly: true });
  try {
    const sessions = db
      .prepare(
        `SELECT id, tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write
         FROM session`,
      )
      .all();

    let ok = 0;
    const mismatches = [];
    for (const s of sessions) {
      const msgs = db
        .prepare("SELECT data FROM message WHERE session_id = ?")
        .all(s.id)
        .map((r) => {
          try {
            return JSON.parse(r.data);
          } catch {
            return null;
          }
        })
        .filter((d) => d && d.role === "assistant" && d.tokens);

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
      if (
        got.input === want.input &&
        got.output === want.output &&
        got.reasoning === want.reasoning &&
        got.cache_read === want.cache_read &&
        got.cache_write === want.cache_write
      ) {
        ok++;
      } else {
        mismatches.push({ session: s.id, got, want });
      }
    }
    return { total: sessions.length, ok, mismatches };
  } finally {
    db.close();
  }
}
