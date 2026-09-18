// local-store.test.js — the store, the freeze, scenarios, the archive (§3).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../src/local-store.js";
import { eventKey, makeEvent } from "../src/record.js";
import { event, readOutbox } from "./helpers.js";

function withStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  const store = new LocalStore({ dataDir: dir });
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store };
}

function archiveLines(dir) {
  const evDir = join(dir, "events");
  if (!existsSync(evDir)) return [];
  return readdirSync(evDir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(evDir, f), "utf8").split("\n").filter((l) => l.trim()));
}

// --- record() --------------------------------------------------------------

test("record: first call is 'new', one archive line, one v2 hash", (t) => {
  const { dir, store } = withStore(t);
  const st = store.record(event({ output_tokens: 5 }));
  assert.equal(st, "new");
  assert.equal(archiveLines(dir).length, 1);
  const { hash } = store.db.prepare("SELECT hash FROM archived WHERE pk=?").get(eventKey(event()));
  assert.ok(hash.startsWith("v2:"));
});

test("record: identical payload is 'unchanged' and leaves synced alone", (t) => {
  const { dir, store } = withStore(t);
  store.record(event({ output_tokens: 5 }));
  store.db.prepare("UPDATE outbox SET synced=1 WHERE pk=?").run(eventKey(event()));
  const st = store.record(event({ output_tokens: 5 }));
  assert.equal(st, "unchanged");
  assert.equal(archiveLines(dir).length, 1);
  assert.equal(store.db.prepare("SELECT synced FROM outbox WHERE pk=?").get(eventKey(event())).synced, 1);
});

test("record: a derived-only change re-ships but appends no archive line", (t) => {
  const { dir, store } = withStore(t);
  store.record(event({ output_tokens: 5, cost_usd: 0.1 }));
  store.db.prepare("UPDATE outbox SET synced=1 WHERE pk=?").run(eventKey(event()));
  const st = store.record(event({ output_tokens: 5, cost_usd: 0.2 }));
  assert.equal(st, "changed");
  assert.equal(store.db.prepare("SELECT synced FROM outbox WHERE pk=?").get(eventKey(event())).synced, 0);
  assert.equal(archiveLines(dir).length, 1);
});

test("record: a source change appends a new archive line", (t) => {
  const { dir, store } = withStore(t);
  store.record(event({ output_tokens: 5 }));
  const st = store.record(event({ output_tokens: 6 }));
  assert.equal(st, "changed");
  assert.equal(archiveLines(dir).length, 2);
});

test("record: a legacy hash is re-stamped without re-appending", (t) => {
  const { dir, store } = withStore(t);
  const key = eventKey(event());
  store.record(event({ output_tokens: 5 }));
  store.db.prepare("UPDATE archived SET hash=? WHERE pk=?").run("legacy-no-prefix", key);
  const before = archiveLines(dir).length;
  store.record(event({ output_tokens: 5 }));
  assert.equal(archiveLines(dir).length, before);
  assert.ok(store.db.prepare("SELECT hash FROM archived WHERE pk=?").get(key).hash.startsWith("v2:"));
});

// --- storedEvent() — data only; the freeze policy lives in valuation.test.js --

test("storedEvent returns the parsed payload, or null when absent", (t) => {
  const { store } = withStore(t);
  assert.equal(store.storedEvent(eventKey(event())), null);
  const ev = event({ cost_usd: 1.5, input_tokens: 100, priced_by: "table" });
  store.record(ev);
  const got = store.storedEvent(eventKey(ev));
  assert.equal(got.cost_usd, 1.5);
  assert.equal(got.input_tokens, 100);
  assert.equal(got.priced_by, "table");
});

// --- scenarios -------------------------------------------------------------

const scenarioRow = (over = {}) => ({
  harness: "claude-code",
  session_id: "s1",
  message_id: "m1",
  scenario: "openrouter/x",
  cost_usd: 1,
  cache_model: "full",
  priced_by: "table",
  tier_applied: null,
  rate_input: 2,
  rate_output: 10,
  rate_cache_read: 0.2,
  rate_cache_write_5m: 2.5,
  rate_cache_write_1h: 5,
  priced_at: "2026-09-01T10:00:05.000Z",
  ...over,
});

test("existingScenarioPairs: true for a stored pair, false for a new scenario", (t) => {
  const { store } = withStore(t);
  store.recordScenarios([scenarioRow()]);
  const pred = store.existingScenarioPairs();
  assert.ok(pred(event(), "openrouter/x"));
  assert.ok(!pred(event(), "openrouter/y"));
});

test("recordScenarios: identical payload keeps synced, a changed cost resets it", (t) => {
  const { store } = withStore(t);
  const pk = eventKey(event());
  store.recordScenarios([scenarioRow()]);
  store.db.prepare("UPDATE outbox_scenario SET synced=1").run();
  store.recordScenarios([scenarioRow()]);
  assert.equal(store.db.prepare("SELECT synced FROM outbox_scenario WHERE pk=? AND scenario=?").get(pk, "openrouter/x").synced, 1);
  store.recordScenarios([scenarioRow({ cost_usd: 2 })]);
  assert.equal(store.db.prepare("SELECT synced FROM outbox_scenario WHERE pk=? AND scenario=?").get(pk, "openrouter/x").synced, 0);
});

test("dropScenario removes only that scenario and returns the count", (t) => {
  const { store } = withStore(t);
  store.recordScenarios([scenarioRow({ scenario: "a" }), scenarioRow({ scenario: "b" })]);
  assert.equal(store.dropScenario("a"), 1);
  const left = store.db.prepare("SELECT DISTINCT scenario FROM outbox_scenario").all().map((r) => r.scenario);
  assert.deepEqual(left, ["b"]);
});

test("pruneScenarios removes de-configured scenarios and returns their names", (t) => {
  const { store } = withStore(t);
  store.recordScenarios([scenarioRow({ scenario: "a" }), scenarioRow({ scenario: "b" })]);
  assert.deepEqual(store.pruneScenarios(["a"]).sort(), ["b"]);
  const left = store.db.prepare("SELECT DISTINCT scenario FROM outbox_scenario").all().map((r) => r.scenario);
  assert.deepEqual(left, ["a"]);
});

// --- outbox ----------------------------------------------------------------

test("unsynced is ordered by ts; markSynced empties it", (t) => {
  const { store } = withStore(t);
  store.record(event({ message_id: "a", ts: "2026-09-01T10:00:02Z" }));
  store.record(event({ message_id: "b", ts: "2026-09-01T10:00:01Z" }));
  const u = store.unsynced();
  assert.deepEqual(u.map((x) => x.event.message_id), ["b", "a"]);
  store.markSynced(u.map((x) => x.pk));
  assert.equal(store.unsynced().length, 0);
});

test("transaction() rolls back on throw", (t) => {
  const { store } = withStore(t);
  assert.throws(() =>
    store.transaction(() => {
      store.record(event({ message_id: "x" }));
      throw new Error("boom");
    }),
  );
  assert.equal(store.unsynced().length, 0);
});

// --- archive round-trip ----------------------------------------------------

test("compactArchive keeps the last line per key and retains unparseable lines", (t) => {
  const { dir, store } = withStore(t);
  const line = (over) => JSON.stringify(makeEvent(event({ message_id: "k1", ...over })));
  const p = join(dir, "events", "2026-09-01.jsonl");
  writeFileSync(p, [line({ cost_usd: 0.1 }), line({ cost_usd: 0.2 }), "not-json{"].join("\n") + "\n");
  const r = store.compactArchive();
  assert.equal(r.linesAfter, 2);
  assert.equal(r.removed, 1);
  const kept = archiveLines(dir);
  assert.ok(kept.some((l) => l.includes("not-json{")));
  const parsed = kept.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  assert.equal(parsed.find((e) => e.message_id === "k1").cost_usd, 0.2);
});

test("importArchive restores missing events and leaves present ones untouched", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  const store = new LocalStore({ dataDir: dir });
  store.record(event({ message_id: "k1", output_tokens: 10, cost_usd: 0.1 }));
  store.record(event({ message_id: "k1", output_tokens: 20, cost_usd: 0.2 })); // source change → 2 lines
  store.record(event({ message_id: "k2", output_tokens: 5, cost_usd: 0.05 }));
  store.close();

  for (const f of readdirSync(dir)) if (f.startsWith("state.sqlite")) unlinkSync(join(dir, f));

  const store2 = new LocalStore({ dataDir: dir });
  t.after(() => {
    try {
      store2.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  store2.record(event({ message_id: "k2", output_tokens: 5, cost_usd: 0.99 })); // live value, newer than archive

  const r = store2.importArchive();
  assert.equal(r.restored, 1);
  assert.equal(r.present, 1);

  const outbox = readOutbox(dir);
  assert.equal(outbox.find((e) => e.message_id === "k2").cost_usd, 0.99);
  assert.equal(outbox.find((e) => e.message_id === "k1").output_tokens, 20);

  const before = archiveLines(dir).length;
  const st = store2.record(event({ message_id: "k1", output_tokens: 20, cost_usd: 0.2 }));
  assert.equal(st, "unchanged");
  assert.equal(archiveLines(dir).length, before);
});

// --- resetCursors and the liveness kv keys (plans/007) ---------------------

test("resetCursors clears cursors and watermark:%, but keeps sync:% liveness keys", (t) => {
  const { store } = withStore(t);
  store.setFileCursor("/some/transcript.jsonl", { inode: 1, offset: 42, size: 42 });
  store.setKV("watermark:opencode", "12345");
  store.setKV("sync:last_run", "1758000000");
  store.setKV("sync:last_ship_ok", "1758000000");

  store.resetCursors();

  // backfill resets cursors so the harnesses are re-read from scratch...
  assert.equal(store.getFileCursor("/some/transcript.jsonl"), null);
  assert.equal(store.getKV("watermark:opencode"), null);
  // ...but the liveness clock must survive it, or every backfill would blind
  // doctor's staleness checks (plans/007).
  assert.equal(store.getKV("sync:last_run"), "1758000000");
  assert.equal(store.getKV("sync:last_ship_ok"), "1758000000");
});
