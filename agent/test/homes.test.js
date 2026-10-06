// homes.test.js — extra homes (plans/018): resolving the `homes` config, the
// inputs each harness reads, and the rule that keeps a home to its own files.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { databaseInHome, expandHomes, fileInHome, inputsFor, insideHome, wellFormed } from "../src/homes.js";
import { event } from "./helpers.js";

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

test("expandHomes: an alias configured first wins over its target, whatever their spelling (review C3)", () => {
  const dir = mkTmp();
  const real = mk(dir, "a-real");
  const alias = join(dir, "z-alias");
  symlinkSync(real, alias);
  assert.deepEqual(expandHomes([{ home: alias, project: "first" }, { home: real, project: "second" }]), [
    { home: alias, project: "first" },
  ]);
  assert.deepEqual(expandHomes([{ home: real, project: "first" }, { home: alias, project: "second" }]), [
    { home: real, project: "first" },
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

// review S1: home `a` sorts first and points its inputs at home `b`'s. It must
// not take b's place in the list, or neither would be read.
test("inputsFor: a home whose input links into another home is left out, and the other is kept", () => {
  const dir = mkTmp();
  const a = mk(dir, "homes", "a");
  const b = mk(dir, "homes", "b");
  const bRoot = mk(b, ".claude", "projects");
  const bDb = join(mk(b, ".local", "share", "opencode"), "opencode.db");
  writeFileSync(bDb, "");
  mk(a, ".claude");
  symlinkSync(bRoot, join(a, ".claude", "projects"));
  symlinkSync(bDb, join(mk(a, ".local", "share", "opencode"), "opencode.db"));
  const config = {
    sources: { "claude-code": { root: join(dir, "cc") }, opencode: { db: join(dir, "oc.db") } },
    homes: [{ home: join(dir, "homes", "*") }],
  };
  assert.deepEqual(inputsFor("claude-code", config).map((i) => i.home), [null, b]);
  assert.deepEqual(inputsFor("opencode", config).map((i) => i.home), [null, b]);
});

// review C3, second round: two DISTINCT homes that reach one file. The child
// is configured first and must keep it, although the parent sorts first.
test("inputsFor: of two homes reaching one input, the one configured first keeps it", () => {
  const dir = mkTmp();
  const parent = mk(dir, "parent");
  const child = mk(parent, "child");
  const childDb = join(mk(child, ".local", "share", "opencode"), "opencode.db");
  writeFileSync(childDb, "");
  symlinkSync(childDb, join(mk(parent, ".local", "share", "opencode"), "opencode.db"));
  const sources = { opencode: { db: join(dir, "oc.db") } };
  const pick = (homes) => inputsFor("opencode", { sources, homes }).map((i) => i.project);
  assert.deepEqual(pick([{ home: child, project: "first" }, { home: parent, project: "second" }]), [null, "first"]);
  assert.deepEqual(pick([{ home: parent, project: "first" }, { home: child, project: "second" }]), [null, "first"]);
});

test("inputsFor: the homes are in path order, whatever the config order", () => {
  const dir = mkTmp();
  const a = mk(dir, "a");
  const b = mk(dir, "b");
  const config = { sources: {}, homes: [{ home: b }, { home: a }] };
  assert.deepEqual(inputsFor("claude-code", config).map((i) => i.home), [null, a, b]);
});

// --- wellFormed ------------------------------------------------------------

test("wellFormed: a canonical event is, with an ISO or an epoch-ms timestamp", () => {
  assert.equal(wellFormed(event()), true);
  assert.equal(wellFormed(event({ ts: 1725184800000, agent: "build", git_branch: "main" })), true);
});

test("wellFormed: wrong shapes are not", () => {
  for (const over of [
    { session_id: null },
    { session_id: 7 },
    { message_id: "" },
    { message_id: { a: 1 } },
    { ts: null },
    { ts: "not a date" },
    { ts: {} },
    { model: 5 },
    { provider: [] },
    { agent: {} },
    { git_branch: 1 },
    { input_tokens: "12" },
    { output_tokens: -1 },
    { reasoning_tokens: 1.5 },
    { cache_read_tokens: null },
    { cache_write_5m_tokens: Infinity },
    { cache_write_1h_tokens: {} },
    // within the types, but beyond what Postgres or its index accepts
    { session_id: "s".repeat(201) },
    { message_id: "m\u0000" },
    { model: "a\u0000b" },
    { message_id: "m\ud800" },
    { agent: "x".repeat(501) },
    { input_tokens: 1e9 + 1 },
    { ts: "1999-12-31T23:59:59Z" },
    { ts: "2100-01-01T00:00:00Z" },
    { ts: -1 },
    { ts: 8.64e15 },
  ]) {
    assert.equal(wellFormed(event(over)), false, JSON.stringify(over));
  }
  assert.equal(wellFormed(null), false);
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
