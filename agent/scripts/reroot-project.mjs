// Re-file already-recorded events under their repository root (plans/008).
//
// Before plan 008 `project` was the raw working directory, so subdirectories of
// one repo were split apart on the dashboard (`harness-telemetry`, `agent`,
// `server`, `src`). New events are filed correctly by the extractors; THIS
// rewrites the ones already stored, in place, so they join their repo.
//
// It must run on the device the events came from: projectRootOf walks THAT
// machine's filesystem for `.git`, and a path from another machine (or a deleted
// scratch dir) resolves to itself and is left alone — which is correct, it can
// only be repaired where the files still are.
//
// Mechanics (and why this is not a `backfill`) are shared with retag-device.mjs
// in scripts/lib/rewrite-events.mjs.
//
// --- Use ---------------------------------------------------------------------
//
//   systemctl --user stop harness-usage.timer     # or: launchctl bootout …
//   cp -R ~/.local/share/harness-usage ~/.local/share/harness-usage.bak
//   node agent/scripts/reroot-project.mjs          # dry run — shows old → new
//   node agent/scripts/reroot-project.mjs --apply
//   harness-usage sync
//
// Without --apply it prints the distinct old → new pairs and writes nothing.

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { DATA_DIR } from "../src/config.js";
import { projectRootOf } from "../src/project.js";
import { rewriteEvents } from "./lib/rewrite-events.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const APPLY = args.includes("--apply");
const DIR = opt("--data-dir", DATA_DIR);

// The review table: distinct old → new pairs with event counts. Built straight
// from the outbox so the operator sees exactly what --apply will do.
const db = new DatabaseSync(join(DIR, "state.sqlite"), { readOnly: true });
const pairs = [];
for (const row of db
  .prepare(
    `SELECT json_extract(payload,'$.project') AS project, COUNT(*) AS events
     FROM outbox GROUP BY 1 ORDER BY 2 DESC`,
  )
  .all()) {
  if (!row.project) continue;
  const root = projectRootOf(row.project);
  if (root !== row.project) pairs.push({ from: row.project, to: root, events: row.events });
}
db.close();

console.log(`data dir: ${DIR}`);
if (!pairs.length) {
  console.log("nothing to reroot — every project is already a repository root or a non-repository.");
  process.exit(0);
}
console.log(`\n${pairs.reduce((n, p) => n + p.events, 0)} events under ${pairs.length} subdirectory project(s):`);
for (const p of pairs) console.log(`  ${p.events.toString().padStart(6)}  ${p.from}  →  ${p.to}`);

const r = rewriteEvents({
  dataDir: DIR,
  map: (ev) => {
    const p = projectRootOf(ev.project);
    return p !== ev.project ? { ...ev, project: p } : null;
  },
  apply: APPLY,
});

console.log(
  `\noutbox rows:   ${r.examined}\nto reroot:     ${r.changed}\narchive lines: ${r.archiveLines} across ${r.files} file(s)`,
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
