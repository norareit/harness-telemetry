// homes.test.js — extra homes (plans/018): resolving the `homes` config, the
// inputs each harness reads, and the rule that keeps a home to its own files.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { databaseInHome, expandHomes, fileInHome, inputsFor, insideHome } from "../src/homes.js";

const TMP = [];
// realpath: tmpdir() may itself be a symlink (macOS), and paths are compared.
const mkTmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "harness-usage-")));
  TMP.push(d);
  return d;
};
after(() => {
  for (const d of TMP) rmSync(d, { recursive: true, force: true });
});

const mk = (...parts) => {
  const p = join(...parts);
  mkdirSync(p, { recursive: true });
  return p;
};

// --- expandHomes -----------------------------------------------------------

test("expandHomes: no entries, or none at all, is empty", () => {
  assert.deepEqual(expandHomes([]), []);
  assert.deepEqual(expandHomes(undefined), []);
});

test("expandHomes: * matches every directory at that level, sorted, named after the directory", () => {
  const dir = mkTmp();
  mk(dir, "b");
  mk(dir, "a");
  assert.deepEqual(expandHomes([{ home: join(dir, "*") }]), [
    { home: join(dir, "a"), project: "a" },
    { home: join(dir, "b"), project: "b" },
  ]);
});

test("expandHomes: * matches neither a file nor a symlinked directory", () => {
  const dir = mkTmp();
  const real = mk(dir, "real");
  writeFileSync(join(dir, "file"), "");
  symlinkSync(real, join(dir, "link"));
  assert.deepEqual(expandHomes([{ home: join(dir, "*") }]).map((h) => h.project), ["real"]);
});

test("expandHomes: * that matches nothing is empty; a segment after * must exist", () => {
  const dir = mkTmp();
  assert.deepEqual(expandHomes([{ home: join(dir, "*") }]), []);
  assert.deepEqual(expandHomes([{ home: join(dir, "missing", "*") }]), []);
  mk(dir, "a", "home");
  mk(dir, "b");
  assert.deepEqual(expandHomes([{ home: join(dir, "*", "home") }]), [
    { home: join(dir, "a", "home"), project: "home" },
  ]);
});

test("expandHomes: an entry without * is returned even when it does not exist", () => {
  const dir = mkTmp();
  assert.deepEqual(expandHomes([{ home: join(dir, "gone") + "/" }]), [
    { home: join(dir, "gone"), project: "gone" },
  ]);
});

test("expandHomes: ~ is expanded in home and in a project override", () => {
  const [h] = expandHomes([{ home: "~/backup/laptop-home", project: "~/projects/finrite" }]);
  assert.equal(h.home, join(homedir(), "backup", "laptop-home"));
  assert.equal(h.project, join(homedir(), "projects", "finrite"));
});

test("expandHomes: a directory named twice is returned once, with the first entry's project", () => {
  const dir = mkTmp();
  const a = mk(dir, "a");
  assert.deepEqual(expandHomes([{ home: a, project: "first" }, { home: join(dir, "*") }]), [
    { home: a, project: "first" },
  ]);
});

test("expandHomes: malformed entries are ignored", () => {
  assert.deepEqual(expandHomes([null, {}, { home: 3 }, "x"]), []);
});

// --- inputsFor -------------------------------------------------------------

test("inputsFor: the device's own input first, then one per home", () => {
  const dir = mkTmp();
  const a = mk(dir, "homes", "a");
  const b = mk(dir, "homes", "b");
  const config = {
    sources: { "claude-code": { root: join(dir, "cc") }, opencode: { db: join(dir, "oc.db") } },
    homes: [{ home: join(dir, "homes", "*") }],
  };
  assert.deepEqual(inputsFor("claude-code", config), [
    { path: join(dir, "cc"), project: null, home: null },
    { path: join(a, ".claude", "projects"), project: "a", home: a },
    { path: join(b, ".claude", "projects"), project: "b", home: b },
  ]);
  assert.deepEqual(inputsFor("opencode", config).map((i) => i.path), [
    join(dir, "oc.db"),
    join(a, ".local", "share", "opencode", "opencode.db"),
    join(b, ".local", "share", "opencode", "opencode.db"),
  ]);
});

test("inputsFor: a config without homes yields only the device's own input", () => {
  const config = { sources: { "claude-code": { root: "/x/cc" } } };
  assert.deepEqual(inputsFor("claude-code", config), [{ path: "/x/cc", project: null, home: null }]);
});

test("inputsFor: a home that is the device's own home yields no second input", () => {
  const dir = mkTmp();
  const root = mk(dir, ".claude", "projects");
  const config = { sources: { "claude-code": { root } }, homes: [{ home: dir }] };
  assert.deepEqual(inputsFor("claude-code", config), [{ path: root, project: null, home: null }]);
});

test("inputsFor: an input that resolves to an earlier one through a symlink is dropped", () => {
  const dir = mkTmp();
  const ownDb = join(mk(dir, "own"), "opencode.db");
  writeFileSync(ownDb, "");
  const home = mk(dir, "homes", "a");
  symlinkSync(ownDb, join(mk(home, ".local", "share", "opencode"), "opencode.db"));
  const config = { sources: { opencode: { db: ownDb } }, homes: [{ home }] };
  assert.deepEqual(inputsFor("opencode", config).map((i) => i.home), [null]);
});

// --- insideHome / fileInHome / databaseInHome ------------------------------

function homeAndOutside() {
  const dir = mkTmp();
  const home = mk(dir, "home");
  const outside = mk(dir, "outside");
  writeFileSync(join(outside, "real.jsonl"), "");
  return { dir, home, outside };
}

test("insideHome: a plain file in the home, and the home itself", () => {
  const { home } = homeAndOutside();
  writeFileSync(join(mk(home, "p"), "t.jsonl"), "");
  assert.equal(insideHome(home, join(home, "p", "t.jsonl")), true);
  assert.equal(insideHome(home, home), true);
});

test("insideHome: a symlinked file and a file under a symlinked directory are outside", () => {
  const { home, outside } = homeAndOutside();
  symlinkSync(join(outside, "real.jsonl"), join(home, "t.jsonl"));
  symlinkSync(outside, join(home, "p"));
  assert.equal(insideHome(home, join(home, "t.jsonl")), false);
  assert.equal(insideHome(home, join(home, "p", "real.jsonl")), false);
});

test("insideHome: a sibling whose name starts with the home's name is outside", () => {
  const { dir, home } = homeAndOutside();
  writeFileSync(join(mk(dir, "home2"), "t.jsonl"), "");
  symlinkSync(join(dir, "home2", "t.jsonl"), join(home, "t.jsonl"));
  assert.equal(insideHome(home, join(home, "t.jsonl")), false);
});

test("insideHome: a symlink that stays inside the home is inside; a missing path is not", () => {
  const { home } = homeAndOutside();
  writeFileSync(join(home, "real.jsonl"), "");
  symlinkSync(join(home, "real.jsonl"), join(home, "link.jsonl"));
  assert.equal(insideHome(home, join(home, "link.jsonl")), true);
  assert.equal(insideHome(home, join(home, "missing.jsonl")), false);
  assert.equal(insideHome(join(home, "missing"), join(home, "real.jsonl")), false);
});

test("fileInHome: a directory with a transcript's name is not a file", () => {
  const { home } = homeAndOutside();
  mk(home, "dir.jsonl");
  writeFileSync(join(home, "t.jsonl"), "");
  assert.equal(fileInHome(home, join(home, "dir.jsonl")), false);
  assert.equal(fileInHome(home, join(home, "t.jsonl")), true);
});

test("databaseInHome: the database and any -wal/-shm beside it must be inside", () => {
  const { home, outside } = homeAndOutside();
  const db = join(home, "opencode.db");
  assert.equal(databaseInHome(home, db), false, "missing");
  writeFileSync(db, "");
  assert.equal(databaseInHome(home, db), true);
  writeFileSync(db + "-shm", "");
  assert.equal(databaseInHome(home, db), true);
  symlinkSync(join(outside, "real.jsonl"), db + "-wal");
  assert.equal(databaseInHome(home, db), false);
});
