# Don't flag zero-token events as unpriced

Type: bug
Status: Implemented. On the desktop client: doctor 22/22, the 2 zero-token terra-flex events no longer flagged;
no override added, no reprice run. npm test 211/211. No existing sync test covered the unpriced report.

## What is broken

`harness-usage doctor` fails one check:

```
[FAIL] no unpriced billable events
       2 events with no rate card: openai/gpt-5.6-terra-flex (2) — add to pricing-overrides.json, then
       'harness-usage reprice --unpriced-only'
```

Both events come from one OpenCode extra home (plan 018), from a `reviewer` agent on 2026-11-21. Neither is real
usage. OpenAI rejected both requests:

```
"tokens": {"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}, "cost": 0,
"error": {"name":"APIError","data":{"message":"Bad Request: {\"detail\":\"Unsupported service_tier: flex\"}",
          "statusCode":400, ...}}
```

`gpt-5.6-terra-flex` is the Flex service tier selected through the model name, and the API refused it, so nothing was
billed. The price table has no `terra-flex` entry under any provider. The fix the check suggests, pinning a rate in
`pricing-overrides.json`, would add a made-up price for a model that never ran, and the pin would show up in
`override drift` as unverifiable from then on. It would not change any value either: every rate times zero tokens is
$0.

`checkNoUnpricedBillable` in `agent/src/doctor.js` counts every non-local event with `priced_by = 'none'`. It does not
check whether the event has any tokens to price. The sync report does the same (`agent/src/sync.js`, the
`report.unpriced` set), so sync warns about the model too.

## What it should be

An event with no tokens costs $0 under any rate card, so a missing rate card loses nothing. It should not fail the
check, and sync should not report it as unpriced. Events that have tokens and no rate card are still flagged, as
before.

The events stay stored unchanged: `priced_by = 'none'`, cost 0. That is accurate, and pricing stays frozen at ingest
(plan 004). Ingest itself does not change: errored messages are still recorded.

## Changes

1. Add a small exported helper, `hasTokens(ev)`, in `agent/src/pricing.js` (next to the code that reads the token
   fields): true when any of `input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_tokens`,
   `cache_write_5m_tokens`, `cache_write_1h_tokens` is non-zero.
2. `agent/src/doctor.js`, `checkNoUnpricedBillable`: skip events where `!hasTokens(e)`. Keep the existing comment and
   add one line saying why zero-token events are skipped (failed requests, $0 under any rate).
3. `agent/src/sync.js`: only add to `report.unpriced` when `hasTokens(raw)`.
4. Tests:
   - `agent/test/doctor.test.js`, next to the existing "flags a non-local unpriced event" test: an unpriced non-local
     event with all-zero tokens passes the check; an unpriced event with tokens still fails it.
   - Unit test for `hasTokens` (zero event → false; each single non-zero field → true).
   - If `agent/test/` already covers the sync unpriced report, add a zero-token case there too.
   - `npm test` in `agent/`.
5. On the client: `harness-usage doctor` passes the check. Do **not** add a `gpt-5.6-terra-flex` override and do
   **not** run `reprice`.

## Out of scope (noted, not fixed here)

The `models priced` check (`checkModelsPriced`) reads only the main OpenCode DB and the main Claude Code root. It does
not read the extra homes, which is why it passed while the event check failed for the same model. Making it read the
extra homes would bring the same zero-token false positive back unless it applies the same filter. That needs its own
plan.
