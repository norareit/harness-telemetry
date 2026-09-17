// sources.test.js — the extractors against synthetic fixtures (§5).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalStore } from "../src/local-store.js";
import { extractClaudeCode } from "../src/sources/claude-code.js";
import { extractOpenCode as _oc, reconcile as _rec } from "../src/sources/opencode.js";

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
  const okr = _rec(match.path);
  assert.equal(okr.ok, okr.total);
  assert.equal(okr.mismatches.length, 0);

  const off = ocDb({
    sessions: [{ id: "s1", tokens_input: 101, tokens_output: 10, tokens_reasoning: 5, tokens_cache_read: 1000, tokens_cache_write: 50 }],
    messages: [{ id: "m1", session_id: "s1", time_updated: 1, data: ocData() }],
  });
  const badr = _rec(off.path);
  assert.equal(badr.mismatches.length, 1);
});
