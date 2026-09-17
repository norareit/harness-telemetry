// The JSONL archive — events/YYYY-MM-DD.jsonl, one canonical event per line,
// jq-friendly. Given that Claude Code prunes its own transcripts after ~30 days,
// this is the only durable history past that window, so it is written on every
// sync regardless of whether Postgres is reachable.
//
// This module owns the FILE FORMAT and nothing else: no SQLite, no knowledge of
// `synced`. The store (local-store.js) owns state.sqlite and holds an Archive;
// the `archived` table that answers "is this event's current source data
// already on disk" is store state ABOUT the archive and stays there.
//
// A line is appended only when the SOURCE data (token counts and the rest of the
// harness's own fields) is new or changed — never for a reprice, since costs are
// derived. `sourceHash` is what record() compares to decide that; `orderFields`
// is the on-disk shape; `sourceOf` is the subset that the hash is taken over.

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
import { makeEvent, eventKey, eventDay, FIELD_ORDER, DERIVED_FIELDS } from "./record.js";

// Prefix on stored archive hashes. Bumped when the hash BASIS changes, so a
// legacy hash can be recognised and re-stamped without re-appending the line.
export const HASH_VERSION = "v2:";

/** The on-disk shape of an archived line: FIELD_ORDER-ordered. */
export function orderFields(ev) {
  const out = {};
  for (const k of FIELD_ORDER) out[k] = ev[k];
  return out;
}

/**
 * Canonical JSON of the EXTRACTED fields only — everything the harness told us,
 * with the derived pricing fields removed. This is what decides whether a line
 * is appended to the archive: the archive's job is preserving token counts,
 * which never change; costs are derived and recomputable.
 */
export function sourceOf(ev) {
  const out = {};
  for (const k of FIELD_ORDER) if (!DERIVED_FIELDS.has(k)) out[k] = ev[k];
  return JSON.stringify(out);
}

/** The stored archive hash for an event: version prefix + sha1 of its source. */
export function sourceHash(ev) {
  return HASH_VERSION + createHash("sha1").update(sourceOf(ev)).digest("hex");
}

export class Archive {
  constructor({ eventsDir }) {
    this.eventsDir = eventsDir;
    mkdirSync(eventsDir, { recursive: true });
  }

  /** Append one event as a line in its day's shard. */
  append(ev) {
    appendFileSync(
      join(this.eventsDir, `${eventDay(ev)}.jsonl`),
      JSON.stringify(orderFields(ev)) + "\n",
    );
  }

  /** The *.jsonl shard paths, sorted. */
  *files() {
    for (const f of readdirSync(this.eventsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()) {
      yield join(this.eventsDir, f);
    }
  }

  /**
   * Read the whole archive last-wins per event key. Returns
   * { lastByKey: Map<key, event>, unreadable, files }. Events are makeEvent'd,
   * so a caller gets canonical shapes back.
   */
  readAll() {
    const lastByKey = new Map();
    let unreadable = 0;
    let files = 0;
    for (const path of this.files()) {
      files++;
      const lines = readFileSync(path, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = makeEvent(JSON.parse(line));
          lastByKey.set(eventKey(ev), ev);
        } catch {
          unreadable++;
        }
      }
    }
    return { lastByKey, unreadable, files };
  }

  /**
   * Rewrite each shard keeping only the last line per event.
   *
   * Needed once, to clean up duplicates written before record() split the
   * archive hash from the ship hash. Last-wins matches how every consumer is
   * meant to read the archive, and the duplicate lines differ only in derived
   * pricing metadata, so nothing extracted is lost. Rewrites atomically
   * (temp file + rename).
   */
  compact() {
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
}
