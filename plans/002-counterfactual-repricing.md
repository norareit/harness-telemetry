# Plan 002 — Counterfactual repricing: "what would this have cost elsewhere?"

Status: **implemented 2026-09-09** (commit ba6fa74).
Research done against the live machine on 2026-09-09; every number below was measured.
Builds on `plans/001-harness-usage-telemetry.md` (implemented 2026-09-09).

## Context

Plan 001 shipped a working telemetry pipeline (3,383 events, cross-device, Grafana). But
the goal it was built for was mis-framed. Stef does not want spend tracking or quota
tracking — he is on subscriptions, so the dollar figure is notional by definition. What he
actually wants is a **cost-model for a switching decision**:

> "I want the actual token usage even on subscriptions, *including my local model*, so I can
> see what this would have cost on OpenRouter — and decide whether to move certain parts to
> an OpenRouter model."

Nothing off-the-shelf does this. `ccusage` reads Claude Code JSONL but prices only at
Anthropic list rates, single-harness, single-machine. The many OpenRouter calculators take
*hypothetical* token counts you type in. Nobody reprices a **measured historical token
stream** against arbitrary alternative rate cards.

Plan 001's architecture is already 90% of the way there — raw token counts are stored
separately from cost, Ollama traffic is already captured as real tokens, and `models.json`
carries 7,615 models including full OpenRouter/Gemini/Kimi/Qwen/GLM rate cards. **Repricing
is a pure function over rows we already have.** No re-extraction needed.

Two defects block it, one of which is a live correctness bug.

## What the research established

### Bug A — Anthropic thinking tokens are billed at $0 (SHIPPED, MATERIAL)

`agent/src/sources/claude-code.js:119` normalizes reasoning *out* of output:
`output = max(0, output_tokens - thinking_tokens)`.
`agent/src/pricing.js` still carries a branch written for the *pre*-normalization shape:

```js
const billableOutput =
  ev.provider === "anthropic" ? ev.output_tokens : ev.output_tokens + ev.reasoning_tokens;
```

So for Anthropic we bill `output_total − thinking` — thinking tokens cost nothing. Both
changes were individually correct; together they contradict. Measured impact:

| model | thinking tokens | output rate | undercharged |
|---|---|---|---|
| claude-opus-5 | 608,525 | $25/M | **$15.21** |
| claude-fable-5-1 | 128,936 | $50/M | **$6.45** |
| claude-sonnet-5 | 374,974 | $10/M | **$3.75** |
| | | | **$25.41 total** |

Against a reported $314.88, that is ~8% understated — and it biases every comparison in the
direction of making the current setup look cheaper than it is.

**Fix:** delete the `provider === 'anthropic'` branch. Because extraction normalizes
reasoning out for *every* harness, billable output is uniformly
`output_tokens + reasoning_tokens`. This also makes repricing simpler — no per-provider
special case survives.

### Bug B — a missing `cache_read` prices cache reads as FREE (LATENT, BLOCKS REPRICING)

`normRates()` in `agent/src/pricing.js` does `cache_read: num(c.cache_read)`, and
`num(undefined)` returns `0`. Measured: **156 of 358 OpenRouter models have no `cache_read`
field** — they do not support prompt caching at all. For those models, cache-read tokens
must reprice at the **full input rate**, not free.

This is the single biggest lever in the whole feature. Stef's workload is overwhelmingly
cache reads (~477M on Claude Code against ~8K real input; 23M on OpenCode). Getting this
wrong understates a non-caching target by roughly **10×**, in the direction that makes
switching look attractive.

### Bug C — multi-tier models only read `tiers[0]` (LATENT)

`pickTier()` returns `cost.tiers[0]`. Several models in the chosen shortlist have multiple
tiers — `qwen/qwen3.7-flash` has 2, `qwen/qwen3-coder-plus` has tiers at 32k *and* 128k. A
200k-context request currently gets 32k-tier rates. Must select the **highest** tier whose
`tier.size` is exceeded.

### Bug D — `cache_write ?? input × 1.25` fabricates a rate (MINOR)

297 of 358 OpenRouter models have no `cache_write`. Inventing an Anthropic-shaped 1.25×
multiplier for them is wrong; fold cache-writes into the input rate instead.

### Measured token mix (drives every result)

| source | input | output | reasoning | cache read | cache write |
|---|---|---|---|---|---|
| Claude Code (all models, deduped) | ~8K | 1.11M | 1.11M | **477M** | 8.37M (100% 1h) |
| openai/gpt-5.6-sol | 3.06M | 0.12M | 0.27M | 18.35M | 0 |
| openai/gpt-5.6-terra | 0.55M | 0.02M | 0.01M | 4.65M | 0 |
| **ollama (all)** | **8.49M** | **0.45M** | 0 | **0** | 0 |

Ollama has **no prompt caching** — every turn re-sends full context as fresh input. That is
why its input count is large and its cache-read is zero, and it makes the "what is my local
box saving me" answer computable: those 8.49M/0.45M tokens are ~**$0.92** on `qwen3.5-9b`,
~**$3.00** on `qwen3-235b-thinking`, ~**$21** at Sonnet-5 rates. Useful, and slightly
deflating — worth surfacing honestly.

### Note on GLM

GLM is **not on OpenRouter**. It appears across gateway providers at materially different
prices for the same model — `tokengo/z-ai/glm-5.2` $1.40/$4.40, `greenpt/glm-5.2`
$1.254/$5.016, `ambient/zai-org/GLM-5.2-FP8` $1.20/$4.20. Scenario keys must therefore be
fully-qualified `provider/model`, and cross-gateway price spread is itself useful output.

## Decisions taken with the user

- **Bug A is fixed as part of this work**, not as a separate hotfix. Repricing is only
  meaningful once the baseline arithmetic is right, and one `backfill` corrects both.
- **Ollama comparison is tokens-only** — what those tokens would have cost on a hosted
  model. No electricity/hardware TCO, no power sampling.
- **Default dashboard scenarios**: Frontier + Sonnet + Qwen + Kimi + GLM + Gemini.

## Design

### Single source of pricing truth stays in JS

`agent/src/pricing.js` remains the only implementation of the pricing rules. The repricing
arithmetic is **not** duplicated in SQL — the rules (tier selection, cache fallback, the
Anthropic 1h rule, reasoning handling) are subtle enough that two implementations would
drift, and untrustworthy numbers defeat the purpose.

Consequence: Grafana panels read a **materialized** `usage_scenario` table containing a
configured shortlist, while unlimited ad-hoc exploration across all 7,615 models happens
through the CLI. ~3,383 events × ~7 scenarios ≈ 24K rows — trivial.

### Repricing semantics (must be explicit, and documented in `pricing.js`)

Given stored token counts and a **target** rate card:

1. `billable_output = output_tokens + reasoning_tokens` — uniform for all targets, since
   extraction normalizes reasoning out everywhere (this is Bug A's fix).
2. Target has **no `cache_read`** → cache-read tokens bill at the target's **input** rate.
   Tag the result `cache_model = 'none'`.
3. Target has `cache_read` but **no `cache_write`** → cache-write tokens (both TTLs) bill at
   the target's **input** rate. Tag `cache_model = 'read-only'`.
4. Target has both → `cache_model = 'full'`. The `1h = 2 × input` rule is **Anthropic-only**;
   for any non-Anthropic target, 1h and 5m both use the target's `cache_write`.
5. Tier selection: the **highest** tier whose `tier.size` < `input_tokens + cache_read_tokens`.
6. Ollama-sourced rows reprice normally — they carry real token counts. That is the point.
7. Target with no resolvable rate card → `priced_by = 'none'`, cost 0, and it must be
   **excluded** from comparison output rather than silently reading as free.

### Files

| File | Change |
|---|---|
| `agent/src/pricing.js` | Fix Bugs A–D. Add `repriceEvent(ev, targetKey)` returning `{cost_usd, cache_model, priced_by, tier_applied}`. Reuse the existing `resolve()` / `normRates()` / `pickTier()` helpers rather than adding a parallel path. |
| `agent/src/reprice.js` *(new)* | Aggregation over stored events: group by project/model/agent/day, apply `repriceEvent` per scenario, return comparison rows. |
| `agent/src/cli.js` | New `compare` command (see below). |
| `agent/src/sync.js` | After the existing upsert, compute configured scenarios and upsert `usage_scenario`. Must respect the same outbox/offline discipline as `usage_event`. |
| `agent/src/sink-postgres.js` | Add `upsertScenarios()`, mirroring the existing `upsert()` batching + `ON CONFLICT` pattern. |
| `agent/src/local-store.js` | Scenario rows join the existing outbox. Note the `archived` hash already re-queues rows when a payload changes — the Bug A fix will therefore re-ship every Claude Code row automatically on `backfill`. |
| `agent/config.example.json` | Add `scenarios: [...]` and document that keys are fully-qualified `provider/model`. |
| `agent/src/doctor.js` | Add a thinking-token regression check (below). |
| `server/postgres/init/01-schema.sql` | New `usage_scenario` table + `usage_scenario_daily` / `usage_scenario_project` views. |
| `server/grafana/dashboards/harness-usage.json` | Three new panels (below). |

### CLI

```
harness-usage compare --as <provider/model> [--as ...] \
                      [--group project|model|agent|day|harness] \
                      [--since <date>] [--only-local]
```

Prints actual (notional) cost beside each scenario, with a delta column and the
`cache_model` tag per target so a "cheap" model that loses caching is visibly flagged.
`--only-local` answers the Ollama question directly.

### Schema

```sql
CREATE TABLE usage_scenario (
    harness text NOT NULL, session_id text NOT NULL, message_id text NOT NULL,
    scenario text NOT NULL,              -- 'openrouter/qwen/qwen3.7-flash'
    cost_usd numeric(14,6) NOT NULL,
    cache_model text NOT NULL,           -- 'full' | 'read-only' | 'none'
    priced_by text NOT NULL,
    PRIMARY KEY (harness, session_id, message_id, scenario),
    FOREIGN KEY (harness, session_id, message_id)
        REFERENCES usage_event (harness, session_id, message_id) ON DELETE CASCADE
);
CREATE INDEX usage_scenario_scenario_idx ON usage_scenario (scenario);
```

### Default scenarios

Chosen to span every cache model and both tier shapes, so the fixes are exercised in
production rather than only in tests:

| Scenario key | Rate (in/out) | cache | tiers |
|---|---|---|---|
| `openrouter/anthropic/claude-opus-5` | 5 / 25 | full | — |
| `openrouter/anthropic/claude-sonnet-5` | 2 / 10 | full | — |
| `openrouter/openai/gpt-6-astra` | 10 / 50 | full | 1 |
| `openrouter/google/gemini-3.1-pro-preview` | 2 / 12 | full | 1 |
| `openrouter/qwen/qwen3.7-flash` | 0.03 / 0.13 | full | **2** |
| `openrouter/moonshotai/kimi-k2.7-code` | 0.71 / 3.50 | **read-only** | — |
| `tokengo/z-ai/glm-5.2` | 1.40 / 4.40 | **read-only** | — |

### Dashboard

- **Counterfactual cost over time** — actual vs each scenario, stacked by scenario.
- **Local model savings** — Ollama tokens repriced per scenario; what the GPU is saving.
- **Cheapest scenario per project** — table, the actual decision aid, with `cache_model`
  shown so a caching-loss result cannot be misread.

All repriced figures must be labelled **estimates**: token counts are not portable across
tokenizers, so these are good for "2× or 20×", not for budgeting to the dollar.

## Verification

1. **Bug A regression** (`doctor`): assert Claude Code thinking tokens now contribute
   **$25.41** and the total moves ~$289 → ~$314.88. Assert `pricing.js` contains no
   `provider === 'anthropic'` output branch.
2. **Bug B unit test**: reprice a synthetic event with 1M cache-read tokens against a target
   with no `cache_read` (e.g. `openrouter/qwen/qwen3.5-9b`, input $0.10) — must yield
   **$0.10**, not $0, and tag `cache_model='none'`.
3. **Bug C unit test**: `qwen/qwen3.7-flash` at 200k context must select the **higher** of
   its two tiers, not `tiers[0]`.
4. **Bug D unit test**: a target with `cache_read` but no `cache_write` bills cache-writes at
   the input rate, not `input × 1.25`.
5. **Ollama sanity**: `compare --only-local --as openrouter/qwen/qwen3.5-9b` must land near
   **$0.92**; `--as openrouter/anthropic/claude-sonnet-5` near **$21**.
6. **Idempotency**: run `sync` twice — `usage_scenario` row count and `SUM(cost_usd)`
   unchanged (same invariant already verified for `usage_event`).
7. **Backfill correctness**: after the Bug A fix, `backfill` must re-ship every Claude Code
   row (payload hash changes) and leave `usage_event` row count unchanged while
   `SUM(cost_usd)` rises by ~$25.41.
8. **Unpriced targets**: a scenario key with no rate card is reported as excluded, never as
   $0.

## Out of scope

Electricity/hardware TCO for Ollama; a proxy-based collector; per-token tokenizer
re-counting for the target model (the approximation is documented instead).
