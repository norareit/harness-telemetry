# Plan 013 — Tokens by project

Type: **task**
Status: **implemented** (2026-09-26). The JSON parses, panel ids are unique, and there are no gridPos overlaps. The
exact `rawSql` of both panels (macros substituted) ran against the live Postgres. For 30d and 12h, each panel's sum
equals the range total (1,496,390,383 / 23,012,212 tokens), and `local` shows for finrite (71.0M), agent-kit (37.2M)
and norareit (5.7M). Step 3 is confirmed by Stef in Grafana: both panels render, and agent-kit and finrite now show
up in the top 5 of Tokens by project.
Builds on 001–012.

## Feature

"Cost by project" (panel 20) only shows spend. Local model work has `cost_usd = 0`, so it never shows up there. In
the last 30 days that was 115M local tokens (finrite 71M, agent-kit 37M, norareit 6M), and they appear only in
"Billable vs local vs subscription" and the counterfactual panels, never per project.

Add a row of two token panels per project, split so local work stands out.

### Panel 23 — "Tokens by project" (barchart, `x:0 y:22 w:12 h:9`)

Same shape as panel 20: horizontal bars, basename of `project`, top 20, with the same `$device` / `$harness` /
`$model` filters. Each bar is **stacked by billing** as three columns: `subscription` (`billing = 'free'`), `local`,
and `api`. The sort is by total tokens. "Tokens" means all six token columns, the same definition as panel 22.

```sql
SELECT regexp_replace(COALESCE(project, '(unknown)'), '^.*/', '') AS project,
  SUM(<total>) FILTER (WHERE billing = 'free')  AS "subscription",
  SUM(<total>) FILTER (WHERE billing = 'local') AS "local",
  SUM(<total>) FILTER (WHERE billing = 'api')   AS "api"
FROM usage_event WHERE <filters> GROUP BY 1 ORDER BY SUM(<total>) DESC LIMIT 20
```

Options: `stacking: "normal"` and a visible legend. Unit `short`. Fixed colours are set per series so `local` is
always the same colour (green), `subscription` blue, and `api` orange.

### Panel 12 — "Tokens over time by project" (timeseries, `x:12 y:22 w:12 h:9`)

Same style and bucket expression as panel 11 (plan 011: hour buckets on ranges of 24h or less, otherwise day buckets
in Europe/Brussels, clamped to the range start). There is one stacked series per project. The top 8 projects by
tokens in the range get their own series, and the rest are summed as `(other)` so the legend stays readable.
Rank by **basename**, not by full path. Otherwise `/Users/stef/projects/norareit` (laptop) takes a top-8 slot of its
own and then merges into `norareit`, leaving only 7 real series (found while verifying).

### Layout

The new row goes at `y:22`, directly under the cost row. Everything below moves down by 9:

| id | y before | y after |
|---|---|---|
| 30 | 22 | 31 |
| 40 | 32 | 41 |
| 41, 42 | 42 | 51 |
| 43 | 51 | 60 |

## Changes

- `server/grafana/dashboards/harness-usage.json`: hand-edit in place to add panels 23 and 12 after panel 22 and bump
  the five `gridPos.y` values. No reserialization.

## Verification

1. The file still parses as JSON (`node -e 'JSON.parse(...)'`), panel ids are unique, and there are no gridPos
   overlaps.
2. Both queries, with the Grafana macros substituted by hand, run against the live Postgres for a 12h and a 30d
   range. Panel 23 row totals equal the per-project token sums. Panel 12 bucket sums equal the range total.
3. After the rpi5 deploy, both panels render in Grafana and `local` shows up for finrite and agent-kit.
