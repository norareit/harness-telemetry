// Shared mechanics for the one-off repair scripts (plans/008).
//
// The local store is three things that must agree — the outbox payload, the
// JSONL archive line, and the `archived` source hash. A repair changes a source
// field on already-recorded events, so it must rewrite all three in step: then
// the next record() sees an identical payload AND hash (state 'unchanged',
// nothing re-appended), and `sync` ships the corrected rows because the changed
// field is in the sink's ON CONFLICT update set while the PK is unchanged.
//
// This is deliberately NOT a `backfill`: (1) a source-field change makes
// record() append a SECOND archive line per event, and (2) backfill only reaches
// events still inside the harness's retention (~30 days for Claude Code), while
// the archive — the whole reason it exists — outlives that. Rewriting in place
// avoids both.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { HASH_VERSION, orderFields, sourceHash } from "../../src/archive.js";
import { eventDay } from "../../src/record.js";

/**
 * Rewrite already-recorded events in place. `map(ev)` returns the new event, or
 * null/undefined to leave that event alone. `map` must not change the identity
 * fields (harness, session_id, message_id) — the primary key must stay put.
 *
 * Refuses to write while any legacy (pre-v2) archive hash exists: such a row is
 * already on disk under the old hash, and rewriting it would take the
 * "re-stamp without appending" branch away from record() and duplicate the
 * archive. On legacy, the returned `legacy` count is > 0 and nothing is written
 * even with apply=true — the caller reports and exits.
 *
 * @returns {{ examined:number, changed:number, archiveLines:number, files:number, legacy:number }}
 */
export function rewriteEvents({ dataDir, map, apply = false }) {
  const db = new DatabaseSync(join(dataDir, "state.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  try {
    const legacy = db
      .prepare("SELECT count(*) c FROM archived WHERE hash NOT LIKE ?")
      .get(`${HASH_VERSION}%`).c;

    // --- outbox targets ---
    const rows = db.prepare("SELECT pk, payload FROM outbox").all();
    const targets = [];
    for (const r of rows) {
      const ev = JSON.parse(r.payload);
      const next = map(ev);
      if (!next) continue;
      targets.push({
        pk: r.pk,
        harness: next.harness,
        device: next.device,
        day: eventDay(next),
        ts: next.ts,
        payload: JSON.stringify(orderFields(next)),
        hash: sourceHash(next),
      });
    }

    // --- archive rewrites ---
    const eventsDir = join(dataDir, "events");
    let archiveLines = 0;
    const rewrites = [];
    let files;
    try {
      files = readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      files = [];
    }
    for (const f of files) {
      const path = join(eventsDir, f);
      let hits = 0;
      const out = readFileSync(path, "utf8")
        .split("\n")
        .map((line) => {
          if (!line.trim()) return line;
          const next = map(JSON.parse(line));
          if (!next) return line;
          hits++;
          return JSON.stringify(orderFields(next));
        });
      if (hits) {
        archiveLines += hits;
        rewrites.push({ path, content: out.join("\n") });
      }
    }

    const result = {
      examined: rows.length,
      changed: targets.length,
      archiveLines,
      files: rewrites.length,
      legacy,
    };

    // Refuse to write on a legacy hash, or on a dry run.
    if (!apply || legacy) return result;

    // Archive first — it is the durable copy, and rewriting a line is
    // idempotent. Via a temp file so a torn write cannot truncate a day.
    for (const { path, content } of rewrites) {
      writeFileSync(`${path}.tmp`, content);
      renameSync(`${path}.tmp`, path);
    }

    const setOutbox = db.prepare(
      `UPDATE outbox SET harness = ?, device = ?, day = ?, ts = ?, payload = ?, synced = 0 WHERE pk = ?`,
    );
    const setHash = db.prepare("UPDATE archived SET hash = ? WHERE pk = ?");
    db.prepare("BEGIN").run();
    try {
      for (const t of targets) {
        setOutbox.run(t.harness, t.device, t.day, t.ts, t.payload, t.pk);
        setHash.run(t.hash, t.pk);
      }
      db.prepare("COMMIT").run();
    } catch (e) {
      db.prepare("ROLLBACK").run();
      throw e;
    }

    return result;
  } finally {
    db.close();
  }
}
