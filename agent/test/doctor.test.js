// doctor.test.js — the pure pieces of doctor (§7).

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactDsn, overrideDrift } from "../src/doctor.js";
import { Pricing } from "../src/pricing.js";
import { table, event } from "./helpers.js";

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
