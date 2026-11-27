// pricing.test.js — the rules plans 001/002 state. All rates USD per 1e6 tokens.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pricing, loadPricing, hasTokens, fromCatalogCost } from "../src/pricing.js";
import { table, event, openCodeDb } from "./helpers.js";

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

// Plans 022 and 023: OpenAI's fast tiers are gateway-priced pins at 2x the base model.
for (const model of ["gpt-6.1-sol-fast", "gpt-6.2-sol-fast"]) {
  test(`14: the shipped override prices openai/${model} (plans 022, 023)`, async () => {
    const p = await loadPricing({ modelsJsonPath: "/nonexistent/models.json" });
    const { card, source } = p.resolve("openai", model);
    assert.equal(source, "override");
    assert.deepEqual(card.base, { input: 4, output: 20, cache_read: 0.2, cache_write: 5 });

    const ev = (input_tokens) => event({ provider: "openai", model, input_tokens });
    const small = p.price(ev(100_000));
    assert.equal(small.priced_by, "override");
    assert.equal(small.tier_applied, null);
    assert.equal(small.rate_input, 4);
    const large = p.price(ev(300_000));
    assert.equal(large.tier_applied, 272000);
    assert.equal(large.rate_input, 8);
    assert.equal(large.rate_output, 30);
  });
}

test("hasTokens is false only when every priced token field is zero (plan 024)", () => {
  assert.equal(hasTokens(event()), false);
  for (const f of [
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_write_5m_tokens",
    "cache_write_1h_tokens",
  ]) {
    assert.equal(hasTokens(event({ [f]: 1 })), true, f);
  }
});

// --- the OpenCode 2 catalogue (plan 025) -------------------------------------

// Catalogue costs as OpenCode 2.4.2 stores them, each next to the models.json
// cost OpenCode 1.19.6 wrote for the same model on the same day (plan 025,
// findings 11 and 12). Only the shape differs; the rates are the same.
const CATALOG_CASES = {
  "numeric cache write (opencode/big-pickle)": [
    { text: { input: { price: 0, cache: { read: 0, write: 0 } }, output: { price: 0 } } },
    { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  ],
  "5m/1h writes take 5m; multipliers ignored (anthropic/claude-opus-5)": [
    {
      text: { input: { price: 5, cache: { read: 0.5, write: { "5m": 6.25, "1h": 10 } } }, output: { price: 25 } },
      web_search: { price: 10 },
      multipliers: [{ when: { service_tier: { equals: "fast" } }, factor: { text: 2 } }],
    },
    { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  ],
  "30m/12h writes take 30m, with a context tier (openai/gpt-6.2-sol)": [
    {
      text: {
        input: {
          price: 2,
          cache: { read: 0.1, write: { "30m": 2.5, "12h": 5 } },
          overrides: [
            { when: { context: { gt: 272000 } }, price: 4, cache: { read: 0.2, write: { "30m": 5, "12h": 10 } } },
          ],
        },
        output: { price: 10, overrides: [{ when: { context: { gt: 272000 } }, price: 15 }] },
      },
      multipliers: [{ when: { service_tier: { equals: "priority" } }, factor: { text: 2 } }],
    },
    {
      input: 2, output: 10, cache_read: 0.1, cache_write: 2.5,
      tiers: [{ input: 4, output: 15, cache_read: 0.2, cache_write: 5, tier: { type: "context", size: 272000 } }],
    },
  ],
  "explicit cache write (alibaba-cn/glm-5.1)": [
    {
      text: {
        input: {
          price: 0.825,
          cache: { read: 0.165, explicit: { read: 0.0825, write: 1.03125 } },
          overrides: [
            {
              when: { context: { gt: 32000 } },
              price: 1.1,
              cache: { read: 0.22, explicit: { read: 0.11, write: 1.375 } },
            },
          ],
        },
        output: { price: 3.301, overrides: [{ when: { context: { gt: 32000 } }, price: 3.851 }] },
      },
    },
    {
      input: 0.825, output: 3.301, cache_read: 0.165, cache_write: 1.03125,
      tiers: [
        { input: 1.1, output: 3.851, cache_read: 0.22, cache_write: 1.375, tier: { type: "context", size: 32000 } },
      ],
    },
  ],
  "an override with only a cache rate keeps the base prices (nodecode/nodecode-cyber-v1)": [
    {
      text: {
        input: {
          price: 0.33,
          cache: { read: 0.009 },
          overrides: [{ when: { context: { gt: 262144 } }, cache: { read: 0.036 } }],
        },
        output: { price: 1.32 },
      },
    },
    {
      input: 0.33, output: 1.32, cache_read: 0.009,
      tiers: [{ input: 0.33, output: 1.32, cache_read: 0.036, tier: { type: "context", size: 262144 } }],
    },
  ],
  "overrides on anything but context are ignored": [
    {
      text: {
        input: {
          price: 1,
          overrides: [
            { when: { service_tier: { equals: "priority" } }, price: 2 },
            { when: { context: { gt: 1000 }, region: { equals: "us" } }, price: 3 },
            { when: { context: { gte: 5000 } }, price: 4 },
          ],
        },
        output: { price: 2, overrides: [{ when: { utc_hours: { gte: "01:00" } }, price: 9 }] },
      },
    },
    { input: 1, output: 2, tiers: [{ input: 4, output: 2, tier: { type: "context", size: 5000 } }] },
  ],
};

for (const [name, [catalog, flat]] of Object.entries(CATALOG_CASES)) {
  test(`fromCatalogCost: ${name}`, () => {
    assert.deepEqual(fromCatalogCost(catalog), flat);
  });
}

test("fromCatalogCost: no text price, a non-numeric rate, or no cost at all is a miss", () => {
  assert.equal(fromCatalogCost({ text: { input: { price: 1 } } }), null);
  assert.equal(fromCatalogCost({ text: { input: { price: 1, cache: { read: "0.1" } }, output: { price: 2 } } }), null);
  assert.equal(fromCatalogCost({ image: { output: { price: 1 } } }), null);
  assert.equal(fromCatalogCost(undefined), null);
  assert.equal(fromCatalogCost("2/10"), null);
});

test("fromCatalogCost: a converted cost prices an event exactly like the flat one, tier included", () => {
  const [catalog, flat] = CATALOG_CASES["30m/12h writes take 30m, with a context tier (openai/gpt-6.2-sol)"];
  const a = new Pricing(table({ "openai/gpt-6.2-sol": fromCatalogCost(catalog) }), {});
  const b = new Pricing(table({ "openai/gpt-6.2-sol": flat }), {});
  for (const input_tokens of [100_000, 300_000]) {
    const ev = event({ provider: "openai", model: "gpt-6.2-sol", input_tokens, output_tokens: 2000,
      reasoning_tokens: 500, cache_read_tokens: 40_000, cache_write_5m_tokens: 1000 });
    assert.deepEqual(a.price(ev), b.price(ev));
  }
});

// A catalogue row as 2.4.2 writes it: `body` is a JSON string.
function catalogValue(updatedAt, costs) {
  const body = {};
  for (const [key, cost] of Object.entries(costs)) {
    const [provider, ...rest] = key.split("/");
    body[provider] ??= { id: provider, name: provider, env: [], models: {} };
    body[provider].models[rest.join("/")] = { id: rest.join("/"), name: key, cost };
  }
  return { updatedAt, digest: "d", body: JSON.stringify(body) };
}

function pricingSources(t, { modelsAgeDays = 1, catalog, modelsJsonText } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-pricing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const modelsJson = join(dir, "models.json");
  const usable = JSON.stringify(table({ "openai/gpt-6.2-sol": { input: 2, output: 10 } }));
  writeFileSync(modelsJson, modelsJsonText ?? usable);
  const when = new Date(Date.now() - modelsAgeDays * 86_400_000);
  utimesSync(modelsJson, when, when);
  const catalogDb = join(dir, "opencode.db");
  if (catalog) catalog(catalogDb);
  return { modelsJson, catalogDb };
}

const v2Catalog = (ageDays, input = 3) => (path) =>
  openCodeDb(path, {
    v1: false,
    v2: true,
    kv: { "models-dev:v3:catalog": catalogValue(Date.now() - ageDays * 86_400_000, {
      "openai/gpt-6.2-sol": { text: { input: { price: input }, output: { price: 10 } } },
    }) },
  });

test("loadPricing: the catalogue wins when it is fresher than models.json, and is converted", async (t) => {
  const s = pricingSources(t, { modelsAgeDays: 5, catalog: v2Catalog(1) });
  const p = await loadPricing({ modelsJsonPath: s.modelsJson, catalogDbPath: s.catalogDb });
  assert.equal(p.meta.source, "catalog");
  assert.equal(p.meta.modelsPath, `${s.catalogDb}#kv:models-dev:v3:catalog`);
  assert.ok(Date.now() - p.meta.updatedAt < 2 * 86_400_000);
  assert.equal(p.meta.tableError, null);
  assert.deepEqual(p.resolve("openai", "gpt-6.2-sol").card.base, {
    input: 3, output: 10, cache_read: null, cache_write: null,
  });
});

test("loadPricing: models.json wins when it is fresher than the catalogue", async (t) => {
  const s = pricingSources(t, { modelsAgeDays: 1, catalog: v2Catalog(5) });
  const p = await loadPricing({ modelsJsonPath: s.modelsJson, catalogDbPath: s.catalogDb });
  assert.equal(p.meta.source, "models.json");
  assert.equal(p.meta.modelsPath, s.modelsJson);
  assert.equal(p.resolve("openai", "gpt-6.2-sol").card.base.input, 2);
});

// Every way the catalogue can be absent is a normal case, never a price-table
// error: on a device still on OpenCode 1 it is absent every time.
const ABSENT = {
  "no file at catalogDb": () => {},
  "a 1.19.6 database, which has no kv table": (path) => openCodeDb(path, {}),
  "a kv table without the catalogue row": (path) =>
    openCodeDb(path, { v1: false, v2: true, kv: { "migration.v1-v2": { phase: "completed" } } }),
  "a body that does not parse": (path) =>
    openCodeDb(path, {
      v1: false, v2: true, kv: { "models-dev:v3:catalog": { updatedAt: Date.now(), body: "{not json" } },
    }),
  "a file that is not a database": (path) => writeFileSync(path, "not a database".repeat(20)),
};

for (const [name, make] of Object.entries(ABSENT)) {
  test(`loadPricing: ${name} falls back to models.json`, async (t) => {
    const s = pricingSources(t, { catalog: make });
    const p = await loadPricing({ modelsJsonPath: s.modelsJson, catalogDbPath: s.catalogDb });
    assert.equal(p.meta.tableError, null);
    assert.equal(p.meta.source, "models.json");
    assert.equal(p.meta.modelsPath, s.modelsJson);
    assert.equal(p.resolve("openai", "gpt-6.2-sol").source, "table");
  });
}

test("loadPricing: with neither source the table fails to load, as before", async (t) => {
  const s = pricingSources(t, { catalog: ABSENT["a 1.19.6 database, which has no kv table"] });
  const p = await loadPricing({ modelsJsonPath: join(s.catalogDb, "..", "missing.json"), catalogDbPath: s.catalogDb });
  assert.ok(p.meta.tableError);
  assert.equal(p.meta.source, null);
  assert.equal(p.meta.updatedAt, null);
});

test("loadPricing: without catalogDbPath only models.json is read, dated by its mtime", async (t) => {
  const s = pricingSources(t, { modelsAgeDays: 3, catalog: v2Catalog(0) });
  const p = await loadPricing({ modelsJsonPath: s.modelsJson });
  assert.equal(p.meta.source, "models.json");
  assert.ok(Math.abs(Date.now() - p.meta.updatedAt - 3 * 86_400_000) < 60_000);
});

// Review finding R1: an unusable catalogue must not displace a working models.json.
const catalogRow = (value, kvTimeUpdated = Date.now()) => (path) =>
  openCodeDb(path, { v1: false, v2: true, kv: { "models-dev:v3:catalog": value }, kvTimeUpdated });
const UNUSABLE = {
  "an empty body": [catalogRow({ updatedAt: Date.now(), digest: "d", body: "{}" }), /no usable rate card/],
  "a body whose models have no usable cost": [
    catalogRow({
      updatedAt: Date.now(),
      body: JSON.stringify({ openai: { models: { "gpt-6.2-sol": { cost: { text: { input: { price: 2 } } } } } } }),
    }),
    /no usable rate card/,
  ],
  "models given as an array (R4)": [
    catalogRow({
      updatedAt: Date.now(),
      body: JSON.stringify({
        openai: { models: [{ cost: { text: { input: { price: 3 }, output: { price: 10 } } } }] },
      }),
    }),
    /no usable rate card/,
  ],
  "no updatedAt of its own, however new the row is": [
    catalogRow({ digest: "d", body: catalogValue(0, { "openai/gpt-6.2-sol": { text: { input: { price: 3 },
      output: { price: 10 } } } }).body }),
    /updatedAt/,
  ],
  "an updatedAt that is not a positive number": [
    catalogRow({ ...catalogValue(0, { "openai/gpt-6.2-sol": { text: { input: { price: 3 }, output: { price: 10 } } } }),
      updatedAt: "2026-11-27" }),
    /updatedAt/,
  ],
  "a body that does not parse": [catalogRow({ updatedAt: Date.now(), body: "{not json" }), /parse|JSON/],
};

for (const [name, [make, reason]] of Object.entries(UNUSABLE)) {
  test(`loadPricing (R1): a catalogue with ${name} is ignored and says why`, async (t) => {
    const s = pricingSources(t, { modelsAgeDays: 5, catalog: make });
    const p = await loadPricing({ modelsJsonPath: s.modelsJson, catalogDbPath: s.catalogDb });
    assert.equal(p.meta.source, "models.json");
    assert.equal(p.meta.tableError, null);
    assert.equal(p.price(event({ provider: "openai", model: "gpt-6.2-sol", input_tokens: 10 })).priced_by, "table");
    assert.match(p.meta.ignored.join("; "), reason);
  });
}

test("loadPricing (R1): an absent catalogue is not reported as ignored", async (t) => {
  const absent = [
    () => {}, // no file
    (path) => openCodeDb(path, {}), // 1.19.6: no kv table
    (path) => openCodeDb(path, { v1: false, v2: true, kv: { "migration.v1-v2": { phase: "completed" } } }), // no row
  ];
  for (const make of absent) {
    const s = pricingSources(t, { catalog: make });
    const p = await loadPricing({ modelsJsonPath: s.modelsJson, catalogDbPath: s.catalogDb });
    assert.equal(p.meta.source, "models.json");
    assert.deepEqual(p.meta.ignored, []);
  }
});

test("loadPricing (R1): with no models.json, an unusable catalogue leaves the table failed to load", async (t) => {
  const s = pricingSources(t, { catalog: UNUSABLE["an empty body"][0] });
  const p = await loadPricing({ modelsJsonPath: join(s.catalogDb, "..", "missing.json"), catalogDbPath: s.catalogDb });
  assert.ok(p.meta.tableError);
  assert.equal(p.meta.source, null);
});

// Review finding R4: models.json must be usable before it competes, too.
const UNUSABLE_MODELS_JSON = {
  "an empty object": "{}",
  "models given as an array": JSON.stringify({ openai: { models: [{ cost: { input: 2, output: 10 } }] } }),
  "no entry with a numeric input and output": JSON.stringify({
    openai: { models: { "gpt-6.2-sol": { cost: { input: "2", output: 10 } }, "gpt-x": { name: "no cost" } } },
  }),
  "a top-level array": JSON.stringify([{ models: {} }]),
  "text that does not parse": "{not json",
};

for (const [name, text] of Object.entries(UNUSABLE_MODELS_JSON)) {
  test(`loadPricing (R4): a newer models.json with ${name} does not beat a working catalogue`, async (t) => {
    const s = pricingSources(t, { modelsAgeDays: 0, modelsJsonText: text, catalog: v2Catalog(3) });
    const p = await loadPricing({ modelsJsonPath: s.modelsJson, catalogDbPath: s.catalogDb });
    assert.equal(p.meta.source, "catalog");
    assert.equal(p.meta.tableError, null);
    assert.equal(p.price(event({ provider: "openai", model: "gpt-6.2-sol", input_tokens: 10 })).priced_by, "table");
    assert.equal(p.meta.ignored.length, 1);
    assert.ok(p.meta.ignored[0].startsWith(`${s.modelsJson}: `), p.meta.ignored[0]);
  });

  test(`loadPricing (R4): a models.json with ${name} and no catalogue fails to load`, async (t) => {
    const s = pricingSources(t, { modelsJsonText: text });
    const p = await loadPricing({ modelsJsonPath: s.modelsJson, catalogDbPath: s.catalogDb });
    assert.ok(p.meta.tableError);
    assert.equal(p.meta.source, null);
    assert.equal(p.meta.updatedAt, null);
  });
}

test("loadPricing (R4): a missing models.json is not reported as ignored", async (t) => {
  const s = pricingSources(t, { catalog: v2Catalog(1) });
  const p = await loadPricing({ modelsJsonPath: join(s.catalogDb, "..", "missing.json"), catalogDbPath: s.catalogDb });
  assert.equal(p.meta.source, "catalog");
  assert.deepEqual(p.meta.ignored, []);
});
