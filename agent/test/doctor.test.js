// doctor.test.js — the pure pieces of doctor (§7).

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactDsn } from "../src/doctor.js";
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
