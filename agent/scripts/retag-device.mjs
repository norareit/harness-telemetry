// Rewrite the `device` name on already-recorded events.
//
// For the case where a device synced under the wrong name — a fresh install
// whose config.json was copied from another machine and never edited, which is
// the one field config.example.json cannot default correctly.
//
// The mechanics (rewrite outbox payload + archive line + `archived` hash in
// step, refuse on a legacy hash, leave Postgres to the normal `sync` path) live
// in scripts/lib/rewrite-events.mjs and are shared with reroot-project.mjs; see
// there for WHY this is not a `backfill`. This file is the `device`-specific
// wrapper: it maps device FROM → TO and prints the report.
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
import { join } from "node:path";
import { DATA_DIR } from "../src/config.js";
import { rewriteEvents } from "./lib/rewrite-events.mjs";

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

const r = rewriteEvents({
  dataDir: DIR,
  map: (ev) => (ev.device === FROM ? { ...ev, device: TO } : null),
  apply: APPLY,
});

console.log(`data dir:      ${DIR}`);
console.log(`outbox rows:   ${r.examined}`);
console.log(`to retag:      ${r.changed}  (${FROM} -> ${TO})`);
console.log(
  `legacy hashes: ${r.legacy}${r.legacy ? "  <-- refusing: would re-append the archive" : ""}`,
);
if (r.legacy) process.exit(1);

console.log(`archive lines: ${r.archiveLines} across ${r.files} file(s)`);

if (!APPLY) {
  console.log("\ndry run — nothing written. Re-run with --apply.");
  process.exit(0);
}

const db = new DatabaseSync(join(DIR, "state.sqlite"), { readOnly: true });
const left = db.prepare("SELECT count(*) c FROM outbox WHERE device = ?").get(FROM).c;
const queued = db.prepare("SELECT count(*) c FROM outbox WHERE synced = 0").get().c;
db.close();
console.log(`\napplied. outbox still on '${FROM}': ${left}; queued to re-ship: ${queued}`);
console.log("run `harness-usage sync` to push the corrected rows to Postgres.");
