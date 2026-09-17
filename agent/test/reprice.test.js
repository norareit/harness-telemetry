// reprice.test.js — compare() and scenarioRows() (§4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Pricing } from "../src/pricing.js";
import { compare, scenarioRows } from "../src/reprice.js";
import { table, event } from "./helpers.js";

const PRICING = new Pricing(table({ "anthropic/claude-sonnet-5": { input: 2, output: 10 }, "anthropic/claude-opus-5": { input: 5, output: 25 } }), {});

test("compare: an unresolvable scenario is reported, never priced as $0", () => {
  const { rows, totals, meta } = compare({
    events: [event({ input_tokens: 1_000_000 })],
    pricing: PRICING,
    scenarios: ["nope/model"],
  });
  assert.equal(meta[0].resolved, false);
  for (const r of [...rows, totals]) assert.ok(!("nope/model" in r.scenarios));
});

test("compare: --group model produces provider/model keys; unknown group throws", () => {
  const { rows } = compare({ events: [event()], pricing: PRICING, scenarios: [], groupBy: "model" });
  assert.ok(rows.some((r) => r.key === "anthropic/claude-sonnet-5"));
  assert.throws(() => compare({ events: [event()], pricing: PRICING, scenarios: [], groupBy: "bogus" }));
});

test("compare: rows sort by actual cost desc; totals sum the rows", () => {
  const { rows, totals } = compare({
    events: [event({ model: "claude-sonnet-5", cost_usd: 1 }), event({ model: "claude-opus-5", cost_usd: 5 })],
    pricing: PRICING,
    scenarios: [],
    groupBy: "model",
  });
  assert.deepEqual(rows.map((r) => r.actual_cost_usd), [5, 1]);
  assert.equal(totals.actual_cost_usd, 6);
});

test("scenarioRows: skips unresolved targets and carries the full rate card", () => {
  const pricing = new Pricing(table({ "openrouter/foo": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } }), {});
  const rows = scenarioRows({
    events: [event({ message_id: "m1", input_tokens: 1_000_000 })],
    pricing,
    scenarios: ["openrouter/foo", "nope/x"],
  });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.scenario, "openrouter/foo");
  for (const f of ["rate_input", "rate_output", "rate_cache_read", "rate_cache_write_5m", "rate_cache_write_1h", "cache_model", "tier_applied", "priced_at"]) {
    assert.ok(f in r, f);
  }
  assert.ok(r.priced_at);
});

test("scenarioRows: skips pairs the predicate reports as already priced", () => {
  const pricing = new Pricing(table({ "openrouter/foo": { input: 2, output: 10 } }), {});
  const rows = scenarioRows({
    events: [event({ message_id: "m1" })],
    pricing,
    scenarios: ["openrouter/foo"],
    alreadyPriced: () => true,
  });
  assert.equal(rows.length, 0);
});
