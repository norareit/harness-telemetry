# Plan 011 — Time-series panels draw nothing on ranges under 24h

Type: **bug**
Status: **implemented** (2026-09-21). All six targets ran against the live Postgres. On a
12h range they return hourly buckets; on a 7d range, buckets at local midnight (22:00Z). A range
starting mid-day during activity (2026-09-18T10:00:53Z) stamps its first bucket at exactly that
instant and nothing earlier, for both 12h and 7d. Bucket sums equal the unbucketed totals
($3.54 / $344.83 / $98.30 / $24.75). The Grafana UI check is still to do after deploying to
the rpi5.
Builds on 001–010. This is the open Part 2 of plan 009, which it closes.

## The broken situation

Four time-series panels group by `$__timeGroup(ts, '1d')`:

| id | panel | style |
|---|---|---|
| 10 | Cost over time by model | bars |
| 11 | Tokens over time by kind | bars |
| 40 | Counterfactual cost over time (both targets) | line |
| 43 | Effective rates applied, by model (both targets) | line |

On any range shorter than a day these panels show correct legend totals over an empty plot.
`$__timeGroup` stamps each bucket at the start of its UTC day. The x-axis starts at the
range start, so on "Last 12 hours" (~02:15Z → 14:15Z) today's single bucket at 00:00Z sits
left of the axis. A line also needs two points on screen, and a sub-day range has at most
one.

On longer ranges the same thing happens in milder form. The first day's bucket starts before
the range, so it is off-canvas or (for bars, which are centred on their timestamp) cut in
half, while its value still counts in the legend total. What is drawn and what is totalled
disagree.

A smaller issue: days are UTC days, so "a day" runs 02:00→02:00 (01:00 in winter) in
Brussels time.

## What it should be

- Ranges of **24h or less** get **1-hour** buckets; longer ranges get **1-day** buckets.
- Buckets are **local days/hours in `Europe/Brussels`**. Grafana doesn't pass the browser's
  timezone to SQL, so it is hardcoded. It matches the dashboard's `"timezone": "browser"` for
  the only person viewing it.
- Every bucket that has data is drawn inside the plot area, so the chart and the legend
  cover the same events.

## The fix (all in `server/grafana/dashboards/harness-usage.json`)

1. Replace `$__timeGroup(ts, '1d')` (and `e.ts` in panel 40 B) in all six targets with:

   ```sql
   GREATEST(
     date_trunc(CASE WHEN $__unixEpochTo() - $__unixEpochFrom() <= 86400 THEN 'hour' ELSE 'day' END,
                ts, 'Europe/Brussels'),
     to_timestamp($__unixEpochFrom())
   ) AS time
   ```

   - The CASE picks the unit from the range length. Both macros expand to epoch integers.
   - The 3-argument `date_trunc` (Postgres 12+; the rpi5 runs 17) truncates in local time and
     returns a timestamptz, so it is independent of the session's `TimeZone` (UTC).
   - `GREATEST(…, range start)` clamps the first, partial bucket to the range start. The
     query already filters out events before the range, so that bucket only holds events
     from the range start to the next local midnight or hour, and stamping it there is
     exactly right. Only the first bucket can be clamped, so no two buckets merge.
2. Panels 10 and 11: set `fieldConfig.defaults.custom.barAlignment: 1`, so a bar is drawn from
   its timestamp to the right. That matches what the bucket covers, keeps the clamped first
   bar fully visible, and makes the last bar end at "now" instead of hanging past it.

Out of scope: the y-axis now means "per hour" or "per day" depending on range, so bar
heights are not comparable across zoom levels. Legend totals are.

## Verification

- Every rewritten query runs against Postgres with the macros substituted, for a 12h range
  (hourly buckets, first one clamped to the range start) and a 7d range (daily buckets at
  local midnight, 22:00Z in summer, first one clamped).
- Legend totals (sum of all buckets) equal the unbucketed sum over the same range.
- In Grafana, after deploying to the rpi5: 12h, 24h, 7d and 30d all draw bars and lines
  starting at the left edge, and the leftmost bar is not cut in half.
