// Rewrite the `device` name on already-recorded events.
//
// For the case where a device synced under the wrong name — a fresh install
// whose config.json was copied from another machine and never edited, which is
// the one field config.example.json cannot default correctly.
//
// --- Why this is not just `backfill` -----------------------------------------
//
// Two reasons, both measured on a real store:
//
// 1. `device` is not a DERIVED_FIELD, so it is part of sourceOf(): re-recording
//    an event under a new name changes its source hash, and record() appends a
//    SECOND archive line for it. A backfill to fix 1,154 names took the archive
//    from 1,161 lines to 2,320 — the same duplication that plans/003 and
//    local-store.js already warn about.
//
// 2. It only reaches events still extractable from their source. Claude Code
//    prunes transcripts after ~30 days, and the archive outliving them is the
//    entire reason it exists, so on an older store a backfill silently leaves
//    the pruned events on the wrong name forever.
//
// A plain `sync` fixes nothing either: the device is stamped only on the
// extraction path (`config.device`), and an event already in the outbox is
// re-extracted from source, not rewritten from the stored payload — so a device
// rename never propagates to events whose source has since been pruned.
//
// --- What it does instead ----------------------------------------------------
//
// Rewrites the outbox payload, the archive line, and the `archived` hash
// together, so the next record() sees an identical payload AND an identical
// hash: state 'unchanged', nothing appended. Clearing `synced` is all that is
// needed for Postgres — `device` is in the sink's ON CONFLICT UPDATE set while
// the PK is (harness, session_id, message_id), so the normal sync path updates
// the existing rows in place. Rows belonging to other devices are never touched,
// and this script never talks to Postgres itself.
//
// --- Use ---------------------------------------------------------------------
//
//   launchctl bootout gui/$(id -u)/com.ritenoar.harness-usage   # or: systemctl --user stop
//   cp -R ~/.local/share/harness-usage ~/.local/share/harness-usage.bak
//   node agent/scripts/retag-device.mjs --from OLD --to NEW          # dry run
//   node agent/scripts/retag-device.mjs --from OLD --to NEW --apply
//   harness-usage sync
//   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ritenoar.harness-usage.plist
//
// Without --apply it reports what it would change and writes nothing. Verify
// afterwards with `harness-usage show` and a GROUP BY device against Postgres.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config.js";
import { HASH_VERSION, orderFields, sourceHash } from "../src/archive.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const APPLY = args.includes("--apply");
const FROM = opt("--from");
const TO = opt("--to");
const DIR = opt("--data-dir", DATA_DIR);

if (!FROM || !TO) {
  console.error(
    "usage: retag-device.mjs --from OLD --to NEW [--data-dir DIR] [--apply]",
  );
  process.exit(2);
}

// orderFields / sourceHash / HASH_VERSION come from src/archive.js — the same
// code record() uses, so a rewritten line and hash match exactly what the next
// sync expects (state 'unchanged', nothing re-appended). They used to be
// re-implemented here, which is the classic symptom of a missing module.

const db = new DatabaseSync(join(DIR, "state.sqlite"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

const rows = db.prepare("SELECT pk, payload FROM outbox").all();
const targets = [];
for (const r of rows) {
  const ev = JSON.parse(r.payload);
  if (ev.device !== FROM) continue;
  ev.device = TO;
  targets.push({
    pk: r.pk,
    payload: JSON.stringify(orderFields(ev)),
    hash: sourceHash(ev),
  });
}

// Every archived row must already carry a current-version hash. A legacy one
// takes the "already on disk, re-stamp without appending" branch in record();
// rewriting it here would throw that protection away and re-append the archive.
const legacy = db
  .prepare("SELECT count(*) c FROM archived WHERE hash NOT LIKE ?")
  .get(`${HASH_VERSION}%`).c;

console.log(`data dir:      ${DIR}`);
console.log(`outbox rows:   ${rows.length}`);
console.log(`to retag:      ${targets.length}  (${FROM} -> ${TO})`);
console.log(
  `legacy hashes: ${legacy}${legacy ? "  <-- refusing: would re-append the archive" : ""}`,
);
if (legacy) process.exit(1);

// --- archive ---------------------------------------------------------------

const eventsDir = join(DIR, "events");
let lineHits = 0;
const rewrites = [];
for (const f of readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl"))) {
  const path = join(eventsDir, f);
  let hits = 0;
  const out = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      const ev = JSON.parse(line);
      if (ev.device !== FROM) return line;
      hits++;
      ev.device = TO;
      return JSON.stringify(orderFields(ev));
    });
  if (hits) {
    lineHits += hits;
    rewrites.push({ path, content: out.join("\n") });
  }
}
console.log(`archive lines: ${lineHits} across ${rewrites.length} file(s)`);

if (!APPLY) {
  console.log("\ndry run — nothing written. Re-run with --apply.");
  db.close();
  process.exit(0);
}

// --- apply -----------------------------------------------------------------

// Archive first: it is the durable copy, and rewriting a line is idempotent.
// Via a temp file, so a torn write cannot truncate a day of history.
for (const { path, content } of rewrites) {
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}

const setOutbox = db.prepare(
  "UPDATE outbox SET device = ?, payload = ?, synced = 0 WHERE pk = ?",
);
const setHash = db.prepare("UPDATE archived SET hash = ? WHERE pk = ?");
db.prepare("BEGIN").run();
try {
  for (const t of targets) {
    setOutbox.run(TO, t.payload, t.pk);
    setHash.run(t.hash, t.pk);
  }
  db.prepare("COMMIT").run();
} catch (e) {
  db.prepare("ROLLBACK").run();
  throw e;
}

const left = db.prepare("SELECT count(*) c FROM outbox WHERE device = ?").get(FROM).c;
const queued = db.prepare("SELECT count(*) c FROM outbox WHERE synced = 0").get().c;
console.log(`\napplied. outbox still on '${FROM}': ${left}; queued to re-ship: ${queued}`);
console.log("run `harness-usage sync` to push the corrected rows to Postgres.");
db.close();
