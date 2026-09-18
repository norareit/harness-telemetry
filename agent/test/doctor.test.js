// doctor.test.js — the pure pieces of doctor (§7).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactDsn, overrideDrift, CHECKS, CHECK_NAMES } from "../src/doctor.js";
import { Pricing } from "../src/pricing.js";
import { LocalStore } from "../src/local-store.js";
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

test("CHECK_NAMES lists the 17 checks in order", () => {
  assert.equal(CHECK_NAMES.length, 17);
  assert.equal(CHECK_NAMES[0], "config file");
  assert.equal(CHECK_NAMES.at(-1), "postgres schema");
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
