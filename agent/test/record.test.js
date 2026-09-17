// record.test.js — the canonical event shape (§2).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeEvent,
  eventKey,
  eventDay,
  FIELD_ORDER,
  DERIVED_FIELDS,
} from "../src/record.js";
import { event } from "./helpers.js";

test("makeEvent coerces token counts with int()", () => {
  const e = makeEvent(event({ input_tokens: "12.6", output_tokens: -5, cache_read_tokens: undefined }));
  assert.equal(e.input_tokens, 13);
  assert.equal(e.output_tokens, 0);
  assert.equal(e.cache_read_tokens, 0);
});

test("rate_* and tier_applied: undefined becomes null, 0 stays 0", () => {
  const e = makeEvent(event({ rate_input: undefined, rate_output: 0, tier_applied: undefined }));
  assert.equal(e.rate_input, null);
  assert.equal(e.rate_output, 0);
  assert.equal(e.tier_applied, null);
});

test("priced_at: absent → null; a Date or epoch → ISO string", () => {
  assert.equal(makeEvent(event()).priced_at, null);
  assert.equal(
    makeEvent(event({ priced_at: new Date("2026-09-01T10:00:00Z") })).priced_at,
    "2026-09-01T10:00:00.000Z",
  );
  assert.equal(
    makeEvent(event({ priced_at: Date.parse("2026-09-01T10:00:00Z") })).priced_at,
    "2026-09-01T10:00:00.000Z",
  );
});

test("eventKey joins harness/session/message with the unit separator", () => {
  const e = makeEvent(event({ harness: "h", session_id: "s", message_id: "m" }));
  assert.equal(eventKey(e), ["h", "s", "m"].join(""));
});

test("eventDay is the UTC date of the timestamp", () => {
  assert.equal(eventDay(makeEvent(event({ ts: "2026-09-01T23:30:00Z" }))), "2026-09-01");
  // An offset that crosses midnight resolves in UTC.
  assert.equal(eventDay(makeEvent(event({ ts: "2026-09-01T23:30:00-05:00" }))), "2026-09-02");
});

test("DERIVED_FIELDS ⊆ FIELD_ORDER and contains priced_at (plan 004)", () => {
  for (const f of DERIVED_FIELDS) assert.ok(FIELD_ORDER.includes(f), f);
  assert.ok(DERIVED_FIELDS.has("priced_at"));
});
