# Plan 006 — Three structural moves: valuation policy, archive/outbox split, doctor reuse

Status: **implemented 2026-09-18** (Move 1 b8399eb, Move 2 d5e28ff, Move 3 2238333).
Builds on 001–004 (implemented) and **005 (unit tests), which must land first**: every move
below is a behaviour-preserving refactor and the suite from 005 is what proves that. Written
2026-09-18 from a structural review of the working tree at commit `bc923d6`.

## Context

The module layout is right: sources → `record.js` → `pricing.js` → `local-store.js` →
`sink-postgres.js`, orchestrated by `sync.js`, driven by `cli.js`. Data flows one way. That
should be kept. Three places have outgrown that layout, and each one is where the last two
review passes found bugs:

1. **`cli.js` has become a second business-logic layer.** The policy for deliberate
   re-valuation — which rows count as "moved", what gets written — lives inside `cmdReprice`
   (`agent/src/cli.js:184-256`), next to argument parsing and `console.log`. It is the same
   kind of decision `frozenValuation` makes for ingest, but it sits in the command layer and
   was untested; review finding C2 (a billing change never re-applied) was there. The naming
   makes it worse: `reprice.js` contains the *counterfactual* code (`compare`,
   `scenarioRows`), while the `reprice` *command* is in `cli.js`.

2. **`local-store.js` (657 lines) carries five concerns in one class:** Claude Code cursors,
   the event outbox, the JSONL archive, the scenario outbox, and maintenance
   (`compactArchive`, `importArchive`, `summary`). The archive file format and its hash rule
   are module-private (`orderFields`, `sourceOf`, the `v2:` prefix), so
   `agent/scripts/retag-device.mjs:76-87` re-implements them. That is the classic symptom of a
   missing module.

3. **`doctor.js` re-implements extraction instead of importing it.** `dedupeTotals`
   (`doctor.js:371-435`) and `modelsInUse` (`doctor.js:437-481`) walk the transcripts and the
   OpenCode database with their own parsers. They already disagree with
   `sources/claude-code.js`: `providerOf` there defaults unknown models to `anthropic`,
   `modelsInUse` defaults them to `openai` (review finding C7). Every check is also an
   anonymous block inside one 320-line function, so none can be run or tested alone, and one
   uncaught throw used to take every later check with it (commit 8c4d862).

Not a rewrite. Three targeted moves, each an afternoon, each removing a place where bugs have
actually been found.

## Ground rules for all three

- **Behaviour-preserving.** No CLI flag, output line, table, column, file name or hash
  changes. `harness-usage doctor` prints the same 14 check names with the same details.
- **`npm test` green before each move and after it.** Commit each move separately.
- **Facades stay.** `sync.js` and `cli.js` keep calling `store.record(...)`,
  `store.allEvents()`, `runDoctor()`. Internal moves must not ripple outward except where the
  plan says so.
- **Move, don't rewrite.** Cut and paste the existing functions with their comments; the
  comments carry incident history that must not be lost.

## Move 1 — Valuation policy out of `cli.js`, and fix the naming

### New module `agent/src/valuation.js`

All decisions about *what an event's stored valuation should be* live here. Two entry points
plus the comparison they share:

```js
// Ingest: reuse the stored valuation when the pricing inputs are unchanged (plans/004),
// otherwise price now. Returns { priced, frozen: boolean }.
export function valueAtIngest({ store, pricing, raw, billing })

// Deliberate re-valuation (`harness-usage reprice`). Reads the store, prices every event
// in scope at today's rates, returns what would change without writing anything.
//   scope: { model?: 'provider/model', unpricedOnly?: boolean }
//   → { examined, updates: [{ ev, priced }], deltaUsd }
export function planRevaluation({ store, pricing, config, scope })

// Writes a plan. One transaction. Returns the number of rows written.
export function applyRevaluation({ store, updates })

// Would storing `next` in place of `prev` change the valuation? Compares every
// DERIVED_FIELD except priced_at: numbers to 1e-9, null !== 0, strings by equality.
// (This is plan 005's C2 fix; if 005 landed first, MOVE it here rather than re-implement.)
export function valuationChanged(prev, next)

// Everything a valuation depends on. Moved from local-store.js.
export const PRICING_INPUT_FIELDS
export function samePricingInputs(a, b)
```

`valueAtIngest` is the body of `sync.js:73-92` today (build `inputs`, call
`store.frozenValuation`, fall back to `pricing.price`). `planRevaluation` and
`applyRevaluation` are `cli.js:204-217` and `cli.js:246-248`. `valuationChanged` replaces the
`moved` predicate at `cli.js:213-215`.

### `local-store.js` becomes data-only for valuation

`frozenValuation(key, inputs)` currently mixes lookup and policy. Split it:

- `LocalStore.storedEvent(key)` → the parsed outbox payload or `null`. Data.
- `valuation.js` does `samePricingInputs(prev, inputs)` and picks `DERIVED_FIELDS` off it.
  Policy.

Keep `frozenValuation`'s long comment (`local-store.js:155-180`); it moves to `valueAtIngest`
verbatim, because it explains the freeze better than the plan does.

### `sync.js`

The extraction loop calls `valueAtIngest` and keeps its `report.frozen` accounting. Nothing
else changes. The `NOTE (plans/004)` block at `sync.js:113-123` stays.

### `cli.js`

`cmdReprice` shrinks to: parse scope, call `planRevaluation`, format the dry-run or apply via
`applyRevaluation` and format. The `--scenario` branch (`store.dropScenario`) stays in the
command; it is one store call, not policy. Output strings unchanged, byte for byte.

### Rename `reprice.js` → `counterfactual.js`

`git mv agent/src/reprice.js agent/src/counterfactual.js`. Update the three imports
(`sync.js`, `cli.js`, the 005 test file) and the module diagram in `README.md:84-91`.
The `reprice` *command* keeps its name — it is documented and in muscle memory. After this
move the word "reprice" means exactly one thing in the source tree: the escape hatch.

## Move 2 — Split the JSONL archive from the SQLite outbox

### New module `agent/src/archive.js`

Owns the file format and nothing else. No SQLite, no knowledge of `synced`.

```js
export const HASH_VERSION = "v2:";          // moved from local-store.js
export function orderFields(ev)              // moved
export function sourceOf(ev)                 // moved
export function sourceHash(ev)               // HASH_VERSION + sha1(sourceOf(ev)) — new name for the inline expression

export class Archive {
  constructor({ eventsDir })                  // mkdirSync recursive, as today
  append(ev)                                  // appendFileSync to <day>.jsonl, payload = JSON.stringify(orderFields(ev))
  *files()                                    // sorted *.jsonl paths
  readAll()                                   // → { lastByKey: Map<key, ev>, unreadable }  (last-wins, makeEvent'd)
  compact()                                   // today's compactArchive, unchanged
}
```

`readAll` is the reading half of `importArchive` (`local-store.js:464-482`); `compact` is
`compactArchive` (`local-store.js:411-442`) unchanged.

### `local-store.js` keeps the SQLite side and owns an `Archive`

- Constructor builds `this.archive = new Archive({ eventsDir })`.
- `record()` keeps its exact decision logic (`local-store.js:245-271`) but calls
  `this.archive.append(ev)` and `sourceHash(ev)` instead of inline `appendFileSync` and the
  inline `createHash` expression. The `archived` table stays in SQLite: it answers "is this
  event's current source data already on disk", which is store state about the archive, not
  the archive itself.
- `importArchive()` becomes `this.archive.readAll()` followed by today's transaction
  (`local-store.js:484-516`), unchanged.
- `compactArchive()` delegates to `this.archive.compact()`.
- Cursors, outbox, scenario outbox, `summary()` stay. (`summary()` is reporting and could move
  to `cli.js` later; not in this plan.)

Callers (`sync.js`, `cli.js`, `doctor.js`) are untouched: the `LocalStore` facade is identical.

### `agent/scripts/retag-device.mjs`

Delete its local `orderFields` / `sourceOf` / `sourceHash` (`retag-device.mjs:73-87`) and
import them from `../src/archive.js`. Its comment block at lines 22-24 about "the reprice pass"
describes code removed in plan 004 — replace with one sentence: a plain `sync` reuses the
stored valuation and never restamps `device`, so only this script can change it. Everything
else in the script stays.

### Comments to carry across

`local-store.js:1-14` (module header) splits: the archive paragraph goes to `archive.js`, the
outbox paragraph stays. `record()`'s two-hashes comment (`local-store.js:200-218`) stays with
`record()`. `importArchive`'s comment (`local-store.js:444-462`) stays with it.

## Move 3 — `doctor` imports the extractors, and checks become a registry

### Export the parsing from the sources

`sources/claude-code.js`:

```js
// The per-line parse WITHOUT the dedupe step: everything extractClaudeCode knows about a
// record, or null for a line it would ignore (non-assistant, no usage, <synthetic>, bad JSON).
// Returns { dedupeKey, model, usage, event }.
export function parseRecord(line)
export function providerOf(model)
export async function listTranscripts(root)   // the readdir walk from extractClaudeCode / doctor's listJsonl
```

`parseLine(line, seen)` becomes `parseRecord` plus the `seen` check, so the extractor's
behaviour is unchanged.

`sources/opencode.js`:

```js
// Distinct (providerID, modelID) pairs across assistant messages. Read-only.
export function listModels(dbPath)            // the loop at doctor.js:465-477
```

### `doctor.js` uses them

- `dedupeTotals` iterates `listTranscripts(root)` and `parseRecord(line)`; naive sums come from
  every non-null record, deduped sums from the first record per `dedupeKey`. The `sig` conflict
  count is computed from `usage` as today. This deletes doctor's own JSON walking
  (`doctor.js:378-413`).
- `modelsInUse` becomes: Claude Code models via `parseRecord` → `[providerOf(model), model]`;
  OpenCode via `listModels`. Finding C7 disappears by construction — there is one
  `providerOf`.

### Checks become a registry

```js
// Each check is a named function of a shared context. It returns { ok, detail } or throws;
// a throw becomes { ok: false, detail: err.message } for THAT check only.
const CHECKS = [
  { name: "config file",                        run: checkConfigFile },
  { name: "device name",                        run: checkDeviceName },
  { name: "data dir",                           run: checkDataDir },
  { name: "claude-code transcripts",            run: checkClaudeCodeTranscripts },
  { name: "claude-code dedupe regression",      run: checkClaudeCodeDedupe },
  { name: "opencode db",                        run: checkOpenCodeDb },
  { name: "opencode reconciliation",            run: checkOpenCodeReconciliation },
  { name: "price table",                        run: checkPriceTable },
  { name: "reasoning tokens billed",            run: checkReasoningBilled },
  { name: "scenarios resolve",                  run: checkScenariosResolve },
  { name: "cost reproducible from stored rates",run: checkCostReproducible },
  { name: "price table freshness",              run: checkPriceTableFreshness },
  { name: "override drift",                     run: checkOverrideDrift },
  { name: "no unpriced billable events",        run: checkNoUnpricedBillable },
  { name: "models priced",                      run: checkModelsPriced },
  { name: "postgres connection",                run: checkPostgresConnection },
  { name: "postgres schema",                    run: checkPostgresSchema },
];

export async function runDoctor({ only = null } = {})   // only: array of names
```

Context built once: `{ config, pricing, store }` with one `LocalStore` opened for the run
(today two are opened and closed inside blocks) and closed in `finally`. Checks that today are
skipped when a source is disabled (`ccEnabled`, `ocEnabled`) return `null` to mean "not
applicable" and are omitted from the output, preserving today's count and order. The Postgres
pair shares one sink through the context.

> **Correction (post-implementation, review finding C1).** The first cut shared the sink by
> having the connection check stash `ctx._pgGaps` for the schema check — a side channel that
> made the two checks order-dependent, so `doctor --only "postgres schema"` run alone was a
> silent no-op in a registry whose whole point is checks that stand alone. Share expensive work
> as a **lazily-memoised context method** either check can call (`ctx.postgres()`, and likewise
> `ctx.ccScan()` for the transcript walk — finding C3), never as a field one check writes for a
> later one to read.

`runDoctor()` with no arguments must produce the same array, in the same order, with the same
names and details, as today. A `doctor --only <name>` flag in `cli.js` is a cheap addition and
makes the registry visible; keep it if it is under ten lines, otherwise skip it.

Plan 005's `doctor.test.js` should be extended to call individual checks with a synthetic
context — that is the payoff of the registry and the reason this move is worth doing beyond
the parser reuse.

### Fix the README doctor section while here

`README.md:249-259` lists five checks. Replace with the registry's names, one line each, in
order. Under a registry this list has one obvious source and can be kept accurate.

## Files

| File | Move | Change |
|---|---|---|
| `agent/src/valuation.js` *(new)* | 1 | `valueAtIngest`, `planRevaluation`, `applyRevaluation`, `valuationChanged`, `samePricingInputs`, `PRICING_INPUT_FIELDS` |
| `agent/src/local-store.js` | 1, 2 | `frozenValuation` → `storedEvent`; archive I/O and hash helpers out to `archive.js`; owns an `Archive` |
| `agent/src/sync.js` | 1 | extraction loop calls `valueAtIngest` |
| `agent/src/cli.js` | 1, 3 | `cmdReprice` formats only; import rename; optional `doctor --only` |
| `agent/src/counterfactual.js` | 1 | `git mv` from `reprice.js`, content unchanged |
| `agent/src/archive.js` *(new)* | 2 | `Archive`, `orderFields`, `sourceOf`, `sourceHash`, `HASH_VERSION` |
| `agent/scripts/retag-device.mjs` | 2 | import from `archive.js`; fix the stale comment |
| `agent/src/sources/claude-code.js` | 3 | export `parseRecord`, `providerOf`, `listTranscripts` |
| `agent/src/sources/opencode.js` | 3 | export `listModels` |
| `agent/src/doctor.js` | 3 | registry; `dedupeTotals` / `modelsInUse` via the sources; one store, one sink |
| `agent/test/*.test.js` | all | update imports; add per-check doctor tests |
| `README.md` | 1, 3 | module diagram; doctor section |

Expected sizes afterwards, as a sanity check rather than a target: `local-store.js` ≈ 450
lines, `archive.js` ≈ 120, `valuation.js` ≈ 120, `doctor.js` ≈ 420, `cli.js` ≈ 420.

## Verification

1. `npm test` green at the start, and after each of the three commits.
2. **Doctor output is byte-identical** apart from timings: capture `harness-usage doctor`
   before Move 3 and after, `diff` them with the "days ago" and "checks passed" lines
   normalised. Same 14 (or 17 with sources enabled) names, same order, same details.
3. **Sync output identical on a scratch store:** using the plan-005 `scratch()` helper, run
   `sync --no-ship` then `backfill --no-ship` before and after Moves 1–2; the outbox payloads,
   the `archived` hashes and the archive files must be identical. `frozen:` count identical.
4. **The freeze still holds:** plan 004 verification 1 (pin a rate, sync, stored cost
   unchanged) and 2 (`reprice --model` moves it) re-run by hand on desktop.
5. **`retag-device.mjs --from X --to Y`** (dry run, no `--apply`) on a copy of the real store
   prints the same counts before and after Move 2, and the `legacy hashes` line still reads 0.
6. **No duplicated parser remains:** `grep -n "JSON.parse" agent/src/doctor.js` returns
   nothing; `grep -rn "createHash" agent/src agent/scripts` matches only `archive.js`.
7. `git log --stat` shows three commits, each touching only the files its move lists.

## Out of scope

Config resolved at import time (`config.js` `CONFIG_PATH` / `DATA_DIR` module constants),
which is why plan 005 tests the CLI through a subprocess — a worthwhile fourth move, but it
changes every module's constructor signature and deserves its own plan. Moving `summary()`
out of the store. Any change to the Postgres sink, the schema, the dashboard, or the
remaining review findings (override drift blind to the Vercel pin, Postgres scenario
orphans, `DISTINCT ON (project)`), which are functional fixes, not structure.
