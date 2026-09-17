// cli.test.js — end to end, through the real entry point (§8). Tests 4, 7 and 8
// are red until the C1 and C2 fixes land.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scratch, readOutbox, readScenarios } from "./helpers.js";

const SCEN = "openrouter/anthropic/claude-sonnet-5";

const rec = (requestId, { output = 1000 } = {}) => ({
  type: "assistant",
  requestId,
  uuid: requestId,
  sessionId: "sess1",
  timestamp: "2026-09-01T10:00:00Z",
  cwd: "/p",
  gitBranch: "main",
  message: {
    model: "claude-sonnet-5",
    usage: {
      input_tokens: 100,
      output_tokens: output,
      output_tokens_details: { thinking_tokens: 200 },
      cache_read_input_tokens: 1000,
    },
  },
});

function seeded(t, config = {}) {
  const s = scratch();
  t.after(s.cleanup);
  s.writeConfig({ scenarios: [SCEN], ...config });
  s.writeTranscript([rec("r1"), rec("r2")]);
  const first = s.run("sync", "--no-ship");
  assert.equal(first.code, 0, first.stderr);
  s.first = first; // the seeding sync's result, for tests that assert on it
  return s;
}

function countArchive(dataDir) {
  const evDir = join(dataDir, "events");
  if (!existsSync(evDir)) return 0;
  return readdirSync(evDir)
    .filter((f) => f.endsWith(".jsonl"))
    .reduce((n, f) => n + readFileSync(join(evDir, f), "utf8").split("\n").filter((l) => l.trim()).length, 0);
}

function nullRatesFor(dataDir, messageId) {
  const db = new DatabaseSync(join(dataDir, "state.sqlite"));
  try {
    for (const row of db.prepare("SELECT pk, payload FROM outbox").all()) {
      const p = JSON.parse(row.payload);
      if (p.message_id !== messageId) continue;
      for (const f of ["rate_input", "rate_output", "rate_cache_read", "rate_cache_write_5m", "rate_cache_write_1h", "tier_applied"]) p[f] = null;
      p.priced_at = null;
      db.prepare("UPDATE outbox SET payload=? WHERE pk=?").run(JSON.stringify(p), row.pk);
    }
  } finally {
    db.close();
  }
}

test("1: sync prices at ingest — two events, two scenario rows, priced_at ~now", (t) => {
  const s = seeded(t);
  assert.match(s.first.stdout, /recorded new=2/);
  const scen = readScenarios(s.dataDir);
  assert.equal(scen.length, 2);
  for (const r of scen) {
    assert.ok(r.priced_at, "scenario priced_at");
    assert.ok(Date.now() - Date.parse(r.priced_at) < 60_000);
  }
  const events = readOutbox(s.dataDir);
  for (const e of events) assert.ok(Date.now() - Date.parse(e.priced_at) < 60_000);
});

test("2: the freeze holds across backfill", (t) => {
  const s = seeded(t);
  const ov = s.writeOverrides({ "anthropic/claude-sonnet-5": { input: 2, output: 999, cache_read: 0.2, cache_write: 2.5 } });
  s.writeConfig({ scenarios: [SCEN], pricing: { overrides: ov } });
  const before = readOutbox(s.dataDir);
  const r = s.run("backfill", "--no-ship");
  assert.match(r.stdout, /frozen: 2/);
  const after = readOutbox(s.dataDir);
  for (const e of after) {
    const b = before.find((x) => x.message_id === e.message_id);
    assert.equal(e.cost_usd, b.cost_usd);
    assert.equal(e.priced_at, b.priced_at);
  }
});

test("3: two syncs generate zero new scenario rows", (t) => {
  const s = seeded(t);
  s.run("sync", "--no-ship");
  assert.equal(readScenarios(s.dataDir).length, 2);
});

test("4: changed tokens re-price the event AND its scenario rows (C1)", (t) => {
  const s = seeded(t);
  const evBefore = readOutbox(s.dataDir).find((e) => e.message_id === "r1");
  const scBefore = readScenarios(s.dataDir).find((r) => r.message_id === "r1");
  const sc2Before = readScenarios(s.dataDir).find((r) => r.message_id === "r2");

  s.writeTranscript([rec("r1", { output: 3000 }), rec("r2")]);
  const r = s.run("backfill", "--no-ship");
  assert.equal(r.code, 0, r.stderr);

  const evAfter = readOutbox(s.dataDir).find((e) => e.message_id === "r1");
  assert.notEqual(evAfter.cost_usd, evBefore.cost_usd);
  assert.ok(Date.parse(evAfter.priced_at) > Date.parse(evBefore.priced_at));

  const scAfter = readScenarios(s.dataDir).find((r) => r.message_id === "r1");
  assert.equal(scAfter.cost_usd, evAfter.cost_usd, "scenario cost must follow the token correction");
  assert.ok(Date.parse(scAfter.priced_at) > Date.parse(scBefore.priced_at));

  const sc2After = readScenarios(s.dataDir).find((r) => r.message_id === "r2");
  assert.equal(sc2After.cost_usd, sc2Before.cost_usd, "untouched event's scenario must not move");
  assert.equal(sc2After.priced_at, sc2Before.priced_at);
});

test("5: reprice --dry-run writes nothing", (t) => {
  const s = seeded(t);
  const ov = s.writeOverrides({ "anthropic/claude-sonnet-5": { input: 2, output: 999, cache_read: 0.2, cache_write: 2.5 } });
  s.writeConfig({ scenarios: [SCEN], pricing: { overrides: ov } });
  const before = readOutbox(s.dataDir);
  const r = s.run("reprice", "--dry-run");
  assert.match(r.stdout, /2 would change/);
  assert.deepEqual(readOutbox(s.dataDir), before);
});

test("6: reprice applies a pin and stamps a new priced_at", (t) => {
  const s = seeded(t);
  const before = readOutbox(s.dataDir).find((e) => e.message_id === "r1");
  const ov = s.writeOverrides({ "anthropic/claude-sonnet-5": { input: 2, output: 999, cache_read: 0.2, cache_write: 2.5 } });
  s.writeConfig({ scenarios: [SCEN], pricing: { overrides: ov } });
  const r = s.run("reprice", "--model", "anthropic/claude-sonnet-5");
  assert.equal(r.code, 0, r.stderr);
  const after = readOutbox(s.dataDir).find((e) => e.message_id === "r1");
  assert.notEqual(after.cost_usd, before.cost_usd);
  assert.ok(Date.parse(after.priced_at) > Date.parse(before.priced_at));
  assert.equal(after.synced, 0);
});

test("7: reprice picks up a billing change (C2)", (t) => {
  const s = seeded(t);
  const before = readOutbox(s.dataDir);
  s.writeConfig({ scenarios: [SCEN], sources: { "claude-code": { billing: "api" } } });
  const r = s.run("reprice");
  assert.equal(r.code, 0, r.stderr);
  const after = readOutbox(s.dataDir);
  for (const e of after) {
    assert.equal(e.billing, "api");
    assert.equal(e.cost_usd, before.find((x) => x.message_id === e.message_id).cost_usd);
  }
});

test("8: reprice fills missing rates (C2)", (t) => {
  const s = seeded(t);
  nullRatesFor(s.dataDir, "r1");
  const r = s.run("reprice");
  assert.equal(r.code, 0, r.stderr);
  const after = readOutbox(s.dataDir).find((e) => e.message_id === "r1");
  assert.equal(after.rate_input, 2);
  assert.ok(after.priced_at);
});

test("9: strict flags — reprice --dryrun and --model <flag> exit 2, write nothing", (t) => {
  const s = seeded(t);
  const before = readOutbox(s.dataDir);
  assert.equal(s.run("reprice", "--dryrun").code, 2);
  assert.equal(s.run("reprice", "--model", "--dry-run").code, 2);
  assert.deepEqual(readOutbox(s.dataDir), before);
});

test("10: restore-archive then sync recovers without duplicating the archive", (t) => {
  const s = seeded(t);
  for (const f of readdirSync(s.dataDir)) if (f.startsWith("state.sqlite")) unlinkSync(join(s.dataDir, f));
  const restore = s.run("restore-archive");
  assert.match(restore.stdout, /restored 2/);
  const linesBefore = countArchive(s.dataDir);
  const sync = s.run("sync", "--no-ship");
  assert.match(sync.stdout, /unchanged=2/);
  assert.equal(countArchive(s.dataDir), linesBefore);
});
