# Plan 009 — Counterfactual panel drops every scenario on a sub-day time range

Type: **bug**
Status: **fixed** (2026-09-21) in `server/grafana/dashboards/harness-usage.json`, panel 40,
second target. Dashboard JSON validates; `npm test` green. Not yet deployed: Grafana on the
rpi5 provisions the dashboard from this file, so the fix goes live when the rpi5 pulls it.
Part 2 (below) is closed by plan 011.
Builds on 001–008. Written 2026-09-21 after "Counterfactual cost over time — actual vs
alternatives" showed only `actual (as billed/notional) $0` for a day with 1.44M local tokens
on budgie (`ollama/qwen3.8:27b-128k`, `billing = 'local'`).

## The broken situation

With the dashboard range at **Last 12 hours**, panel 40 showed one series, `actual`, at $0.
None of the seven configured scenarios (`openrouter/anthropic/claude-opus-5`,
`…/gpt-6-astra`, `…/qwen3.7-flash`, and the rest) appeared, neither in the legend nor on the
chart. So the panel could not answer the one question it exists for: what the local model
saved today.

The data was not missing. Checked against Postgres the same day:

- Every budgie event from the last 2 days, including all 5,943 local qwen3.8 events, has
  its 7 `usage_scenario` rows, all with `priced_by = 'table'`.
- `usage_scenario_daily` has 323 rows for budgie.
- `harness-usage compare --only-local` prices the same stream fine locally.

## Root cause

The panel's two targets filter on different columns:

```sql
-- target A, "actual": filters on the raw event time
... FROM usage_event WHERE $__timeFilter(ts) ...

-- target B, scenarios (before the fix): filters on the view's day bucket
SELECT $__timeGroup(day, '1d') ... FROM usage_scenario_daily WHERE $__timeFilter(day) ...
```

`usage_scenario_daily.day` is `date_trunc('day', e.ts)` (`server/postgres/init/01-schema.sql:172`),
so every row is stamped at **midnight**. "Last 12 hours" at 16:15 local (UTC+2) is roughly
`02:15Z → 14:15Z`. Today's bucket, `2026-09-21T00:00Z`, falls before the window start, so
`$__timeFilter(day)` rejects every scenario row. Target A filters on `ts`, so it kept its
rows, which is why "actual" still appeared (at $0, because local usage is free).

In general, target B only showed a day if that day's midnight fell inside the selected range.
Any range shorter than a day, or one that starts after midnight, silently dropped that day's
counterfactuals. The dashboard default (`now-30d`) hid this, because a 30-day window includes
every midnight except the first day's.

## What it should have been

Both targets filter on the **same event timestamp**. For a given time range, the scenario
series should cover exactly the events that the actual series covers. For today's 12h window,
Postgres returns:

| scenario | would have cost |
|---|---|
| openrouter/openai/gpt-6-astra [full] | $15.14 |
| openrouter/anthropic/claude-opus-5 [full] | $7.57 |
| openrouter/google/gemini-3.1-pro-preview [full] | $3.07 |
| openrouter/anthropic/claude-sonnet-5 [full] | $3.03 |
| tokengo/z-ai/glm-5.2 [read-only] | $2.07 |
| openrouter/moonshotai/kimi-k2.7-code [read-only] | $1.06 |
| openrouter/qwen/qwen3.7-flash [full] | $0.15 |

## The fix

Target B no longer reads `usage_scenario_daily`. It joins `usage_scenario` to `usage_event`
directly and filters on `e.ts`, the same column target A uses. The `priced_by <> 'none'`
guard that the view applied is carried over explicitly:

```sql
-- Filters on the event ts, not usage_scenario_daily.day: a midnight day bucket falls outside any sub-day time range.
SELECT $__timeGroup(e.ts, '1d') AS time, s.scenario || ' [' || s.cache_model || ']' AS metric, SUM(s.cost_usd) AS value
FROM usage_event e
JOIN usage_scenario s ON s.harness = e.harness AND s.session_id = e.session_id AND s.message_id = e.message_id
WHERE $__timeFilter(e.ts) AND s.priced_by <> 'none' AND e.device IN ($device) AND e.harness IN ($harness)
GROUP BY 1, 2 ORDER BY 1
```

The view `usage_scenario_daily` is unchanged. It is still correct for whole-day consumers and
nothing else on the dashboard filters on its `day` column. The other panels built on
scenarios either have no time filter (`usage_local_savings`, `usage_scenario_project`) or
already filter on `ts`.

## Part 2 (fixed by plan 011): daily buckets fall off-canvas on sub-day ranges

Four time-series panels group by `$__timeGroup(ts, '1d')`:

| id | panel | style |
|---|---|---|
| 10 | Cost over time by model | bars |
| 11 | Tokens over time by kind | bars |
| 40 | Counterfactual cost over time | line |
| 43 | Effective rates applied, by model | line |

Under a range shorter than a day, today's single point is stamped `00:00Z`, left of the
visible x-axis. The legend (sum / lastNotNull) is correct, but nothing gets drawn. That is why
panels 10 and 11 in the same screenshot showed legend values over an empty plot. After the
Part 1 fix, panel 40 behaves the same way: the right scenario totals in the legend, and an
empty chart on a 12h view.

This is a presentation issue, not a data-correctness one, and the fix changes how the panels
bucket. So it waits for a decision. Candidate approach: group by `$__interval` instead of
`'1d'`, and set a panel `interval` (min interval) so a 30-day view still gets roughly daily
bars. Verify it on 12h, 7d and 30d ranges before shipping.

## Verification (Part 1)

1. Deploy: pull on the rpi5. Grafana re-provisions the dashboard from the file.
2. Set the range to **Last 12 hours**, device `budgie`. Panel 40's legend lists all seven
   scenarios, and their Totals match the table above (plus whatever has been used since).
3. Set the range to **Last 30 days**. The panel shows the same series it showed before the fix.
   The change only adds rows that were previously dropped; it never removes any.
4. Spot-check one scenario's legend total against
   `SELECT SUM(s.cost_usd) FROM usage_event e JOIN usage_scenario s USING (harness, session_id, message_id) WHERE e.ts >= <range start> AND s.scenario = '<key>'`.
