# Price gpt-6.1-sol-fast

Type: bug
Status: Planned

## What is broken

`harness-usage doctor` fails two checks:

```
[FAIL] no unpriced billable events
       4 events with no rate card: openai/gpt-6.1-sol-fast (4)
[FAIL] models priced
       no price entry for: openai/gpt-6.1-sol-fast
```

OpenCode reports the model as provider `openai`, model `gpt-6.1-sol-fast`. The price table
(`~/.cache/opencode/models.json`) has no `gpt-6.1-sol-fast` under the `openai` provider, only `gpt-6.1-sol` at
$2 / $10. Lookups are scoped to the provider (no bare-name fallback, see `resolve()` in `agent/src/pricing.js`), so
the 4 events were stored at $0 with `priced_by = 'none'`.

This is the same situation as `openai/gpt-5.6-terra-fast` (commit 0fb35dd): the fast tier exists upstream but OpenAI
does not list it in the table.

## What it should be

The events carry a real non-zero rate. The fast variant is listed only by gateways, and both agree:

| listing                              | input | output | cache_read | cache_write | over 272k context         |
|--------------------------------------|------:|-------:|-----------:|------------:|---------------------------|
| `vercel :: openai/gpt-6.1-sol-fast`  |     4 |     20 |        0.2 |           5 | 8 / 30 / 0.4 / 10         |
| `kilo :: openai/gpt-6.1-sol-fast`    |     4 |     20 |        0.2 |           5 | (no tier listed)          |
| `openai :: gpt-6.1-sol` (reference)  |     2 |     10 |        0.1 |         2.5 | 4 / 15 / 0.2 / 5 at 272k  |

The fast rates are exactly 2x the base model, including the context tier. Use Vercel's listing, tier included
(overrides go through the same `toCard()` as table entries, so `tiers` / `context_over_200k` are honoured). Use tier
size 272000 to match OpenAI's own `gpt-6.1-sol` entry; Vercel's 272001 is an off-by-one in their listing.

## Changes

1. `agent/pricing-overrides.json`: add `openai/gpt-6.1-sol-fast` with the rates above and a `//openai/gpt-6.1-sol-fast`
   comment block in the style of the terra-fast one (gateway price, not OpenAI direct; replace if OpenAI lists it).
   Edit by hand; keep existing formatting.
2. Test in `agent/test/` (per AGENTS.md, a fix comes with a test): resolving `openai/gpt-6.1-sol-fast` through the
   shipped `pricing-overrides.json` returns source `override`, base input 4 / output 20, and the 272k tier applies
   above that context size. `npm test` in `agent/`.
3. On the client: `harness-usage reprice --unpriced-only --dry-run`, check it touches exactly the 4 events, then run
   without `--dry-run`. Pricing stays frozen at ingest (plan 004); this is the explicit escape hatch, not repricing.
4. `harness-usage doctor`: both checks pass, and `override drift` reports the new pin as unverifiable (no `openai`
   table entry), same as terra-fast.
