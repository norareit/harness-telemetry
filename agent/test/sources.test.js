// sources.test.js — the extractors against synthetic fixtures (§5).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync, renameSync, symlinkSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalStore } from "../src/local-store.js";
import { extractClaudeCode } from "../src/sources/claude-code.js";
import {
  extractOpenCode as _oc, reconcile as _rec, readHomeDatabase, listModels,
} from "../src/sources/opencode.js";
import { projectRootOf } from "../src/project.js";
import { openCodeDb, ocData1, ocData2, event } from "./helpers.js";

// Every tmp dir this file makes is tracked and removed after the run — these
// helpers are not handed a test context, so a single top-level after() is the
// tidy place to sweep them.
const TMP = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), "harness-usage-"));
  TMP.push(d);
  return d;
};
after(() => {
  for (const d of TMP) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

async function collect(gen) {
  const out = [];
  for await (const e of gen) out.push(e);
  return out;
}

// --- Claude Code -----------------------------------------------------------

function ccScratch() {
  const dir = mkTmp();
  const root = join(dir, "cc");
  mkdirSync(join(root, "proj"), { recursive: true });
  const store = new LocalStore({ dataDir: join(dir, "data") });
  const path = join(root, "proj", "sess1.jsonl");
  const config = { sources: { "claude-code": { root } } };
  const write = (raw) => writeFileSync(path, raw);
  const writeLines = (recs) => write(recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { dir, root, store, path, config, write, writeLines };
}

const assistant = (over = {}) => {
  const { message: msgOver, ...rest } = over;
  return {
    type: "assistant",
    uuid: "u1",
    requestId: "r1",
    sessionId: "sess1",
    timestamp: "2026-09-01T10:00:00Z",
    cwd: "/p",
    gitBranch: "main",
    message: {
      model: "claude-sonnet-5",
      usage: { input_tokens: 100, output_tokens: 1000, output_tokens_details: { thinking_tokens: 200 }, cache_read_input_tokens: 1000 },
      ...msgOver,
    },
    ...rest,
  };
};

test("CC: records sharing a requestId collapse to one event", async () => {
  const s = ccScratch();
  s.writeLines([assistant(), assistant({ uuid: "u2" }), assistant({ uuid: "u3" })]);
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.equal(events.length, 1);
  assert.equal(events[0].message_id, "r1");
});

test("CC: falls back to uuid when requestId is absent", async () => {
  const s = ccScratch();
  const rec = assistant({ requestId: undefined, uuid: "u9" });
  delete rec.requestId;
  s.writeLines([rec]);
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.equal(events[0].message_id, "u9");
});

test("CC: synthetic model, non-assistant, and usage-less lines are dropped", async () => {
  const s = ccScratch();
  s.writeLines([
    assistant({ requestId: "keep" }),
    assistant({ requestId: "syn", message: { model: "<synthetic>", usage: { input_tokens: 1 } } }),
    { type: "user", requestId: "usr" },
    { type: "assistant", requestId: "nousage", uuid: "nousage", sessionId: "sess1", timestamp: "2026-09-01T10:00:00Z", message: { model: "claude-sonnet-5" } },
  ]);
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.deepEqual(events.map((e) => e.message_id), ["keep"]);
});

test("CC: thinking tokens are split out of output", async () => {
  const s = ccScratch();
  s.writeLines([assistant()]);
  const [e] = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.equal(e.output_tokens, 800);
  assert.equal(e.reasoning_tokens, 200);
});

test("CC: cache_creation TTL breakdown maps to the two columns", async () => {
  const s = ccScratch();
  s.writeLines([
    assistant({
      message: { model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 40, ephemeral_5m_input_tokens: 10 } } },
    }),
  ]);
  const [e] = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.equal(e.cache_write_1h_tokens, 40);
  assert.equal(e.cache_write_5m_tokens, 10);
});

test("CC: without a TTL breakdown the flat total lands in 5m", async () => {
  const s = ccScratch();
  s.writeLines([assistant({ message: { model: "claude-sonnet-5", usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 50 } } })]);
  const [e] = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.equal(e.cache_write_5m_tokens, 50);
  assert.equal(e.cache_write_1h_tokens, 0);
});

test("CC: providerOf maps claude-* to anthropic and gpt-* to openai", async () => {
  const s = ccScratch();
  s.writeLines([
    assistant({ requestId: "a", message: { model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } } }),
    assistant({ requestId: "b", message: { model: "gpt-5.6-sol", usage: { input_tokens: 1, output_tokens: 1 } } }),
  ]);
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  const byId = Object.fromEntries(events.map((e) => [e.message_id, e.provider]));
  assert.equal(byId.a, "anthropic");
  assert.equal(byId.b, "openai");
});

test("CC: a partial trailing line is held back until it completes", async () => {
  const s = ccScratch();
  const l1 = JSON.stringify(assistant({ requestId: "r1" }));
  const l2 = JSON.stringify(assistant({ requestId: "r2" }));
  s.write(l1 + "\n" + l2.slice(0, 20)); // second line truncated, no newline
  assert.equal((await collect(extractClaudeCode({ store: s.store, config: s.config, full: false }))).length, 1);
  // The cursor stops at the end of the complete first line — the partial second
  // line is left for next time, not consumed.
  assert.equal(s.store.getFileCursor(s.path).offset, Buffer.byteLength(l1 + "\n"));
  s.write(l1 + "\n" + l2 + "\n"); // complete it
  assert.equal((await collect(extractClaudeCode({ store: s.store, config: s.config, full: false }))).length, 1);
  assert.equal((await collect(extractClaudeCode({ store: s.store, config: s.config, full: false }))).length, 0);
});

test("CC: a mismatched inode forces a re-read from the start", async () => {
  const s = ccScratch();
  s.writeLines([assistant({ requestId: "r1" })]);
  await collect(extractClaudeCode({ store: s.store, config: s.config, full: false }));
  // The file was replaced by a different inode (a rotation the byte offset can't
  // track). Simulated deterministically — tmpfs would otherwise reuse the inode
  // and identical size, defeating the check for the wrong reason.
  const cur = s.store.getFileCursor(s.path);
  s.store.setFileCursor(s.path, { inode: cur.inode + 1, offset: cur.offset, size: cur.size });
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: false }));
  assert.equal(events.length, 1);
  assert.equal(events[0].message_id, "r1");
});

// --- OpenCode --------------------------------------------------------------

function ocDb(rows) {
  const dir = mkTmp();
  const path = join(dir, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, workspace_id TEXT, agent TEXT, model TEXT,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER);
    CREATE TABLE workspace (id TEXT PRIMARY KEY, branch TEXT, directory TEXT);
  `);
  for (const s of rows.sessions || []) {
    db.prepare("INSERT INTO session (id, directory, parent_id, workspace_id, agent, model, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      s.id, s.directory ?? null, s.parent_id ?? null, s.workspace_id ?? null, s.agent ?? null, s.model ?? null,
      s.tokens_input ?? 0, s.tokens_output ?? 0, s.tokens_reasoning ?? 0, s.tokens_cache_read ?? 0, s.tokens_cache_write ?? 0);
  }
  for (const w of rows.workspaces || []) {
    db.prepare("INSERT INTO workspace (id, branch, directory) VALUES (?,?,?)").run(w.id, w.branch ?? null, w.directory ?? null);
  }
  for (const m of rows.messages || []) {
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)").run(
      m.id, m.session_id, m.time_created ?? 0, m.time_updated ?? 0, JSON.stringify(m.data));
  }
  db.close();
  return { dir, path };
}

const ocData = (over = {}) => ({
  role: "assistant",
  providerID: "openai",
  modelID: "gpt-5.6-sol",
  agent: "build",
  time: { completed: 1725184800000 },
  tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 1000, write: 50 } },
  ...over,
});

function ocStore() {
  const dir = mkTmp();
  return new LocalStore({ dataDir: dir });
}

test("OC: an assistant message maps to the six token columns, reasoning kept separate", async () => {
  const { path } = ocDb({
    sessions: [{ id: "sess1", directory: "/proj", workspace_id: "ws1" }],
    workspaces: [{ id: "ws1", branch: "main" }],
    messages: [{ id: "msg1", session_id: "sess1", time_updated: 100, data: ocData() }],
  });
  const events = await collect(_oc({ store: ocStore(), config: { sources: { opencode: { db: path } } }, full: true }));
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.input_tokens, 100);
  assert.equal(e.output_tokens, 10);
  assert.equal(e.reasoning_tokens, 5);
  assert.equal(e.cache_read_tokens, 1000);
  assert.equal(e.cache_write_5m_tokens, 50);
  assert.equal(e.cache_write_1h_tokens, 0);
  assert.equal(e.project, "/proj");
  assert.equal(e.git_branch, "main");
  assert.equal(e.provider, "openai");
});

test("OC: user rows are skipped and parent_id marks a sidechain", async () => {
  const { path } = ocDb({
    sessions: [{ id: "sess1", directory: "/proj", parent_id: "parent" }],
    messages: [
      { id: "u", session_id: "sess1", time_updated: 100, data: ocData({ role: "user" }) },
      { id: "a", session_id: "sess1", time_updated: 101, data: ocData() },
    ],
  });
  const events = await collect(_oc({ store: ocStore(), config: { sources: { opencode: { db: path } } }, full: true }));
  assert.deepEqual(events.map((e) => e.message_id), ["a"]);
  assert.equal(events[0].is_sidechain, true);
});

test("OC: the watermark re-yields only the boundary row on the next run", async () => {
  const { path } = ocDb({
    sessions: [{ id: "sess1", directory: "/proj" }],
    messages: [
      { id: "old", session_id: "sess1", time_updated: 100, data: ocData() },
      { id: "boundary", session_id: "sess1", time_updated: 200, data: ocData() },
    ],
  });
  const store = ocStore();
  const cfg = { sources: { opencode: { db: path } } };
  const first = await collect(_oc({ store, config: cfg, full: false }));
  assert.equal(first.length, 2);
  // The stored watermark is the max time_updated seen, so the next run re-reads
  // only the boundary (>=) and nothing older.
  assert.equal(Number(store.getKV("watermark:opencode:time_updated")), 200);
  const second = await collect(_oc({ store, config: cfg, full: false }));
  assert.deepEqual(second.map((e) => e.message_id), ["boundary"]);
});

test("OC: reconcile reports ok===total when rollups match, and lists a mismatch", () => {
  const match = ocDb({
    sessions: [{ id: "s1", tokens_input: 100, tokens_output: 10, tokens_reasoning: 5, tokens_cache_read: 1000, tokens_cache_write: 50 }],
    messages: [{ id: "m1", session_id: "s1", time_updated: 1, data: ocData() }],
  });
  const okr = _rec(match.path).v1;
  assert.equal(okr.ok, okr.total);
  assert.equal(okr.mismatches.length, 0);

  const off = ocDb({
    sessions: [{ id: "s1", tokens_input: 101, tokens_output: 10, tokens_reasoning: 5, tokens_cache_read: 1000, tokens_cache_write: 50 }],
    messages: [{ id: "m1", session_id: "s1", time_updated: 1, data: ocData() }],
  });
  const badr = _rec(off.path).v1;
  assert.equal(badr.mismatches.length, 1);
});

// --- OpenCode 2 (plan 025) -------------------------------------------------

const oc2Path = (spec) => openCodeDb(join(mkTmp(), "opencode.db"), spec);
const oc2Run = (path, store = ocStore(), full = false) =>
  collect(_oc({ store, config: { sources: { opencode: { db: path } } }, full }));
const ROLL = {
  tokens_input: 100, tokens_output: 10, tokens_reasoning: 5, tokens_cache_read: 1000, tokens_cache_write: 50,
};
const ROLL2 = Object.fromEntries(Object.entries(ROLL).map(([k, v]) => [k, 2 * v])); // two messages

test("OC2: a 1.19.6 database, with its empty session_message, is read as 1.x exactly as before", async () => {
  const path = oc2Path({
    sessions: [{ id: "s1", directory: "/proj", workspace_id: "ws1" }],
    workspaces: [{ id: "ws1", branch: "main" }],
    messages: [{ id: "m1", session_id: "s1", time_updated: 100, data: ocData1() }],
  });
  const store = ocStore();
  const events = await oc2Run(path, store);
  assert.deepEqual(events.map((e) => [e.message_id, e.model, e.git_branch]), [["m1", "gpt-6.2-sol", "main"]]);
  assert.equal(store.getKV("watermark:opencode-v2:time_updated"), null);
});

test("OC2: a 2.x-only database yields its assistant rows, model from data.model, other types ignored", async () => {
  const path = oc2Path({
    v1: false,
    v2: true,
    sessionsV2: [{ id: "s1", directory: "/proj" }, { id: "s2", directory: "/proj", parent_id: "s1" }],
    messagesV2: [
      { id: "u1", session_id: "s1", type: "user", time_updated: 90, data: { tokens: ocData2().tokens } },
      { id: "a1", session_id: "s1", time_updated: 100, data: ocData2() },
      { id: "c1", session_id: "s1", type: "compaction", time_updated: 101, data: { tokens: ocData2().tokens } },
      { id: "y1", session_id: "s1", type: "system", time_updated: 102, data: { text: "x" } },
      {
        id: "a2", session_id: "s2", time_updated: 110,
        data: ocData2({ model: { providerID: "anthropic", id: "claude-opus-5" } }),
      },
    ],
  });
  const store = ocStore();
  const events = await oc2Run(path, store);
  assert.deepEqual(
    events.map((e) => [e.message_id, e.provider, e.model, e.is_sidechain, e.git_branch]),
    [["a1", "openai", "gpt-6.2-sol", false, null], ["a2", "anthropic", "claude-opus-5", true, null]],
  );
  const e = events[0];
  assert.deepEqual(
    [e.input_tokens, e.output_tokens, e.reasoning_tokens, e.cache_read_tokens, e.cache_write_5m_tokens, e.project],
    [100, 10, 5, 1000, 50, "/proj"],
  );
  assert.equal(e.ts, 1795000003000);
  assert.equal(Number(store.getKV("watermark:opencode-v2:time_updated")), 110);
  // The next run re-reads the boundary only, as for 1.x.
  assert.deepEqual((await oc2Run(path, store)).map((x) => x.message_id), ["a2"]);
});

test("OC2: a converted database yields each converted message once, from 1.x, compaction included", async () => {
  // Converted rows keep id, session id and time_updated, but 2.4.2 moves
  // time.completed by 1 ms and stores compaction calls without tokens.
  const path = oc2Path({
    v2: true,
    sessions: [{ id: "s1", directory: "/proj" }],
    sessionsV2: [{ id: "s1", directory: "/proj" }, { id: "s9", directory: "/proj" }],
    messages: [
      { id: "m1", session_id: "s1", time_updated: 100, data: ocData1() },
      { id: "m2", session_id: "s1", time_updated: 120, data: ocData1({ agent: "compaction", mode: "compaction" }) },
    ],
    messagesV2: [
      {
        id: "m1", session_id: "s1", time_updated: 100,
        data: ocData2({ time: { created: 1795000000000, completed: 1795000003001 } }),
      },
      {
        id: "m2", session_id: "s1", type: "compaction", time_updated: 120,
        data: { status: "completed", reason: "auto" },
      },
      { id: "x1", session_id: "s1", type: "system", time_updated: 121, data: { text: "tools changed" } },
      { id: "n1", session_id: "s9", time_updated: 200, data: ocData2() },
    ],
  });
  const store = ocStore();
  const events = await oc2Run(path, store);
  assert.deepEqual(events.map((e) => e.message_id).sort(), ["m1", "m2", "n1"]);
  assert.equal(events.find((e) => e.message_id === "m1").ts, 1795000003000); // 1.x's, not 2.x's
  assert.equal(events.find((e) => e.message_id === "m2").agent, "compaction");
  assert.equal(Number(store.getKV("watermark:opencode:time_updated")), 120);
  assert.equal(Number(store.getKV("watermark:opencode-v2:time_updated")), 200);
});

test("OC2: a message converted after the 2.x watermark moved on is not yielded again", async () => {
  const path = oc2Path({
    v2: true,
    sessions: [{ id: "s1", directory: "/proj" }],
    sessionsV2: [{ id: "s9", directory: "/proj" }],
    messages: [
      { id: "old", session_id: "s1", time_updated: 50, data: ocData1() },
      { id: "m1", session_id: "s1", time_updated: 100, data: ocData1() },
    ],
    messagesV2: [{ id: "n1", session_id: "s9", time_updated: 200, data: ocData2() }],
  });
  const store = ocStore();
  assert.deepEqual((await oc2Run(path, store)).map((e) => e.message_id).sort(), ["m1", "n1", "old"]);

  // The background conversion now writes the old messages, below both watermarks.
  const db = new DatabaseSync(path);
  db.exec("INSERT INTO session_v2 (id, directory) VALUES ('s1', '/proj')");
  for (const [id, t] of [["old", 50], ["m1", 100]]) {
    db.prepare("INSERT INTO session_message VALUES (?, 's1', 'assistant', ?, 0, ?, ?)")
      .run(id, t, t, JSON.stringify(ocData2()));
  }
  db.close();
  // Only the two boundary rows, one per part, as before the conversion.
  assert.deepEqual((await oc2Run(path, store)).map((e) => e.message_id).sort(), ["m1", "n1"]);
  // A backfill still yields every message once.
  assert.deepEqual((await oc2Run(path, store, true)).map((e) => e.message_id).sort(), ["m1", "n1", "old"]);
});

test("OC2: a database with neither 1.x nor 2.x tables yields nothing and does not throw", async () => {
  const path = join(mkTmp(), "opencode.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)");
  db.close();
  assert.deepEqual(await oc2Run(path), []);
});

test("OC2: readHomeDatabase reads a 2.x-only home and drops malformed rows", () => {
  const path = oc2Path({
    v1: false,
    v2: true,
    sessionsV2: [{ id: "s1", directory: "/work" }],
    messagesV2: [
      { id: "a1", session_id: "s1", time_updated: 100, data: ocData2() },
      { id: "a2", session_id: "s1", time_updated: 101, data: "not json" },
      { id: "a3", session_id: "s1", time_updated: 102, data: ocData2({ model: "openai/gpt-6.2-sol" }) },
    ],
  });
  const db = new DatabaseSync(path);
  // A blob id is not text; a time_updated beyond 2^53 cannot be read into JavaScript.
  db.prepare("INSERT INTO session_message VALUES (x'00', 's1', 'assistant', 10, 0, 103, ?)")
    .run(JSON.stringify(ocData2()));
  db.prepare("INSERT INTO session_message VALUES ('a5', 's1', 'assistant', 11, 0, ?, ?)")
    .run(2n ** 60n, JSON.stringify(ocData2()));
  db.close();
  const read = readHomeDatabase(path);
  // a3 has no model id to read: provider and model are null, which wellFormed allows.
  assert.deepEqual(read.events.map((e) => [e.message_id, e.model]), [["a1", "gpt-6.2-sol"], ["a3", null]]);
  // The rows the guard drops are never read, so they do not move the watermark (as for 1.x).
  assert.deepEqual(read.watermarks, { v1: null, v2: 102 });
});

test("OC2: readHomeDatabase rejects session_v2 as a view, and a database with neither part", () => {
  const path = oc2Path({ v1: false, v2: true });
  const db = new DatabaseSync(path);
  db.exec("ALTER TABLE session_v2 RENAME TO s2; CREATE VIEW session_v2 AS SELECT * FROM s2;");
  db.close();
  assert.throws(() => readHomeDatabase(path), /not an OpenCode database/);
});

test("OC2: an extra home holding a 2.x-only database is extracted with its own watermark", async () => {
  const home = mkTmp();
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
  const path = openCodeDb(join(home, ".local", "share", "opencode", "opencode.db"), {
    v1: false,
    v2: true,
    sessionsV2: [{ id: "s1", directory: "/work" }],
    messagesV2: [{ id: "a1", session_id: "s1", time_updated: 100, data: ocData2() }],
  });
  const store = ocStore();
  const config = { sources: { opencode: { db: join(mkTmp(), "none.db") } }, homes: [{ home, project: "/p/x" }] };
  const events = await collect(_oc({ store, config, full: false }));
  assert.deepEqual(events.map((e) => [e.message_id, e.project]), [["a1", "/p/x"]]);
  assert.equal(Number(store.getKV(`watermark:opencode-v2:time_updated:${path}`)), 100);
});

test("OC2: reconcile checks 1.x on session, and every 2.x session on 1.x plus 2.x-only messages", () => {
  const path = oc2Path({
    v2: true,
    // s1 is converted: its 2.x compaction row has no tokens, so only 1.x can sum to the rollup.
    sessions: [{ id: "s1", ...ROLL2 }],
    sessionsV2: [{ id: "s1", ...ROLL2 }, { id: "n1", ...ROLL }, { id: "n2", ...ROLL }],
    messages: [
      { id: "m1", session_id: "s1", data: ocData1() },
      { id: "m2", session_id: "s1", data: ocData1({ agent: "compaction" }) },
    ],
    messagesV2: [
      { id: "m1", session_id: "s1", data: ocData2() },
      { id: "m2", session_id: "s1", type: "compaction", data: { status: "completed" } },
      { id: "a1", session_id: "n1", data: ocData2() },
      {
        id: "a2", session_id: "n2",
        data: ocData2({ tokens: { input: 1, output: 10, reasoning: 5, cache: { read: 1000, write: 50 } } }),
      },
    ],
  });
  const r = _rec(path);
  assert.deepEqual([r.v1.ok, r.v1.total], [1, 1]);
  // s1 reconciles on its 1.x messages (the 2.x compaction row has no tokens); n2 falls short.
  assert.deepEqual([r.v2.ok, r.v2.total], [2, 3]);
  assert.deepEqual(r.v2.mismatches.map((m) => m.session), ["n2"]);

  assert.equal(_rec(oc2Path({ sessions: [{ id: "s1" }] })).v2, null);
  assert.equal(_rec(oc2Path({ v1: false, v2: true })).v1, null);
});

test("OC2: listModels reads the model of both parts", () => {
  const path = oc2Path({
    v2: true,
    sessions: [{ id: "s1" }],
    sessionsV2: [{ id: "n1" }],
    messages: [{ id: "m1", session_id: "s1", data: ocData1({ modelID: "gpt-6.1-sol" }) }],
    messagesV2: [
      { id: "a1", session_id: "n1", data: ocData2({ model: { providerID: "anthropic", id: "claude-opus-5" } }) },
      { id: "u1", session_id: "n1", type: "user", data: { model: { providerID: "x", id: "not-a-call" } } },
    ],
  });
  assert.deepEqual(listModels(path).sort(), [["anthropic", "claude-opus-5"], ["openai", "gpt-6.1-sol"]]);
});

// --- project = repository root (plans/008) ---------------------------------

// A temp repo (.git dir) with a nested working directory, under tmpdir() so the
// $HOME stop never fires.
function tempRepo() {
  const dir = mkTmp();
  mkdirSync(join(dir, ".git"), { recursive: true });
  const sub = join(dir, "agent", "src");
  mkdirSync(sub, { recursive: true });
  projectRootOf.cache.clear();
  return { repo: dir, sub };
}

test("CC: project resolves a subdirectory cwd to the repository root", async () => {
  const { repo, sub } = tempRepo();
  const s = ccScratch();
  s.writeLines([assistant({ cwd: sub })]);
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.equal(events[0].project, repo);
});

test("CC: detectRoot:false keeps the raw cwd", async () => {
  const { sub } = tempRepo();
  const s = ccScratch();
  s.writeLines([assistant({ cwd: sub })]);
  const cfg = { ...s.config, project: { detectRoot: false } };
  const events = await collect(extractClaudeCode({ store: s.store, config: cfg, full: true }));
  assert.equal(events[0].project, sub);
});

test("OC: project resolves a subdirectory session directory to the repository root", async () => {
  const { repo, sub } = tempRepo();
  const { path } = ocDb({
    sessions: [{ id: "sess1", directory: sub }],
    messages: [{ id: "msg1", session_id: "sess1", time_updated: 100, data: ocData() }],
  });
  const events = await collect(_oc({ store: ocStore(), config: { sources: { opencode: { db: path } } }, full: true }));
  assert.equal(events[0].project, repo);
});

// --- extra homes (plans/018) -----------------------------------------------

// A device with its own Claude Code root, plus one extra home `homes/norareit`
// whose transcript was written in a container (cwd /work/sub).
function homeScratch() {
  const s = ccScratch();
  const home = join(s.dir, "homes", "norareit");
  const slug = join(home, ".claude", "projects", "-work");
  mkdirSync(slug, { recursive: true });
  const lines = (recs) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const inHome = assistant({ requestId: "h1", sessionId: "hs", cwd: "/work/sub" });
  writeFileSync(join(slug, "hs.jsonl"), lines([inHome]));
  const config = { ...s.config, homes: [{ home: join(s.dir, "homes", "*") }] };
  return { ...s, home, slug, lines, config };
}

test("CC: a home's events get the home's project; the device's own still resolve by cwd", async () => {
  const { repo, sub } = tempRepo();
  const s = homeScratch();
  s.writeLines([assistant({ cwd: sub })]);
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: false }));
  assert.deepEqual(events.map((e) => [e.message_id, e.project]), [["r1", repo], ["h1", "norareit"]]);
  assert.equal(events[1].git_branch, "main");

  const again = await collect(extractClaudeCode({ store: s.store, config: s.config, full: false }));
  assert.equal(again.length, 0, "a second run reads nothing new from the home");
});

test("CC: a home's project override is used as given, with detectRoot off as well", async () => {
  const s = homeScratch();
  const config = { ...s.config, homes: [{ home: s.home, project: "/real/path" }], project: { detectRoot: false } };
  const events = await collect(extractClaudeCode({ store: s.store, config, full: true }));
  assert.deepEqual(events.map((e) => e.project), ["/real/path"]);
});

test("CC: in a home, a transcript that is a symlink to one outside it is skipped", async () => {
  const s = homeScratch();
  // The device's own transcript, reached through a link in the home, must not
  // be re-filed under the home's name.
  s.writeLines([assistant()]);
  symlinkSync(s.path, join(s.slug, "stolen.jsonl"));
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.deepEqual(events.map((e) => [e.message_id, e.project]), [["r1", "/p"], ["h1", "norareit"]]);
});

test("CC: in a home whose .claude is a symlink to a tree outside it, every transcript is skipped", async () => {
  const s = homeScratch();
  const elsewhere = join(s.dir, "elsewhere");
  renameSync(join(s.home, ".claude"), elsewhere);
  symlinkSync(elsewhere, join(s.home, ".claude"));
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.deepEqual(events, []);
});

test("CC: a home whose projects root is not a directory does not fail the run", async () => {
  const s = homeScratch();
  rmSync(join(s.home, ".claude", "projects"), { recursive: true });
  writeFileSync(join(s.home, ".claude", "projects"), "");
  s.writeLines([assistant()]);
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.deepEqual(events.map((e) => e.message_id), ["r1"]);
});

// The device's own database plus one in a home, each with an old and a newer row.
function ocHomes() {
  const dir = mkTmp();
  const rows = (prefix, directory) => ({
    sessions: [{ id: `${prefix}-sess`, directory }],
    messages: [
      { id: `${prefix}-old`, session_id: `${prefix}-sess`, time_updated: 100, data: ocData() },
      { id: `${prefix}-new`, session_id: `${prefix}-sess`, time_updated: 200, data: ocData() },
    ],
  });
  const own = ocDb(rows("own", "/proj"));
  const inHome = ocDb(rows("home", "/work"));
  const home = join(dir, "homes", "norareit");
  const homeDb = join(home, ".local", "share", "opencode", "opencode.db");
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
  const config = { sources: { opencode: { db: own.path } }, homes: [{ home }] };
  return { dir, own, inHome, home, homeDb, config };
}

test("OC: a home's database is read under the home's project, with a watermark of its own", async () => {
  const f = ocHomes();
  renameSync(f.inHome.path, f.homeDb);
  const store = ocStore();
  const first = await collect(_oc({ store, config: f.config, full: false }));
  assert.deepEqual(
    first.map((e) => [e.message_id, e.project]),
    [["own-old", "/proj"], ["own-new", "/proj"], ["home-old", "norareit"], ["home-new", "norareit"]],
  );
  assert.equal(Number(store.getKV("watermark:opencode:time_updated")), 200);
  assert.equal(Number(store.getKV(`watermark:opencode:time_updated:${f.homeDb}`)), 200);

  const second = await collect(_oc({ store, config: f.config, full: false }));
  assert.deepEqual(second.map((e) => e.message_id), ["own-new", "home-new"]);
});

test("OC: a home whose opencode.db is a symlink to a database outside it yields nothing", async () => {
  const f = ocHomes();
  symlinkSync(f.inHome.path, f.homeDb);
  const events = await collect(_oc({ store: ocStore(), config: f.config, full: true }));
  assert.deepEqual(events.map((e) => e.message_id), ["own-old", "own-new"]);
});

test("OC: a home's file that is not an OpenCode database is skipped, the others are read", async () => {
  const f = ocHomes();
  writeFileSync(f.homeDb, "not a database, but long enough to be read as one".repeat(4));
  const events = await collect(_oc({ store: ocStore(), config: f.config, full: true }));
  assert.deepEqual(events.map((e) => e.message_id), ["own-old", "own-new"]);
});

// --- review of plans/018: one home must not stop the others ----------------

// S1: `a` sorts before `norareit` and links its projects root to norareit's.
test("CC: a home that links its projects root to another home's does not suppress that home", async () => {
  const s = homeScratch();
  const a = join(s.dir, "homes", "a");
  mkdirSync(join(a, ".claude"), { recursive: true });
  symlinkSync(join(s.home, ".claude", "projects"), join(a, ".claude", "projects"));
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.deepEqual(events.map((e) => [e.message_id, e.project]), [["h1", "norareit"]]);
});

test("OC: a home that links its database to another home's does not suppress that home", async () => {
  const f = ocHomes();
  renameSync(f.inHome.path, f.homeDb);
  const a = join(f.dir, "homes", "a");
  mkdirSync(join(a, ".local", "share", "opencode"), { recursive: true });
  symlinkSync(f.homeDb, join(a, ".local", "share", "opencode", "opencode.db"));
  const config = { ...f.config, homes: [{ home: join(f.dir, "homes", "*") }] };
  const events = await collect(_oc({ store: ocStore(), config, full: true }));
  assert.deepEqual(
    events.map((e) => [e.message_id, e.project]),
    [["own-old", "/proj"], ["own-new", "/proj"], ["home-old", "norareit"], ["home-new", "norareit"]],
  );
});

// C1: valid JSON that is not a record, and records of the wrong shape.
const JUNK_LINES = [
  "null", "7", '"text"', "[]", "{}",
  JSON.stringify({ type: "assistant", message: null }),
  JSON.stringify({ type: "assistant", requestId: "j1", message: { usage: "lots" } }),
  JSON.stringify(assistant({ requestId: "j2", message: { model: 5 } })),
  JSON.stringify(assistant({ requestId: "j3", sessionId: { a: 1 } })),
  JSON.stringify(assistant({ requestId: "j4", timestamp: "never" })),
  JSON.stringify(assistant({ requestId: "j5", message: { usage: { input_tokens: "many", output_tokens: 1 } } })),
  JSON.stringify(assistant({ requestId: "j6", message: { usage: { input_tokens: -5, output_tokens: 1 } } })),
  JSON.stringify(assistant({ requestId: "j7", gitBranch: { x: 1 } })),
];

test("CC: unsupported records in a home are dropped; its good records and the device's own are kept", async () => {
  const s = homeScratch();
  s.writeLines([assistant()]);
  const good = JSON.stringify(assistant({ requestId: "h2", sessionId: "hs", cwd: "/work" }));
  writeFileSync(join(s.slug, "junk.jsonl"), [...JUNK_LINES, good].join("\n") + "\n");
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.deepEqual(events.map((e) => e.message_id).sort(), ["h1", "h2", "r1"]);
});

test("CC: a non-record line in the device's own transcript is ignored too", async () => {
  const s = ccScratch();
  s.write(["null", "7", JSON.stringify(assistant())].join("\n") + "\n");
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.deepEqual(events.map((e) => e.message_id), ["r1"]);
});

test("CC: a transcript in a home that cannot be read is skipped, the rest is read", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads anything");
  const s = homeScratch();
  s.writeLines([assistant()]);
  const locked = join(s.slug, "locked.jsonl");
  writeFileSync(locked, s.lines([assistant({ requestId: "h9" })]));
  chmodSync(locked, 0o000);
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  chmodSync(locked, 0o600);
  assert.deepEqual(events.map((e) => e.message_id).sort(), ["h1", "r1"]);
});

test("OC: unsupported rows in a home are dropped; its good rows and the device's own are kept", async () => {
  const f = ocHomes();
  const junk = ocDb({
    sessions: [{ id: "js", directory: "/work" }],
    messages: [
      { id: "j-null", session_id: "js", time_updated: 10, data: null },
      { id: "j-num", session_id: "js", time_updated: 11, data: 7 },
      { id: "j-tokens", session_id: "js", time_updated: 12, data: ocData({ tokens: "lots" }) },
      { id: "j-count", session_id: "js", time_updated: 13, data: ocData({ tokens: { input: "many" } }) },
      { id: "j-model", session_id: "js", time_updated: 14, data: ocData({ modelID: { a: 1 } }) },
      { id: "j-time", session_id: "js", time_updated: "soon", data: ocData() },
      { id: "good", session_id: "js", time_updated: 20, data: ocData() },
    ],
  });
  renameSync(junk.path, f.homeDb);
  const store = ocStore();
  const events = await collect(_oc({ store, config: f.config, full: false }));
  assert.deepEqual(events.map((e) => e.message_id), ["own-old", "own-new", "good"]);
  assert.equal(Number(store.getKV(`watermark:opencode:time_updated:${f.homeDb}`)), 20);
});

test("OC: a message whose data is JSON null in the device's own database is ignored", async () => {
  const { path } = ocDb({
    sessions: [{ id: "sess1", directory: "/proj" }],
    messages: [
      { id: "n", session_id: "sess1", time_updated: 100, data: null },
      { id: "a", session_id: "sess1", time_updated: 101, data: ocData() },
    ],
  });
  const events = await collect(_oc({ store: ocStore(), config: { sources: { opencode: { db: path } } }, full: true }));
  assert.deepEqual(events.map((e) => e.message_id), ["a"]);
});

// --- second review of plans/018 --------------------------------------------

// C4: coercing this token count throws inside the parser. The record must be
// dropped on its own; the valid record after it must still be read.
const UNCOERCIBLE = JSON.stringify(
  assistant({ requestId: "bad", message: { usage: { input_tokens: 1, output_tokens: { toString: null } } } }),
);

test("CC: a record whose values cannot be coerced is dropped alone, in a home", async () => {
  const s = homeScratch();
  const good = JSON.stringify(assistant({ requestId: "h2", sessionId: "hs", cwd: "/work" }));
  const path = join(s.slug, "mixed.jsonl");
  writeFileSync(path, [UNCOERCIBLE, good].join("\n") + "\n");
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: false }));
  assert.deepEqual(events.map((e) => e.message_id).sort(), ["h1", "h2"]);
  assert.ok(s.store.getFileCursor(path), "the file was read to the end and its cursor stored");
  const again = await collect(extractClaudeCode({ store: s.store, config: s.config, full: false }));
  assert.deepEqual(again, []);
});

test("CC: a record whose values cannot be coerced is dropped alone, in the device's own transcript", async () => {
  const s = ccScratch();
  s.write([UNCOERCIBLE, JSON.stringify(assistant())].join("\n") + "\n");
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.deepEqual(events.map((e) => e.message_id), ["r1"]);
});

test("CC: a home's event beyond the bounds Postgres accepts is dropped", async () => {
  const s = homeScratch();
  writeFileSync(join(s.slug, "big.jsonl"), s.lines([
    assistant({ requestId: "nul\u0000", sessionId: "hs" }),
    assistant({ requestId: "x".repeat(300), sessionId: "hs" }),
    assistant({ requestId: "huge", sessionId: "hs", message: { usage: { input_tokens: 9e15, output_tokens: 1 } } }),
    assistant({ requestId: "old", sessionId: "hs", timestamp: "-271821-04-20T00:00:00Z" }),
  ]));
  const events = await collect(extractClaudeCode({ store: s.store, config: s.config, full: true }));
  assert.deepEqual(events.map((e) => e.message_id), ["h1"]);
});

// C1, second round: values node:sqlite cannot hand over as a JavaScript number
// make the FETCH throw, so they have to be kept out by the query itself.
test("OC: integers beyond JavaScript's range in a home's database do not stop the read", async () => {
  const f = ocHomes();
  // Columns without a declared type, so SQLite stores each value as given
  // (a TEXT column would turn the integers below into harmless text).
  const db = new DatabaseSync(f.homeDb);
  const data = JSON.stringify(ocData());
  const BIG = "9223372036854775807";
  db.exec(`
    CREATE TABLE message (id, session_id, time_created, time_updated, data);
    CREATE TABLE session (id, directory, parent_id, workspace_id);
    CREATE TABLE workspace (id, branch, directory);
    INSERT INTO session VALUES ('s', ${BIG}, ${BIG}, 'w');
    INSERT INTO workspace VALUES ('w', ${BIG}, NULL);
    INSERT INTO message VALUES ('good', 's', 0, 100, '${data}');
    INSERT INTO message VALUES ('big-time', 's', 0, ${BIG}, '${data}');
    INSERT INTO message VALUES (${BIG}, 's', 0, 101, '${data}');
    INSERT INTO message VALUES ('big-data', 's', 0, 102, ${BIG});
    INSERT INTO message VALUES ('blob-data', 's', 0, 103, x'00ff');
    INSERT INTO message VALUES ('negative-time', 's', 0, -5, '${data}');
    INSERT INTO message VALUES ('text-time', 's', 0, 'soon', '${data}');
    INSERT INTO message VALUES ('real-time', 's', 0, 1.5, '${data}');
  `);
  db.close();
  const store = ocStore();
  const events = await collect(_oc({ store, config: f.config, full: false }));
  assert.deepEqual(events.map((e) => e.message_id), ["own-old", "own-new", "good"]);
  const good = events[2];
  assert.equal(good.project, "norareit");
  assert.equal(good.is_sidechain, false, "a parent_id that is not text is read as none");
  assert.equal(good.git_branch, null);
  assert.equal(Number(store.getKV(`watermark:opencode:time_updated:${f.homeDb}`)), 100);
});

test("OC: a home's database whose message is a view is skipped, the others are read", async () => {
  const f = ocHomes();
  renameSync(f.inHome.path, f.homeDb);
  const db = new DatabaseSync(f.homeDb);
  db.exec("ALTER TABLE message RENAME TO m2; CREATE VIEW message AS SELECT * FROM m2;");
  db.close();
  const events = await collect(_oc({ store: ocStore(), config: f.config, full: true }));
  assert.deepEqual(events.map((e) => e.message_id), ["own-old", "own-new"]);
});

// Review finding R3: a converted session that resumes in OpenCode 2 gets new
// 2.x messages, and its session_v2 rollups grow past the 1.x ones.
test("OC2 (R3): a resumed converted session is reconciled on 1.x plus its new 2.x messages", () => {
  const resumed = (newTokens) =>
    oc2Path({
      v2: true,
      sessions: [{ id: "s1", ...ROLL }],
      sessionsV2: [{ id: "s1", ...ROLL2 }],
      messages: [{ id: "m1", session_id: "s1", data: ocData1() }],
      messagesV2: [
        { id: "m1", session_id: "s1", data: ocData2({ time: { created: 1, completed: 2 } }) },
        ...(newTokens ? [{ id: "r1", session_id: "s1", data: ocData2({ tokens: newTokens }) }] : []),
      ],
    });
  const full = ocData2().tokens;
  const ok = _rec(resumed(full));
  assert.deepEqual([ok.v1.ok, ok.v1.total, ok.v2.ok, ok.v2.total], [1, 1, 1, 1]);
  // New usage that falls short of the 2.x rollup is caught.
  const short = _rec(resumed({ ...full, output: 9 }));
  assert.deepEqual([short.v2.ok, short.v2.total], [0, 1]);
  assert.equal(short.v2.mismatches[0].got.output, 19);
  assert.equal(short.v2.mismatches[0].want.output, 20);
  // So is a rollup that grew with no new message to account for it.
  assert.deepEqual([_rec(resumed(null)).v2.ok], [0]);
});

// Review finding R2: once OpenCode 2 replaces `workspace`, the 1.x part can no
// longer report a branch; a branch already stored must survive a re-read.
const BRANCHED = { harness: "opencode", session_id: "s1", message_id: "m1", git_branch: "topic", project: "/proj" };

function convertedWithStoredBranch() {
  const path = oc2Path({
    v2: true,
    sessions: [{ id: "s1", directory: "/proj" }],
    sessionsV2: [{ id: "s1", directory: "/proj" }],
    messages: [
      { id: "m1", session_id: "s1", time_updated: 100, data: ocData1() },
      { id: "m2", session_id: "s1", time_updated: 100, data: ocData1() },
    ],
    messagesV2: [{ id: "m1", session_id: "s1", time_updated: 100, data: ocData2() }],
  });
  const store = ocStore();
  store.record(event(BRANCHED));
  return { path, store };
}

test("OC2 (R2): a converted database keeps the stored branch on the boundary re-read and on backfill", async () => {
  const { path, store } = convertedWithStoredBranch();
  for (const full of [false, true]) {
    const events = await oc2Run(path, store, full);
    const byId = Object.fromEntries(events.map((e) => [e.message_id, e.git_branch]));
    // m1 had a branch: it keeps it. m2 was never stored with one: it stays null.
    assert.deepEqual(byId, { m1: "topic", m2: null }, `full=${full}`);
  }
});

test("OC2 (R2): a database that still has workspace.branch reports its own value, NULL included", async () => {
  const path = oc2Path({
    sessions: [{ id: "s1", directory: "/proj" }],
    messages: [{ id: "m1", session_id: "s1", time_updated: 100, data: ocData1() }],
  });
  const store = ocStore();
  store.record(event(BRANCHED));
  const events = await oc2Run(path, store, true);
  assert.equal(events[0].git_branch, null);
});

test("OC2 (R2): a converted home database keeps the stored branch too", async () => {
  const home = mkTmp();
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
  openCodeDb(join(home, ".local", "share", "opencode", "opencode.db"), {
    v2: true,
    sessions: [{ id: "s1", directory: "/work" }],
    sessionsV2: [{ id: "s1", directory: "/work" }],
    messages: [{ id: "m1", session_id: "s1", time_updated: 100, data: ocData1() }],
  });
  const store = ocStore();
  store.record(event({ ...BRANCHED, project: "/p/x" }));
  const config = { sources: { opencode: { db: join(mkTmp(), "none.db") } }, homes: [{ home, project: "/p/x" }] };
  const events = await collect(_oc({ store, config, full: true }));
  assert.deepEqual(events.map((e) => [e.message_id, e.git_branch]), [["m1", "topic"]]);
  assert.equal(readHomeDatabase(join(home, ".local", "share", "opencode", "opencode.db")).branchless, true);
});
