# Plan 004 — Freeze the price at ingest

Status: **implemented 2026-09-16** (commit 353738a).
Builds on 001 (pipeline), 002 (counterfactual repricing) and 003 (stored rates), all
implemented. State at time of writing (2026-09-17): 4,281 events and ~30K scenario rows
live in Postgres on `rpi5`; desktop syncs every 5 minutes via systemd.

## Context

Plan 003 made `sync` reprice **every stored event on every run**, so the dashboard always
answered "what would this cost at today's rates". I recommended that, and it was the wrong
call for this project.

The reason it is wrong, in Stef's words: *"It doesn't make much sense to know how much work
done a month ago would have costed at today's rates. It is much more interesting to know
what that would've costed a month ago."* A cost record whose past moves whenever a vendor
changes a price is not a record. When Anthropic or OpenRouter reprice, August's numbers
silently change.

Storing the rates (plan 003) did **not** prevent this, which is the subtle part worth
spelling out for anyone reading 003 first: `UPDATE_SET` in `sink-postgres.js` is built from
every column except the three primary-key fields, so `ON CONFLICT DO UPDATE` overwrites
`rate_input`, `rate_output` and the rest along with `cost_usd`. The stored rates record
*the last repricing*, not the rates in force when the request was made.

This plan makes the valuation permanent: priced once, at ingest, never recomputed.

## What the research established

Read from the working tree on 2026-09-17.

### Freezing is mostly a deletion

Events are **already** priced at extraction — `sync.js` calls `pricing.price()` inside the
extraction loop and spreads the whole result into `store.record()`. The reprice pass that
follows (`sync.js:104–119`) is what un-freezes them:

```js
store.transaction(() => {
  for (const ev of [...store.allEvents()]) {
    const priced = pricing.price(ev, srcCfg?.billing || "free");
    if (store.record({ ...ev, ...priced }) === "changed") report.repriced++;
  }
});
```

Removing it is the core of this plan. Scenarios need slightly more care: `sync.js:121–141`
rebuilds rows for **all** events against **all** configured scenarios on every run, so it
must become incremental.

### Staleness becomes permanent damage

Today a wrong price self-corrects on the next sync. Frozen, it does not. That inverts the
risk profile of two things flagged earlier and never addressed:

- `~/.cache/opencode/models.json` is maintained by **OpenCode**, not by this repo — nothing
  here fetches or refreshes it (the only match is a comment). It was last written
  **2026-09-14** and carries 7,784 models. If OpenCode goes unused the table freezes, and
  under this plan every event ingested meanwhile is permanently valued at stale rates.
- Two entries in `pricing-overrides.json` are pinned and never track upstream:
  `opencode/big-pickle` (all zeros, genuinely free) and `openai/gpt-5.6-terra-fast`
  ($4/$24, pinned from Vercel's listing — a real non-zero rate that will silently rot).

So this plan must add the staleness checks, not merely the freeze.

### An escape hatch is mandatory

A pure "never reprice" rule would have made the `gpt-5.6-terra-fast` incident permanent:
171 events were stored at `$0` while a lookup bug was live, and only the automatic reprice
pass recovered them once the override landed. Deliberate correction must remain possible —
just explicit rather than automatic.

### Current state

- `usage_event` (27 columns) and `usage_scenario` (14) both carry `rate_*`, `cache_model`,
  `tier_applied`, `synced_at`. **No `priced_at` or equivalent exists anywhere.**
- `server/postgres/migrations/` contains only `001-add-rates.sql`.
- 7 views, including `usage_cost_audit`, which recomputes cost from stored rates.
- `doctor` registers 14 checks; `cost reproducible from stored rates` remains valid under
  this plan (it tests internal consistency, not freshness).

## Decision

Freeze at ingest. Postgres becomes a ledger of what each request would have cost **when it
happened**. The "at today's rates" question is still answerable — that is exactly what
`harness-usage compare` does, on demand, without rewriting stored history.

## Design

### Remove the reprice pass

Delete `sync.js:104–119` and the `report.repriced` counter and its CLI line. An event's
`cost_usd` and `rate_*` are written once, by the extraction loop, and never touched again.

Side benefit: sync gets cheaper still. The pass was most of the ~0.7s steady-state run.

### Make scenarios incremental

`scenarioRows()` must generate rows only for `(event, scenario)` pairs not already stored,
instead of rebuilding from `store.allEvents()` every run. Add a `LocalStore` lookup for
existing pairs and pass it in.

**A scenario added later cannot be priced historically.** There is no archive of past rate
tables for arbitrary models, so a counterfactual added today against a month-old event can
only use today's rate for that target. That is unavoidable — the fix is to make it visible,
not to pretend otherwise. Hence:

### Add `priced_at` to both tables

```sql
ALTER TABLE usage_event    ADD COLUMN IF NOT EXISTS priced_at timestamptz;
ALTER TABLE usage_scenario ADD COLUMN IF NOT EXISTS priced_at timestamptz;
```

Set at pricing time. For a normally-ingested event `priced_at ≈ ts`; for a scenario added
later it is visibly much later, so anyone reading `delta_usd` can tell whether the
comparison used contemporaneous rates.

Nullable on purpose: existing rows were last valued at an indeterminate moment before this
change and **cannot be retroactively corrected** — no historical price table exists. `NULL`
means "valued before the freeze, date unknown". Do not backfill it with `now()`; that would
assert something untrue.

### Escape hatch: `harness-usage reprice`

```
harness-usage reprice [--unpriced-only] [--model <provider/model>] [--scenario <key>] [--dry-run]
```

Explicit, filtered repricing for when a stored value is known to be wrong — a pricing bug,
or a newly added override. `--dry-run` reports what would change without writing. Updates
`priced_at`. This is the command that would have fixed the terra-fast incident.

### Files

| File | Change |
|---|---|
| `agent/src/sync.js` | Delete the reprice pass (104–119). Make the scenario block incremental. |
| `agent/src/reprice.js` | `scenarioRows()` takes a set of existing pairs and skips them. |
| `agent/src/local-store.js` | `existingScenarioPairs()`; stop `pruneScenarios` from forcing a rebuild. |
| `agent/src/pricing.js` | `price()` / `repriceEvent()` return `priced_at` (ISO string). |
| `agent/src/record.js` | `priced_at` into `FIELD_ORDER`; it is a derived field, so add it to `DERIVED_FIELDS` too — otherwise every reprice would append a new archive line. |
| `agent/src/cli.js` | New `reprice` command; drop the `repriced:` line from sync output. |
| `agent/src/doctor.js` | Three new checks, below. |
| `server/postgres/init/01-schema.sql` | `priced_at` on both tables, inline. |
| `server/postgres/migrations/002-add-priced-at.sql` *(new)* | The ALTERs. Idempotent, non-destructive. |
| `README.md` | Correct the "sync reprices" documentation — it is now the opposite. Document `reprice`, and that Postgres is a ledger while `compare` answers today's rates. |

### New `doctor` checks

1. **price table freshness** — warn if `models.json` mtime is older than ~14 days. Under a
   freeze a stale table permanently misprices everything ingested meanwhile.
2. **override drift** — for each entry in `pricing-overrides.json` that also exists in the
   live table, compare rates and report divergence. Pinned rates are deliberate, but
   silent rot is not.
3. **unpriced non-local events** — count events with `priced_by='none'` whose provider is
   not local. These are `reprice` candidates once an override is added; today they are
   invisible after the fact.

## Verification

1. **Freeze holds**: note `cost_usd` for a known event; edit that model's rate in
   `pricing-overrides.json`; `sync`; the stored cost and `rate_*` must be **unchanged**.
2. **Escape hatch works**: `harness-usage reprice --model <that model>` then re-check — cost
   now reflects the new rate, and `priced_at` has advanced.
3. **`--dry-run` writes nothing**: row count, `SUM(cost_usd)` and `priced_at` all unchanged.
4. **Scenarios incremental**: two consecutive syncs with no new events must generate **0**
   new scenario rows (today it regenerates ~30K every run).
5. **New scenario, old events**: add a scenario key, sync, confirm rows appear for existing
   events with `priced_at` ≈ now rather than ≈ `ts` — the "not contemporaneous" signal.
6. **Archive parity**: after this change Postgres and the JSONL archive should agree on
   cost for any event that has not been explicitly repriced, since the archive already
   stores price-at-first-archival. Assert on a sample; it removes the standing "archive may
   be stale" caveat in the README.
7. **`priced_at` semantics**: after migration every pre-existing row is `NULL`; every newly
   ingested row is non-null and within a few minutes of its `ts`.
8. **Idempotency unchanged**: `sync` twice — row counts and `SUM(cost_usd)` stable.
9. `usage_cost_audit` still reports **0** drift.

## Out of scope

Retroactively reconstructing what past events *should* have cost — impossible without a
historical rate archive. Recording a price-table history so future repricing could be done
"as of" a date; that is a much larger design and this plan deliberately stops at freezing
plus making staleness visible.
