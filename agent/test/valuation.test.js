// valuation.test.js — the freeze/reprice policy, now unit-testable in isolation
// (plan 006 Move 1). These behaviours used to live inside sync.js and cli.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../src/local-store.js";
import { Pricing } from "../src/pricing.js";
import { DERIVED_FIELDS, makeEvent, eventKey } from "../src/record.js";
import {
  samePricingInputs,
  valuationChanged,
  valueAtIngest,
  planRevaluation,
  applyRevaluation,
} from "../src/valuation.js";
import { table, event } from "./helpers.js";

const TMP = [];
function withStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  TMP.push(dir);
  const store = new LocalStore({ dataDir: dir });
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

// --- samePricingInputs -----------------------------------------------------

test("samePricingInputs: equal inputs match; any token/provider/model change does not", () => {
  const a = event({ input_tokens: 100, cache_read_tokens: 1000 });
  assert.ok(samePricingInputs(a, { ...a }));
  for (const f of ["input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_5m_tokens", "cache_write_1h_tokens"]) {
    assert.ok(!samePricingInputs(a, { ...a, [f]: 999 }), f);
  }
  assert.ok(!samePricingInputs(a, { ...a, model: "other" }));
});

test("samePricingInputs: '' and undefined provider equal a stored null", () => {
  const a = event({ provider: null, model: null });
  assert.ok(samePricingInputs(a, { ...a, provider: "" }));
  assert.ok(samePricingInputs(a, { ...a, provider: undefined }));
  assert.ok(!samePricingInputs(a, { ...a, provider: "anthropic" }));
});

// --- valuationChanged ------------------------------------------------------

test("valuationChanged: identical valuations do not move; cost/billing/null-rate do", () => {
  const base = makeEvent(event({ cost_usd: 1, billing: "free", priced_by: "table", rate_input: 2, rate_output: 10 }));
  assert.ok(!valuationChanged(base, { ...base }));
  assert.ok(valuationChanged(base, { ...base, cost_usd: 1.0001 }));
  assert.ok(valuationChanged(base, { ...base, billing: "api" })); // C2
  assert.ok(valuationChanged(base, { ...base, rate_input: null })); // C2/C3: null ≠ number
  assert.ok(!valuationChanged({ ...base, rate_cache_read: null }, { ...base, rate_cache_read: null })); // null == null
});

// --- valueAtIngest ---------------------------------------------------------

const PRICING = new Pricing(table({ "anthropic/claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } }), {});

test("valueAtIngest: no stored row prices fresh (frozen=false)", (t) => {
  const store = withStore(t);
  const { priced, frozen } = valueAtIngest({ store, pricing: PRICING, raw: event({ input_tokens: 1_000_000 }), billing: "free" });
  assert.equal(frozen, false);
  assert.equal(priced.priced_by, "table");
  assert.equal(priced.cost_usd, 2);
});

test("valueAtIngest: unchanged inputs reuse exactly the stored DERIVED_FIELDS", (t) => {
  const store = withStore(t);
  const ev = event({
    input_tokens: 100, output_tokens: 10, reasoning_tokens: 5, cache_read_tokens: 1000,
    cost_usd: 1.5, billing: "free", priced_by: "table", cache_model: "full", tier_applied: null,
    rate_input: 2, rate_output: 10, rate_cache_read: 0.2, rate_cache_write_5m: 2.5, rate_cache_write_1h: 5,
    priced_at: "2026-09-01T10:00:05.000Z",
  });
  store.record(ev);
  const { priced, frozen } = valueAtIngest({ store, pricing: PRICING, raw: ev, billing: "free" });
  assert.equal(frozen, true);
  const expected = {};
  const made = makeEvent(ev);
  for (const k of DERIVED_FIELDS) expected[k] = made[k];
  assert.deepEqual(priced, expected);
});

test("valueAtIngest: a pre-freeze row is reused with priced_at still null", (t) => {
  const store = withStore(t);
  const ev = event({ cost_usd: 1, priced_by: "table", priced_at: null });
  store.record(ev);
  const { priced, frozen } = valueAtIngest({ store, pricing: PRICING, raw: ev, billing: "free" });
  assert.equal(frozen, true);
  assert.equal(priced.priced_at, null);
});

test("valueAtIngest: a changed token count re-prices (frozen=false)", (t) => {
  const store = withStore(t);
  const ev = event({ input_tokens: 100, cost_usd: 1, priced_by: "table" });
  store.record(ev);
  const { frozen } = valueAtIngest({ store, pricing: PRICING, raw: { ...ev, input_tokens: 999 }, billing: "free" });
  assert.equal(frozen, false);
});

// --- planRevaluation / applyRevaluation ------------------------------------

test("planRevaluation: scope filters, and only genuinely-moved rows are updates", (t) => {
  const store = withStore(t);
  // Stored with a wrong cost so repricing at PRICING moves it.
  store.record(event({ message_id: "a", input_tokens: 1_000_000, cost_usd: 999, priced_by: "table", rate_input: 2, rate_output: 10, rate_cache_read: 0.2, rate_cache_write_5m: 2.5, rate_cache_write_1h: 2.5 }));
  store.record(event({ message_id: "b", model: "other-model", cost_usd: 0, priced_by: "none" }));
  const config = { sources: { "claude-code": { billing: "free" } } };

  const all = planRevaluation({ store, pricing: PRICING, config, scope: {} });
  assert.equal(all.examined, 2);
  const scoped = planRevaluation({ store, pricing: PRICING, config, scope: { model: "anthropic/claude-sonnet-5" } });
  assert.equal(scoped.examined, 1);
  assert.equal(scoped.updates[0].ev.message_id, "a");

  const n = applyRevaluation({ store, updates: scoped.updates });
  assert.equal(n, 1);
  assert.equal(store.storedEvent(eventKey(event({ message_id: "a" }))).cost_usd, 2);
});
