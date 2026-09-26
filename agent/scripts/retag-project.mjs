// Re-file whole sessions under a different project (plans/014).
//
// `project` is the session's working directory (resolved to its repo root), so
// work done for one project from another project's directory is filed under the
// wrong one. This moves every event of the named sessions to `--to`.
//
// Mechanics are shared with retag-device.mjs in scripts/lib/rewrite-events.mjs.
//
// NOTE: a `backfill` re-extracts from the transcripts, where the cwd is still
// the old directory, and so REVERTS this retag. Normal syncs read from their
// byte cursor and never do. After a backfill, run this again.
//
// --- Use ---------------------------------------------------------------------
//
//   systemctl --user stop harness-usage.timer     # or: launchctl bootout …
//   cp -R ~/.local/share/harness-usage ~/.local/share/harness-usage.bak
//   node agent/scripts/retag-project.mjs --to ~/projects/agent-kit ID…            # dry run
//   node agent/scripts/retag-project.mjs --to ~/projects/agent-kit ID… --apply
//   harness-usage sync
//
// Session ids are full ids (the transcript file name without .jsonl) and match
// exactly. Any id that matches no event aborts the run before anything is written.

import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { DATA_DIR } from "../src/config.js";
import { projectRootOf } from "../src/project.js";
import { rewriteEvents, retagSessions } from "./lib/rewrite-events.mjs";

const args = process.argv.slice(2);
const VALUED = ["--to", "--data-dir"];
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const APPLY = args.includes("--apply");
const TO = opt("--to") && resolve(opt("--to"));
const DIR = opt("--data-dir", DATA_DIR);
const SESSIONS = args.filter((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1]));

if (!TO || !SESSIONS.length) {
  console.error("usage: retag-project.mjs --to DIR [--data-dir DIR] [--apply] SESSION_ID…");
  process.exit(2);
}
if (projectRootOf(TO) !== TO) {
  console.error(`--to ${TO} is not a project root (it resolves to ${projectRootOf(TO)}).`);
  process.exit(2);
}

// The review table, straight from the outbox: per session, its events and
// current project(s).
const db = new DatabaseSync(join(DIR, "state.sqlite"), { readOnly: true });
const perSession = db.prepare(
  `SELECT json_extract(payload,'$.project') AS project, COUNT(*) AS events
   FROM outbox WHERE json_extract(payload,'$.session_id') = ? GROUP BY 1`,
);
const missing = [];
console.log(`data dir: ${DIR}\nto:       ${TO}\n`);
for (const id of SESSIONS) {
  const rows = perSession.all(id);
  if (!rows.length) missing.push(id);
  for (const r of rows) console.log(`  ${String(r.events).padStart(6)}  ${id}  ${r.project}`);
}
db.close();
if (missing.length) {
  console.log(`\nno events for ${missing.length} session id(s) — refusing:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

const r = rewriteEvents({ dataDir: DIR, map: retagSessions(SESSIONS, TO), apply: APPLY });

console.log(
  `\noutbox rows:   ${r.examined}\nto retag:      ${r.changed}\n` +
    `archive lines: ${r.archiveLines} across ${r.files} file(s)`,
);
if (r.legacy) {
  console.log(`legacy hashes: ${r.legacy}  <-- refusing: would re-append the archive`);
  process.exit(1);
}

if (!APPLY) {
  console.log("\ndry run — nothing written. Re-run with --apply.");
  process.exit(0);
}
console.log("\napplied. Run `harness-usage sync` to push the corrected rows to Postgres.");
