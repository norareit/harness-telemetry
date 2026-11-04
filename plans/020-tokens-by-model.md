# Plan 020 — Tokens over time by model

Type: **task**
Status: **planned** (2026-11-05).
Builds on 010, 011 and 013.

## Feature

The dashboard has "Cost over time by model" (panel 10) but no token count over time by model. Subscription and local
work show up there only as cost, and local work costs 0, so a model that does a lot of local or subscription work is
invisible in that panel. Add a timeseries panel "Tokens over time by model".

### Panel 13 — "Tokens over time by model" (timeseries)

Same style as panels 10 and 11: stacked bars, `barAlignment: 1`, `fillOpacity: 80`, `lineWidth: 0`, table legend with
`sum`, tooltip `multi`. Unit `short`. Same bucket expression as panel 10 (plan 011). Same filters as panel 10.
"Tokens" means all six token columns, the same definition as panel 3 (Total tokens in range) and panel 23.

```sql
SELECT GREATEST(date_trunc(CASE WHEN $__unixEpochTo() - $__unixEpochFrom() <= 86400 THEN 'hour' ELSE 'day' END,
         ts, 'Europe/Brussels'), to_timestamp($__unixEpochFrom())) AS time,
  COALESCE(model, '(unknown)') AS metric,
  SUM(input_tokens + output_tokens + reasoning_tokens + cache_read_tokens + cache_write_5m_tokens
      + cache_write_1h_tokens) AS value
FROM usage_event
WHERE $__timeFilter(ts) AND device IN ($device) AND harness IN ($harness) AND COALESCE(model, '(unknown)') IN ($model)
GROUP BY 1, 2 ORDER BY 1
```

The null-model label is `(unknown)`, matching the `$model` variable. Panel 10 says `(unpriced)` for the same rows;
leave panel 10 as it is (out of scope).

Write the `rawSql` on one line like panel 10, or with `\n` like panel 11. Either is fine.

### Layout

Panels 10 and 11 currently share the row at `y:4` (`w:12` each). Two options, in order of preference.

**A — three across (try first).** The new panel goes between 10 and 11:

| id | title | x | w |
|---|---|---|---|
| 10 | Cost over time by model | 0 | 8 |
| 13 | Tokens over time by model | 8 | 8 |
| 11 | Tokens over time by kind | 16 | 8 |

All `y:4 h:9`. Nothing else moves. At `w:8` a right-hand table legend leaves little room for the bars (model names are
long), so for all three panels set `options.legend.placement` to `"bottom"` (keep `displayMode: "table"` and
`calcs: ["sum"]`).

**B — fallback, if A is too cramped in Grafana.** Cost and tokens by model sit side by side, and tokens by kind gets
its own full-width row:

| id | x | y | w | h |
|---|---|---|---|---|
| 10 | 0 | 4 | 12 | 9 |
| 13 | 12 | 4 | 12 | 9 |
| 11 | 0 | 13 | 24 | 9 |

Legends stay on the right. Every panel below moves down by 9:

| id | y before | y after |
|---|---|---|
| 20, 21, 22 | 13 | 22 |
| 23, 12 | 22 | 31 |
| 30 | 31 | 40 |
| 40 | 41 | 50 |
| 41, 42 | 51 | 60 |
| 43 | 60 | 69 |

Stef decides between A and B after seeing A rendered. If B, revert the legend placement change from A.

## Changes

- `server/grafana/dashboards/harness-usage.json`: hand-edit in place (AGENTS.md: never parse and reserialize). Insert
  panel 13 after panel 10, adjust the `gridPos` values and legend placements per the chosen layout.

## Verification

1. The file still parses as JSON, panel ids are unique, and there are no `gridPos` overlaps.
2. The query, with the Grafana macros substituted by hand, runs against the live Postgres for a 12h and a 30d range.
   The sum over all series and buckets equals panel 3's total for the same range.
3. After the server deploy (`rsync` of `server/`), the panel renders in Grafana, and Stef picks layout A or B.
