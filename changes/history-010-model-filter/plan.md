# Plan 010 — `model` filter on the dashboard

Type: **task**
Status: **implemented** (2026-09-21). Every dashboard query ran against the live Postgres
with the macros substituted, for model = All / `qwen3.8:27b-128k` / `claude-opus-5`. With All,
panels 30 and 41 match the old views exactly (30 sessions, $393.18 over 7 days; 14 rows,
$1,720.90). Panel 42 differs as intended for the 4 projects used from both harnesses
(finrite, harness-telemetry, norareit, thoryn). The Grafana UI check is still to do after
deploying to the rpi5.
Builds on 001–009. Prompted by plan 009: filtering on harness `opencode` would have isolated
the local qwen3.8 tokens that day, but only because OpenCode happened to run a single model.
With a GPT model in OpenCode as well, device and harness can't separate the two.

## Feature

A third dashboard variable, `model`, next to `device` and `harness`. It is multi-select with
"All" and applies to every panel that already honours `device`/`harness`.

## Changes (all in `server/grafana/dashboards/harness-usage.json`; no schema migration)

1. **Variable.** `SELECT DISTINCT COALESCE(model, '(unknown)') FROM usage_event WHERE device
   IN ($device) AND harness IN ($harness) ORDER BY 1`. It cascades off the other two filters,
   so it only offers models that exist for the current selection. `refresh: 1` (on dashboard load).
2. **Filter expression** `COALESCE(model, '(unknown)') IN ($model)`, or `e.model` where the
   table is aliased. `usage_event.model` is nullable. A bare `model IN ($model)` would silently
   drop NULL-model rows even with "All" selected, because Grafana expands "All" to the value
   list.
3. **Panels that query `usage_event` directly** (1, 2, 3, 4, 10, 11, 20, 21, 22, 40, 43): add
   the filter next to the existing `harness IN ($harness)`.
4. **Panels that read views with no model column.** Inline these as queries on
   `usage_event` (+ `usage_scenario`), so nothing changes on the rpi5's Postgres:
   - **30 Top sessions** (was `usage_session`): aggregate per `(harness, device, session_id)`
     with the model filter applied before grouping. A session's row then covers only the
     selected models' responses. The time-overlap test moves into `HAVING`.
   - **41 What the local model is saving** (was `usage_local_savings`): same join and
     `billing = 'local'` predicate. It now also honours `$harness`; it still ignores the time
     range, as before.
   - **42 Cheapest alternative per project** (was `usage_scenario_project`): aggregate per
     project/scenario in a subquery, then `DISTINCT ON (project)`. It now also honours
     `$device`. It sums across harnesses. Before, the view kept one row per harness and
     `DISTINCT ON` picked one of them, so a project used from both harnesses showed only part
     of its spend.
5. **Panel 50** (minutes since last ship) is unchanged. It deliberately ignores all filters.

The views `usage_session`, `usage_local_savings` and `usage_scenario_project` stay in the
schema; they're still useful for ad-hoc SQL.

## Verification

- Dashboard JSON parses; every rewritten query runs against Postgres with the macros
  substituted (All = every model; one model; a local-only model).
- On the dashboard: with `model = qwen3.8:27b-128k`, "Spend in range" is $0 and the
  counterfactual panel shows only local repricing. With `model = claude-opus-5`, the local
  savings table is empty.
- With `model = All`, every panel shows the same numbers as before the change, except panel
  42 for projects used from more than one harness (see 4).
