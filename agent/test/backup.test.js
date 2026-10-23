// backup.test.js — pulling the server's dumps (plans/019). rsync copies a local
// directory without SSH, so a temp dir stands in for the server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullBackups, listDumps, newestDump } from "../src/backup.js";

function setup(t, { keep } = {}) {
  const root = mkdtempSync(join(tmpdir(), "harness-backup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = join(root, "server");
  const dir = join(root, "client");
  mkdirSync(server);
  const config = { backup: { source: server + "/", dir, ...(keep ? { keep } : {}) } };
  const dump = (name, body = "PGDMP rest of the dump", mtime = null) => {
    const p = join(server, name);
    writeFileSync(p, body);
    if (mtime) utimesSync(p, mtime, mtime);
    return p;
  };
  return { server, dir, config, dump };
}

const name = (i) => `harness-telemetry-202610${String(i).padStart(2, "0")}T033000Z.dump`;

test("pullBackups fetches new dumps, keeps the server's mtime, ignores other files", (t) => {
  const s = setup(t);
  const when = new Date("2026-10-01T03:30:00Z");
  s.dump(name(1), "PGDMP one", when);
  s.dump(name(2));
  writeFileSync(join(s.server, "notes.txt"), "not a dump");
  writeFileSync(join(s.server, name(3) + ".tmp"), "PGDMP half-written");

  const r = pullBackups(s.config);
  assert.deepEqual(r.pulled, [name(1), name(2)]);
  assert.deepEqual(readdirSync(s.dir).sort(), [name(1), name(2)]);
  assert.equal(statSync(join(s.dir, name(1))).mtimeMs, when.getTime());
  assert.equal(r.newest, name(2));
});

test("pullBackups pulls nothing the second time", (t) => {
  const s = setup(t);
  s.dump(name(1));
  pullBackups(s.config);
  assert.deepEqual(pullBackups(s.config).pulled, []);
});

test("pullBackups deletes a pulled file that is not pg_dump output, and throws", (t) => {
  const s = setup(t);
  s.dump(name(1));
  s.dump(name(2), "pg_dump: error: connection failed");
  assert.throws(() => pullBackups(s.config), /not pg_dump output: .*T033000Z\.dump/);
  assert.deepEqual(listDumps(s.dir), [name(1)]);
});

test("pullBackups prunes to the newest `keep`, by name", (t) => {
  const s = setup(t, { keep: 2 });
  for (const i of [1, 2, 3]) s.dump(name(i));
  const r = pullBackups(s.config);
  assert.deepEqual(r.removed, [name(1)]);
  assert.deepEqual(listDumps(s.dir), [name(2), name(3)]);
});

test("pullBackups throws when rsync fails", (t) => {
  const s = setup(t);
  s.config.backup.source = join(s.server, "missing") + "/";
  assert.throws(() => pullBackups(s.config), /rsync exited \d+/);
});

test("pullBackups throws without backup.source", () => {
  assert.throws(() => pullBackups({ backup: { source: null } }), /backup\.source is not set/);
});

test("newestDump picks the last name, null for a missing dir", (t) => {
  const s = setup(t);
  assert.equal(newestDump(s.dir), null);
  for (const i of [2, 1]) s.dump(name(i));
  pullBackups(s.config);
  assert.equal(newestDump(s.dir).name, name(2));
});
