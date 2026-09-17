// pricing.test.js — the rules plans 001/002 state. All rates USD per 1e6 tokens.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Pricing } from "../src/pricing.js";
import { table, event } from "./helpers.js";

const price = (entries, ev, billing = "free", overrides = {}) =>
  new Pricing(table(entries), overrides).price(ev, billing);

test("1: reasoning tokens are billed at the output rate (plan 002 Bug A)", () => {
  const r = price(
    { "anthropic/claude-sonnet-5": { input: 0, output: 25 } },
    event({ reasoning_tokens: 1_000_000 }),
  );
  assert.equal(r.cost_usd, 25);
});

test("2: missing cache_read bills at the input rate, cache_model='none' (Bug B)", () => {
  const r = price(
    { "anthropic/claude-sonnet-5": { input: 0.1, output: 0.4 } },
    event({ cache_read_tokens: 1_000_000 }),
  );
  assert.equal(r.cost_usd, 0.1);
  assert.equal(r.rate_cache_read, 0.1);
  assert.equal(r.cache_model, "none");
});

const TIERED = {
  "openrouter/qwen3.7-flash": {
    input: 0.03,
    output: 0.13,
    tiers: [
      { tier: { size: 32000 }, input: 0.1, output: 0.4 },
      { tier: { size: 256000 }, input: 0.2, output: 0.8 },
    ],
  },
};
const tieredEvent = (over) =>
  event({ provider: "openrouter", model: "qwen3.7-flash", ...over });

test("3: the highest exceeded tier wins (Bug C)", () => {
  const r = price(TIERED, tieredEvent({ input_tokens: 200_000, cache_read_tokens: 100_000 }));
  assert.equal(r.tier_applied, 256000);
  assert.equal(r.rate_input, 0.2);
});

test("3b: a middle tier", () => {
  const r = price(TIERED, tieredEvent({ input_tokens: 50_000 }));
  assert.equal(r.tier_applied, 32000);
  assert.equal(r.rate_input, 0.1);
});

test("3c: below every tier uses the base rate", () => {
  const r = price(TIERED, tieredEvent({ input_tokens: 10_000 }));
  assert.equal(r.tier_applied, null);
  assert.equal(r.rate_input, 0.03);
});

test("3d: context_over_200k without a tiers array", () => {
  const r = price(
    { "anthropic/claude-sonnet-5": { input: 2, output: 12, context_over_200k: { input: 4, output: 18 } } },
    event({ input_tokens: 250_000 }),
  );
  assert.equal(r.tier_applied, 200000);
  assert.equal(r.rate_input, 4);
});

test("4: missing cache_write bills at the input rate, cache_model='read-only' (Bug D)", () => {
  const r = price(
    { "anthropic/claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2 } },
    event({ cache_write_5m_tokens: 1_000_000 }),
  );
  assert.equal(r.cost_usd, 2);
  assert.equal(r.rate_cache_write_5m, 2);
  assert.equal(r.rate_cache_write_1h, 2);
  assert.equal(r.cache_model, "read-only");
});

test("5: Anthropic 1h cache write costs 2x input", () => {
  const r = price(
    { "anthropic/claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } },
    event({ cache_write_1h_tokens: 1_000_000 }),
  );
  assert.equal(r.cost_usd, 4);
  assert.equal(r.rate_cache_write_1h, 4);
  assert.equal(r.rate_cache_write_5m, 2.5);
});

test("5b: the 1h=2x rule is Anthropic-only (repriced onto another provider)", () => {
  const p = new Pricing(
    table({ "openrouter/foo": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } }),
    {},
  );
  const r = p.repriceEvent(event({ cache_write_1h_tokens: 1_000_000 }), "openrouter/foo");
  assert.equal(r.cost_usd, 2.5);
});

test("6: the full worked example from the README", () => {
  const r = price(
    { "anthropic/claude-sonnet-5": { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 } },
    event({
      input_tokens: 32,
      output_tokens: 1222,
      reasoning_tokens: 292,
      cache_read_tokens: 104645,
      cache_write_1h_tokens: 727,
    }),
  );
  assert.equal(r.cost_usd, 0.116721);
});

test("7: local providers are $0 before any table lookup", () => {
  for (const provider of ["ollama", "lmstudio", "llamacpp", "local"]) {
    const r = price(
      { [`${provider}/big`]: { input: 999, output: 999 } },
      event({ provider, model: "big", input_tokens: 1_000_000 }),
    );
    assert.equal(r.cost_usd, 0, provider);
    assert.equal(r.billing, "local", provider);
    assert.equal(r.priced_by, "none", provider);
    for (const f of ["rate_input", "rate_output", "rate_cache_read", "rate_cache_write_5m", "rate_cache_write_1h", "tier_applied"]) {
      assert.equal(r[f], null, `${provider} ${f}`);
    }
    assert.ok(r.priced_at, `${provider} priced_at`);
  }
});

test("8: no rate card → cost 0, priced_by none, billing preserved, rates null", () => {
  const r = price({}, event({ provider: "mystery", model: "who" }), "api");
  assert.equal(r.cost_usd, 0);
  assert.equal(r.priced_by, "none");
  assert.equal(r.billing, "api");
  assert.equal(r.rate_input, null);
  assert.ok(r.priced_at);
});

test("9: an override beats the table", () => {
  const r = price(
    { "anthropic/claude-sonnet-5": { input: 2, output: 10 } },
    event({ input_tokens: 1_000_000 }),
    "free",
    { "anthropic/claude-sonnet-5": { input: 99, output: 99 } },
  );
  assert.equal(r.priced_by, "override");
  assert.equal(r.rate_input, 99);
});

test("10: lookups are provider-scoped — no cross-provider bare-name match", () => {
  const p = new Pricing(table({ "foo/qwen3.6:27b": { input: 1, output: 1 } }), {});
  assert.equal(p.resolve("bar", "qwen3.6:27b").card, null);
});

test("10b: a bare name resolves within its own provider", () => {
  const p = new Pricing(table({ "openrouter/qwen/qwen3.7-flash": { input: 1, output: 1 } }), {});
  assert.ok(p.resolve("openrouter", "qwen3.7-flash").card);
});

test("11: resolveKey splits on the first slash only", () => {
  const p = new Pricing({}, {});
  const r = p.resolveKey("tokengo/z-ai/glm-5.2");
  assert.equal(r.provider, "tokengo");
  assert.equal(r.model, "z-ai/glm-5.2");
});

test("12: tableCard ignores overrides", () => {
  const p = new Pricing(table({ "anthropic/x": { input: 2, output: 3 } }), { "anthropic/x": { input: 99 } });
  assert.equal(p.tableCard("anthropic/x").base.input, 2);
});

test("13: cacheModelOf classifies caching support", () => {
  const p = new Pricing(
    table({
      "p/full": { input: 1, output: 1, cache_read: 0.1, cache_write: 1 },
      "p/ro": { input: 1, output: 1, cache_read: 0.1 },
      "p/none": { input: 1, output: 1 },
    }),
    {},
  );
  assert.equal(p.cacheModelOf("p/full"), "full");
  assert.equal(p.cacheModelOf("p/ro"), "read-only");
  assert.equal(p.cacheModelOf("p/none"), "none");
});
