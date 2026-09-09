// OpenCode source — reads ~/.local/share/opencode/opencode.db (SQLite).
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

const HARNESS = "opencode";
const WATERMARK_KEY = "watermark:opencode:time_updated";

export async function* extractOpenCode({ store, config, full = false }) {
  const dbPath = expandHome(
    config.sources.opencode.db || "~/.local/share/opencode/opencode.db",
  );

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    if (err.code === "ERR_SQLITE_ERROR" || err.code === "ENOENT") return;
    throw err;
  }

  try {
    const since = full ? 0 : Number(store.getKV(WATERMARK_KEY) || 0);

    const rows = db
      .prepare(
        `SELECT
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
         ORDER BY m.time_updated ASC`,
      )
      .all(since);

    let maxWatermark = since;
    for (const row of rows) {
      maxWatermark = Math.max(maxWatermark, row.time_updated);
      const ev = toEvent(row);
      if (ev) yield ev;
    }

    if (maxWatermark > since) store.setKV(WATERMARK_KEY, maxWatermark);
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
  if (d.role !== "assistant" || !d.tokens) return null;

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
    project: row.session_dir || d.path?.root || d.path?.cwd || null,
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
