// doctor.test.js — the pure pieces of doctor (§7).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactDsn, overrideDrift, CHECKS, CHECK_NAMES } from "../src/doctor.js";
import { Pricing } from "../src/pricing.js";
import { LocalStore } from "../src/local-store.js";
import { projectRootOf } from "../src/project.js";
import { table, event } from "./helpers.js";

// The registry's payoff: a single check runs against a hand-built context, with
// no config file, no network, no env fiddling.
const check = (name) => CHECKS.find((c) => c.name === name).run;

test("redactDsn masks a password containing @ and :, leaves the rest", () => {
  assert.equal(redactDsn("postgres://user:p@ss:w0rd@host:5432/db"), "postgres://user:***@host:5432/db");
});

test("redactDsn returns a password-less DSN and a non-URL unchanged", () => {
  assert.equal(redactDsn("postgres://user@host:5432/db"), "postgres://user@host:5432/db");
  assert.equal(redactDsn("not-a-dsn"), "not-a-dsn");
});

test("the reasoning probe: reasoning tokens equal the output rate (guards Bug A)", () => {
  const r = new Pricing(table({ "anthropic/claude-sonnet-5": { input: 0, output: 25 } }), {}).price(
    event({ reasoning_tokens: 1_000_000 }),
  );
  assert.equal(r.cost_usd, 25);
});

test("overrideDrift reports a pin with no table entry as unverifiable, not a pass (C4)", () => {
  // The table lists terra-fast only under a different provider (Vercel), so the
  // openai-keyed pin cannot be checked — it must surface, not be skipped.
  const pricing = new Pricing(
    table({ "vercel/openai/gpt-5.6-terra-fast": { input: 4, output: 24 }, "p/x": { input: 2, output: 10 } }),
    { "openai/gpt-5.6-terra-fast": { input: 4, output: 24 }, "p/x": { input: 2, output: 10 } },
  );
  const r = overrideDrift(pricing);
  assert.deepEqual(r.unverifiable, ["openai/gpt-5.6-terra-fast"]);
  assert.equal(r.checked, 1);
  assert.equal(r.drift.length, 0);
});

test("overrideDrift flags a pin that has drifted from the table", () => {
  const pricing = new Pricing(table({ "p/x": { input: 2, output: 10 } }), { "p/x": { input: 9, output: 10 } });
  const r = overrideDrift(pricing);
  assert.equal(r.drift.length, 1);
  assert.match(r.drift[0], /p\/x input/);
});

// --- checks as a registry (plan 006 Move 3) --------------------------------

test("CHECK_NAMES lists the 20 checks in order", () => {
  assert.equal(CHECK_NAMES.length, 20);
  assert.equal(CHECK_NAMES[0], "config file");
  assert.equal(CHECK_NAMES.at(-1), "projects are repo roots");
  assert.equal(CHECK_NAMES.at(-4), "postgres schema");
});

test("check 'device name' is trivially ok", () => {
  assert.deepEqual(check("device name")({ config: { device: "desktop" } }), { ok: true, detail: "desktop" });
});

test("check 'reasoning tokens billed' passes on a good table", () => {
  const pricing = new Pricing(table({ "anthropic/claude-opus-5": { input: 5, output: 25 } }), {}, { modelsPath: "/x" });
  const r = check("reasoning tokens billed")({ pricing });
  assert.equal(r.ok, true);
  assert.match(r.detail, /= \$25 \(must be \$25/);
});

test("check 'reasoning tokens billed' fails without throwing when the card is missing", () => {
  const pricing = new Pricing(table({}), {}, { modelsPath: "/x" });
  const r = check("reasoning tokens billed")({ pricing });
  assert.equal(r.ok, false);
  assert.match(r.detail, /no rate card for anthropic\/claude-opus-5/);
});

test("check 'scenarios resolve' is skipped with no scenarios, flags an unresolved one", () => {
  const pricing = new Pricing(table({ "openrouter/anthropic/claude-sonnet-5": { input: 2, output: 10 } }), {});
  assert.equal(check("scenarios resolve")({ config: { scenarios: [] }, pricing }), null);
  const bad = check("scenarios resolve")({ config: { scenarios: ["nope/model"] }, pricing });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /no rate card for: nope\/model/);
});

test("check 'override drift' reports an unverifiable pin via the registry", () => {
  const pricing = new Pricing(table({ "p/x": { input: 2, output: 10 } }), { "openai/gone": { input: 1, output: 1 } });
  const r = check("override drift")({ pricing });
  assert.match(r.detail, /1 unverifiable.*openai\/gone/);
});

test("check 'cost reproducible from stored rates' reads the shared store", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  const store = new LocalStore({ dataDir: dir });
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  // cost_usd = 1e6 * rate_input / 1e6 = 2, so recompute matches.
  store.record(event({ input_tokens: 1_000_000, cost_usd: 2, priced_by: "table", rate_input: 2, rate_output: 10, rate_cache_read: 0.2, rate_cache_write_5m: 2.5, rate_cache_write_1h: 5 }));
  const ok = check("cost reproducible from stored rates")({ store });
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /1\/1 events carry rates; 0 mismatch/);

  store.record(event({ message_id: "m2", input_tokens: 1_000_000, cost_usd: 999, priced_by: "table", rate_input: 2, rate_output: 10, rate_cache_read: 0.2, rate_cache_write_5m: 2.5, rate_cache_write_1h: 5 }));
  const bad = check("cost reproducible from stored rates")({ store });
  assert.equal(bad.ok, false);
});

test("check 'no unpriced billable events' flags a non-local unpriced event", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  const store = new LocalStore({ dataDir: dir });
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  store.record(event({ provider: "mystery", model: "who", billing: "free", priced_by: "none" }));
  const r = check("no unpriced billable events")({ store });
  assert.equal(r.ok, false);
  assert.match(r.detail, /mystery\/who \(1\)/);
});

// C1: the postgres schema check must run on its own, via ctx.postgres(), not a
// side channel populated by the connection check.
test("check 'postgres schema' reports on its own when the connection works", async () => {
  const ctx = { config: { postgres: { dsn: "postgres://x" } }, postgres: async () => ({ ok: true, gaps: { missingTables: [], missingColumns: [] } }) };
  const r = await check("postgres schema")(ctx);
  assert.equal(r.ok, true);
  assert.match(r.detail, /usage_event, usage_scenario complete/);
});

test("check 'postgres schema' reports gaps", async () => {
  const ctx = { config: { postgres: { dsn: "postgres://x" } }, postgres: async () => ({ ok: true, gaps: { missingTables: ["usage_scenario"], missingColumns: [{ table: "usage_event", column: "priced_at" }] } }) };
  const r = await check("postgres schema")(ctx);
  assert.equal(r.ok, false);
  assert.match(r.detail, /missing tables: usage_scenario; columns: usage_event\.priced_at/);
});

test("check 'postgres schema' is omitted when unconfigured or the connection fails", async () => {
  assert.equal(await check("postgres schema")({ config: { postgres: { dsn: null } } }), null);
  const failing = { config: { postgres: { dsn: "postgres://x" } }, postgres: async () => { throw new Error("refused"); } };
  assert.equal(await check("postgres schema")(failing), null);
});

// --- liveness: last sync / last ship (plans/007) ---------------------------

// A ctx whose store returns one canned kv value, with a configurable threshold.
const kvCtx = (kv, { staleAfterMinutes = 60, dsn = "postgres://x" } = {}) => ({
  config: { sync: { staleAfterMinutes }, postgres: { dsn } },
  store: { getKV: (k) => (k in kv ? kv[k] : null) },
});
const epoch = (msAgo) => String(Math.floor((Date.now() - msAgo) / 1000));

test("check 'last sync': absent key fails with a prompt to run sync", () => {
  const r = check("last sync")(kvCtx({}));
  assert.equal(r.ok, false);
  assert.match(r.detail, /never recorded — run 'harness-usage sync'/);
});

test("check 'last sync': a fresh stamp passes", () => {
  const r = check("last sync")(kvCtx({ "sync:last_run": epoch(60_000) }));
  assert.equal(r.ok, true);
  assert.match(r.detail, /min ago \(\d{4}-\d\d-\d\dT.*Z\)/);
});

test("check 'last sync': a stale stamp fails with the threshold and the log hint", () => {
  const r = check("last sync")(kvCtx({ "sync:last_run": epoch(13 * 3600_000) }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /h ago .* exceeds sync\.staleAfterMinutes=60/);
  assert.match(r.detail, /systemctl --user|launchctl print/);
});

test("check 'last sync': staleAfterMinutes is honoured", () => {
  const kv = { "sync:last_run": epoch(90 * 60_000) }; // 90 min old
  assert.equal(check("last sync")(kvCtx(kv, { staleAfterMinutes: 60 })).ok, false);
  assert.equal(check("last sync")(kvCtx(kv, { staleAfterMinutes: 120 })).ok, true);
});

test("check 'last ship': skipped (null) when no DSN is configured", () => {
  assert.equal(check("last ship")(kvCtx({}, { dsn: null })), null);
});

test("check 'last ship': reads its own key, fails when stale", () => {
  const fresh = check("last ship")(kvCtx({ "sync:last_ship_ok": epoch(0) }));
  assert.equal(fresh.ok, true);
  const stale = check("last ship")(kvCtx({ "sync:last_ship_ok": epoch(2 * 3600_000) }));
  assert.equal(stale.ok, false);
});

// --- projects are repo roots (plans/008) -----------------------------------

test("check 'projects are repo roots': flags a subdirectory of a real repo", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  const store = new LocalStore({ dataDir: dir });
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

  // A real repo with a nested working dir, plus a non-repo path — only the
  // nested one should be flagged.
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  const nested = join(repo, "agent", "src");
  mkdirSync(nested, { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  projectRootOf.cache.clear();

  store.record(event({ message_id: "a", project: nested }));
  store.record(event({ message_id: "b", project: nested }));
  store.record(event({ message_id: "c", project: "/gone/from/this/machine" }));

  const r = check("projects are repo roots")({ config: { project: { detectRoot: true } }, store });
  assert.equal(r.ok, false);
  assert.match(r.detail, /2 events under 1 subdirectory of a repo root/);
  assert.match(r.detail, /reroot-project\.mjs/);
});

test("check 'projects are repo roots': ok when all are roots, skipped when detectRoot off", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  const store = new LocalStore({ dataDir: dir });
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  projectRootOf.cache.clear();
  store.record(event({ project: "/gone/entirely" })); // resolves to itself
  const ok = check("projects are repo roots")({ config: { project: { detectRoot: true } }, store });
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /distinct projects, all repository roots/);
  assert.equal(check("projects are repo roots")({ config: { project: { detectRoot: false } }, store }), null);
});
