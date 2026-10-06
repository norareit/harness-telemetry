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

// What extraction reads. Shared with `readableMessages`, so that doctor judges
// a database by the very query the extractor will run against it.
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

export async function* extractOpenCode({ store, config, full = false }) {
  // plans/018: the device's own database, then one per extra home.
  for (const input of inputsFor(HARNESS, config)) {
    yield* extractDatabase({ store, config, full, input });
  }
}

async function* extractDatabase({ store, config, full, input }) {
  // A home's content is untrusted (plans/018): its database is opened only
  // when it, and any -wal/-shm beside it, really are files inside the home.
  if (input.home && !databaseInHome(input.home, input.path)) return;

  // The watermark is per database. The device's own keeps the original key, so
  // nothing is re-read after an upgrade.
  const watermarkKey = input.home ? `${WATERMARK_KEY}:${input.path}` : WATERMARK_KEY;

  let db;
  try {
    db = new DatabaseSync(input.path, { readOnly: true });
  } catch (err) {
    if (err.code === "ERR_SQLITE_ERROR" || err.code === "ENOENT") return;
    throw err;
  }

  try {
    const since = full ? 0 : Number(store.getKV(watermarkKey) || 0);

    let rows;
    try {
      rows = db.prepare(MESSAGE_QUERY).all(since);
    } catch (err) {
      // A home's database that is not an OpenCode database (or not a database
      // at all) is skipped, and the other inputs are still read. The device's
      // own failing here is a real fault and stays loud.
      if (input.home && err.code === "ERR_SQLITE_ERROR") return;
      throw err;
    }

    // plans/008: same repository-root rule as Claude Code, applied here where
    // `config` is available. See extractClaudeCode for why not inside toEvent.
    const detectRoot = config.project?.detectRoot !== false;
    let maxWatermark = since;
    for (const row of rows) {
      // SQLite columns are untyped: a home's row may hold anything here.
      if (input.home && !Number.isSafeInteger(row.time_updated)) continue;
      maxWatermark = Math.max(maxWatermark, row.time_updated);
      const ev = toEvent(row);
      if (!ev) continue;
      if (input.home) {
        // Untrusted content (plans/018): drop what is not well formed rather
        // than let one row abort the sync of everything else.
        if (!wellFormed(ev)) continue;
        ev.project = input.project;
      } else if (detectRoot) {
        ev.project = projectRootOf(ev.project);
      }
      yield ev;
    }

    if (maxWatermark > since) store.setKV(watermarkKey, maxWatermark);
  } finally {
    db.close();
  }
}

function toEvent(row) {
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
 * How many messages the extractor's own query returns from a database, for
 * `doctor`'s "extra homes" check. Throws when the database cannot be opened or
 * lacks a table or column extraction needs — a count over `message` alone
 * would call such a database healthy while extraction read nothing from it.
 */
export function readableMessages(dbPath) {
  const db = new DatabaseSync(expandHome(dbPath), { readOnly: true });
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM (${MESSAGE_QUERY})`).get(0).c;
  } finally {
    db.close();
  }
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
