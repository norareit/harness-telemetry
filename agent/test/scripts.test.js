// scripts.test.js — the shared repair core rewriteEvents (plans/008).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../src/local-store.js";
import { eventKey } from "../src/record.js";
import { rewriteEvents } from "../scripts/lib/rewrite-events.mjs";
import { event } from "./helpers.js";

function withDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function archiveLines(dir) {
  const evDir = join(dir, "events");
  if (!existsSync(evDir)) return [];
  return readdirSync(evDir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(evDir, f), "utf8").split("\n").filter((l) => l.trim()));
}

// Seed a store with two events, close it (rewriteEvents opens its own handle).
function seed(dir, overrides = [{}, { message_id: "m2" }]) {
  const store = new LocalStore({ dataDir: dir });
  for (const o of overrides) store.record(event({ project: "/repo/sub", ...o }));
  store.close();
}

const reroot = (ev) => (ev.project === "/repo/sub" ? { ...ev, project: "/repo" } : null);

test("dry run reports the change but writes nothing", (t) => {
  const dir = withDir(t);
  seed(dir);
  const before = archiveLines(dir);
  const r = rewriteEvents({ dataDir: dir, map: reroot, apply: false });
  assert.equal(r.examined, 2);
  assert.equal(r.changed, 2);
  assert.equal(r.archiveLines, 2);
  assert.deepEqual(archiveLines(dir), before, "archive untouched on a dry run");

  const store = new LocalStore({ dataDir: dir });
  t.after(() => store.close());
  for (const e of store.allEvents()) assert.equal(e.project, "/repo/sub", "outbox untouched");
});

test("apply rewrites outbox, archive and hash together; a re-record is 'unchanged'", (t) => {
  const dir = withDir(t);
  seed(dir);
  const linesBefore = archiveLines(dir).length;

  const r = rewriteEvents({ dataDir: dir, map: reroot, apply: true });
  assert.equal(r.changed, 2);

  const store = new LocalStore({ dataDir: dir });
  t.after(() => store.close());
  for (const e of store.allEvents()) {
    assert.equal(e.project, "/repo", "outbox payload rerooted");
    assert.equal(store.db.prepare("SELECT synced FROM outbox WHERE pk=?").get(eventKey(e)).synced, 0, "re-queued");
  }
  // The archive line count is unchanged (rewritten in place, not appended)...
  assert.equal(archiveLines(dir).length, linesBefore);
  for (const line of archiveLines(dir)) assert.equal(JSON.parse(line).project, "/repo");

  // ...and record() of the rerooted event agrees: identical payload AND hash,
  // so nothing is appended.
  const st = store.record(event({ project: "/repo" }));
  assert.equal(st, "unchanged");
  assert.equal(archiveLines(dir).length, linesBefore);
});

test("a null map leaves an event alone (changed count excludes it)", (t) => {
  const dir = withDir(t);
  seed(dir, [{ project: "/repo/sub" }, { message_id: "m2", project: "/already/root" }]);
  // Only the /repo/sub row maps to something new.
  const r = rewriteEvents({ dataDir: dir, map: reroot, apply: false });
  assert.equal(r.examined, 2);
  assert.equal(r.changed, 1);
});

test("refuses to write while a legacy (pre-v2) archive hash exists", (t) => {
  const dir = withDir(t);
  seed(dir);
  // Corrupt one archived hash to the legacy (non-v2) shape.
  const store = new LocalStore({ dataDir: dir });
  const pk = store.db.prepare("SELECT pk FROM archived LIMIT 1").get().pk;
  store.db.prepare("UPDATE archived SET hash = ? WHERE pk = ?").run("legacyhash", pk);
  store.close();

  const before = archiveLines(dir);
  const r = rewriteEvents({ dataDir: dir, map: reroot, apply: true });
  assert.ok(r.legacy >= 1, "legacy count surfaced");
  assert.deepEqual(archiveLines(dir), before, "nothing written when a legacy hash is present");

  const check = new LocalStore({ dataDir: dir });
  t.after(() => check.close());
  for (const e of check.allEvents()) assert.equal(e.project, "/repo/sub", "outbox untouched");
});
