# Plan 005 — Unit tests for the arithmetic and the store

Status: **approved, not yet implemented.**
Builds on 001 (pipeline), 002 (counterfactual repricing), 003 (stored rates) and 004 (freeze
at ingest), all implemented. Written 2026-09-18 from a full review of the working tree at
commit `bc923d6`.

## Context

The project has no automated tests. `agent/package.json` has no `test` script and no test file
exists anywhere. Verification so far has been (a) the `doctor` probes, which run against live
data on a timer, and (b) two external review passes, each of which found defects one at a time.

Every defect this project has actually shipped was the unit-testable kind — a pure function or a
single store method, given a synthetic input, checked against a known number:

| Defect | Where it lived | Would a 10-line test have caught it? |
|---|---|---|
| Anthropic thinking tokens billed at $0 (plan 002 Bug A, $25.41) | `pricing.js` | yes |
| `openai/gpt-5.6-terra-fast` resolved to $0 for 171 events | `pricing.js` resolve | yes |
| `lmstudio` fell through to `priced_by='none'` as billable | `pricing.js` LOCAL_PROVIDERS | yes |
| `priced_at` missing from `SCENARIO_COLUMNS`, every scenario row shipped NULL | `sink-postgres.js` | yes (column parity) |
| The plan-004 freeze never enforced; `backfill` re-valued everything | `sync.js` / `local-store.js` | yes |
| Scenario rows go stale when an event's tokens change (review finding C1, open) | `reprice.js:104` | yes |
| `reprice` ignores a billing change (review finding C2, open) | `cli.js:213-215` | yes |

None of these needed Postgres, Tailscale or real transcripts. The doctor probes are, in effect,
unit tests running in production: dataset-dependent, so they drift, and unable to run before a
change lands.

The runtime already provides everything needed. `node:test` and `node:assert` are built in
(Node ≥22.13 is already required for `node:sqlite`), so the "one dependency, no build step"
principle holds. `LocalStore` takes a `dataDir`, `Pricing` takes a table object, and the
extractors take a `store`, so no refactoring is required to make the modules testable.

## Decision

Add a `node --test` suite under `agent/test/`, targeted at invariants the plans state, not at
coverage. Two of the tests will be red against the current code (C1, C2 above); fixing those two
defects is **in scope**, because a suite that ships red is worthless. Everything else found by
the review is out of scope here and tracked separately.

The `doctor` probes stay. They answer a different question (is *this machine's* data sane right
now); the tests answer "is the code right", before it lands.

## Design

### Runner and layout

```
agent/
├── package.json          "test": "node --no-warnings --test test/"
└── test/
    ├── helpers.js        tmp data dir, synthetic price table, event factory, CLI runner
    ├── pricing.test.js
    ├── record.test.js
    ├── local-store.test.js
    ├── reprice.test.js
    ├── sources.test.js
    ├── schema-parity.test.js
    ├── doctor.test.js
    └── cli.test.js       spawns src/cli.js against a scratch data dir
```

Every test that touches disk creates its own directory with
`mkdtempSync(join(tmpdir(), "harness-usage-"))` and removes it in `after()`. No test reads
`~/.cache/opencode/models.json`, `~/.claude`, `~/.local/share/opencode` or the real config —
each is either given a synthetic table object or pointed at a fixture through
`HARNESS_USAGE_CONFIG` / `HARNESS_USAGE_DATA_DIR`.

**Why the CLI tests spawn a subprocess:** `config.js` reads `HARNESS_USAGE_CONFIG` and
`HARNESS_USAGE_DATA_DIR` into module-level constants at import time, and `cli.js` executes its
command on import. Spawning `node src/cli.js <cmd>` with `env` set is therefore the only way to
exercise `sync`/`backfill`/`reprice` end to end without restructuring those modules, and it is
also the most faithful test: it runs exactly what the timer runs.

### Helpers (`test/helpers.js`)

- `table(entries)` — builds a `models.json`-shaped object
  `{ <provider>: { models: { <modelKey>: { cost: {...} } } } }` from a flat
  `{ "provider/model": cost }` map. Keeps each test's rate card visible in the test itself.
- `event(overrides)` — a canonical event with all six token counts at 0, `provider: "anthropic"`,
  `model: "claude-sonnet-5"`, `harness: "claude-code"`, `ts: "2026-09-01T10:00:00Z"`.
- `scratch()` — creates a tmp dir, returns `{ dir, dataDir, config, writeConfig(obj),
  writeTranscript(lines), run(cmd, ...args) }`. `run` spawns
  `node --no-warnings src/cli.js` with the env vars set and returns `{ code, stdout, stderr }`.
  `writeTranscript` writes `<dir>/cc/proj/sess1.jsonl` in Claude Code's shape (see the fixture
  below).
- `readOutbox(dataDir)` / `readScenarios(dataDir)` — open `state.sqlite` read-only and return
  parsed payloads.

A Claude Code transcript line that the extractor accepts, for reference (all of these fields
are read by `sources/claude-code.js` `parseLine`):

```json
{"type":"assistant","uuid":"u1","requestId":"r1","sessionId":"sess1",
 "timestamp":"2026-09-01T10:00:00Z","cwd":"/p","gitBranch":"main",
 "message":{"model":"claude-sonnet-5","usage":{
   "input_tokens":100,"output_tokens":1000,
   "output_tokens_details":{"thinking_tokens":200},
   "cache_read_input_tokens":1000,"cache_creation_input_tokens":50,
   "cache_creation":{"ephemeral_1h_input_tokens":50,"ephemeral_5m_input_tokens":0}}}}
```

### What to test, in order of value

#### 1. `pricing.test.js` — the rules plans 001/002 state

All against a synthetic table; rates are USD per 1e6 tokens as everywhere else.

| # | Case | Input | Expect |
|---|---|---|---|
| 1 | Reasoning billed at output rate (plan 002 Bug A) | `reasoning_tokens: 1_000_000`, output rate 25 | `cost_usd = 25` |
| 2 | Missing `cache_read` → input rate, `cache_model='none'` (Bug B) | card `{input:0.1, output:0.4}`, `cache_read_tokens: 1_000_000` | `cost_usd = 0.1`, `rate_cache_read = 0.1` |
| 3 | Highest exceeded tier wins (Bug C) | qwen3.7-flash's real card: base 0.03/0.13, tiers 32k → 0.1/0.4, 256k → 0.2/0.8; `input 200_000 + cache_read 100_000` | `tier_applied = 256000`, `rate_input = 0.2` |
| 3b | Middle tier | same card, `input 50_000` | `tier_applied = 32000`, `rate_input = 0.1` |
| 3c | Below every tier | same card, `input 10_000` | `tier_applied = null`, `rate_input = 0.03` |
| 3d | `context_over_200k` without `tiers` | `{input:2, output:12, context_over_200k:{input:4, output:18}}`, `input 250_000` | `tier_applied = 200000`, `rate_input = 4` |
| 4 | Missing `cache_write` → input rate, `cache_model='read-only'` (Bug D) | `{input:2, output:10, cache_read:0.2}`, `cache_write_5m_tokens: 1_000_000` | `cost_usd = 2`, `rate_cache_write_5m = 2`, `rate_cache_write_1h = 2` |
| 5 | Anthropic 1h = 2 × input | provider `anthropic`, `{input:2, output:10, cache_read:0.2, cache_write:2.5}`, `cache_write_1h_tokens: 1_000_000` | `cost_usd = 4`, `rate_cache_write_1h = 4`, `rate_cache_write_5m = 2.5` |
| 5b | 1h rule is Anthropic-only | same card under provider `openrouter`, repriced via `repriceEvent` | `cost_usd = 2.5` |
| 6 | Full worked example (README) | card `{input:10, output:50, cache_read:0.25, cache_write:12.5}`, event `input 32, output 1222, reasoning 292, cache_read 104645, cw1h 727` | `cost_usd = 0.116721` |
| 7 | Local providers are $0 before any lookup | each of `ollama`, `lmstudio`, `llamacpp`, `local`, **with** a matching table entry present | `cost_usd = 0`, `billing = 'local'`, `priced_by = 'none'`, every `rate_* = null`, `priced_at` non-null |
| 8 | No card | unknown provider/model | `cost_usd = 0`, `priced_by = 'none'`, `billing` = the source billing passed in, rates null, `priced_at` non-null |
| 9 | Override beats table | same key in both, different rates | `priced_by = 'override'`, override's rates applied |
| 10 | Provider-scoped lookup only (commit 404871d) | table has only `foo/qwen3.6:27b`; `resolve("bar", "qwen3.6:27b")` | `card = null` |
| 10b | Bare-name fallback **within** a provider | table has `openrouter/qwen/qwen3.7-flash`; `resolve("openrouter", "qwen3.7-flash")` | resolves |
| 11 | `resolveKey` splits on the first slash | `"tokengo/z-ai/glm-5.2"` | `provider = "tokengo"`, `model = "z-ai/glm-5.2"` |
| 12 | `tableCard` ignores overrides | key overridden and in table | returns the table's rates |
| 13 | `cacheModelOf` | cards with both / read only / neither | `'full'` / `'read-only'` / `'none'` |

#### 2. `record.test.js` — canonical shape

- `makeEvent` coerces token counts with `int()`: `"12.6"` → 13, `-5` → 0, `undefined` → 0.
- `rate_*` and `tier_applied`: `undefined` → `null`, **not** 0; `0` stays 0.
- `priced_at`: absent → `null` (never defaulted to now); a Date or epoch number → ISO string.
- `eventKey` is `harness + "\x1f" + session_id + "\x1f" + message_id`; `eventDay` is the UTC date.
- `DERIVED_FIELDS` ⊆ `FIELD_ORDER`, and contains `priced_at` (plan 004: otherwise every reprice
  appends an archive line).

#### 3. `local-store.test.js` — the store and the freeze

`record()`:
- first call → `'new'`, one archive line, one `archived` row with a `v2:` hash.
- same payload → `'unchanged'`, no new line, `synced` untouched (set it to 1 first and assert it
  stays 1).
- derived-only change (`cost_usd` differs) → `'changed'`, `synced` reset to 0, **no** new archive
  line.
- source change (`output_tokens` differs) → `'changed'`, one new archive line.
- legacy hash: insert an `archived` row whose hash lacks the `v2:` prefix, `record()` the same
  event → no line appended, hash now starts with `v2:`.

`frozenValuation(key, inputs)` (this is what enforces plan 004):
- no row → `null`.
- same provider/model/six counts → returns exactly the `DERIVED_FIELDS` of the stored payload,
  including `priced_at: null` when stored as null (the "valued before the freeze" case must
  survive round-trip as null).
- any one token count changed, or model changed → `null`.
- `""` and `undefined` provider compare equal to stored `null` (the `str()` normalization).

Scenarios:
- `recordScenarios` + `existingScenarioPairs()` predicate true for a stored pair, false for a
  new scenario key on the same event.
- `recordScenarios` with an identical payload leaves `synced = 1`; a changed cost resets it.
- `dropScenario(key)` returns the row count and removes only that scenario.
- `pruneScenarios(keep)` removes only scenarios not in `keep` and returns their names.

Archive round-trip:
- `compactArchive`: two lines for one key → one line, the **last** one; unparseable lines kept.
- `importArchive`: archive with two lines for `k1` (last-wins) and one for `k2`; outbox already
  holds `k2` with a different cost → `restored = 1`, `present = 1`, `k2` untouched, and a
  subsequent `record()` of `k1` with the same source data reports `'unchanged'` and appends
  nothing (the `archived` hash was stamped).

Outbox:
- `unsynced()` returns rows ordered by `ts`; `markSynced` flips them and `unsynced()` is then
  empty.
- `transaction()` rolls back on throw: record inside, throw, assert outbox empty.

#### 4. `reprice.test.js` — `compare` and `scenarioRows`

- `compare` with an unresolvable scenario: `meta[i].resolved === false`, and the key is absent
  from every row's `scenarios` (plan 002 item 7: never reported as $0).
- `--group` semantics: `groupBy: "model"` produces `provider/model` keys; unknown group throws.
- Rows sort by `actual_cost_usd` descending; totals equal the sum of rows (to 4 dp).
- `scenarioRows` skips pairs the predicate reports as existing, skips unresolved targets, and
  carries all five `rate_*`, `tier_applied`, `cache_model` and `priced_at`.

#### 5. `sources.test.js` — extractors against fixtures

Claude Code (`extractClaudeCode` with a `LocalStore` in a tmp dir and `root` pointing at a
tmp transcript tree):
- Three lines sharing `requestId r1` → one event. Falls back to `uuid` when `requestId` is absent.
- `model: "<synthetic>"` dropped; `type !== "assistant"` dropped; lines without `usage` dropped.
- Thinking split: `output_tokens 1000, thinking 200` → `output_tokens 800, reasoning_tokens 200`.
- Cache TTL: with `cache_creation` present, 1h/5m map to the two columns; without it, the flat
  `cache_creation_input_tokens` lands in `cache_write_5m_tokens`.
- `providerOf`: `claude-*` → anthropic, `gpt-*` → openai.
- **Cursor and the partial trailing line:** write one complete line plus half a second line
  with no trailing newline. First run yields one event and stores an offset equal to the end of
  the first line. Complete the second line, run again → exactly one more event. Then a third run
  yields nothing (`startOffset === size`).
- A file replaced with a different inode is re-read from 0.

OpenCode (`extractOpenCode` against a tmp SQLite built with `DatabaseSync`, tables `message(id,
session_id, time_created, time_updated, data)`, `session(id, directory, parent_id,
workspace_id, agent, model, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
tokens_cache_write)`, `workspace(id, branch, directory)`):
- Assistant message with `tokens {input, output, reasoning, cache:{read, write}}` → the six
  columns, reasoning kept **separate** from output, `cache.write` → `cache_write_5m_tokens`.
- `role: "user"` rows skipped; `parent_id` set → `is_sidechain = true`; `workspace.branch` →
  `git_branch`; `session.directory` → `project`.
- Watermark: after a run, `kv` holds the max `time_updated`; a second run re-yields the boundary
  row (`>=`) and nothing older.
- `reconcile()` reports `ok === total` for a session whose rollup columns match, and lists the
  mismatch when one column is off by one.

#### 6. `schema-parity.test.js` — the class of bug that shipped `priced_at` as NULL

Parse `server/postgres/init/01-schema.sql` textually: take the block between
`CREATE TABLE IF NOT EXISTS usage_event (` and its `PRIMARY KEY`, strip `--` comments, and take
the first token of each remaining line as a column name. Assert:

- usage_event columns == `FIELD_ORDER` ∪ `{ synced_at }` (as sets, and `FIELD_ORDER` order is a
  prefix-compatible subsequence is **not** required — the sink names its columns).
- usage_scenario columns == `SCENARIO_COLUMNS` ∪ `{ synced_at }`. This needs
  `SCENARIO_COLUMNS` exported from `sink-postgres.js` (currently module-private; export it, no
  other change).
- Every column that `001-add-rates.sql` and `002-add-priced-at.sql` add exists in
  `01-schema.sql` (migrations and fresh installs must converge).
- `UPDATE_SET` (export it too) excludes exactly the three PK columns and includes every other
  `FIELD_ORDER` column — this is the line plan 004 identified as the reason storing rates did not
  freeze them; if someone later excludes `rate_*` from the update set, this test documents that
  they changed the freeze semantics deliberately.

#### 7. `doctor.test.js` — the pieces that are pure

- `redactDsn` (export it): password containing `@` and `:` is fully masked; DSN without a
  password is returned unchanged; a non-URL string is returned unchanged. This is commit
  905d1e3's bug, currently guarded by nothing.
- The reasoning probe as a unit: `price({reasoning_tokens: 1e6}, ...)` equals the card's output
  rate. (Same as pricing #1, kept here so a future doctor refactor cannot drop it silently.)

#### 8. `cli.test.js` — end to end, through the real entry point

Each test gets a `scratch()` with `postgres.dsn: null`, `opencode.enabled: false`, a config
`scenarios: ["openrouter/anthropic/claude-sonnet-5"]`, and `pricing.modelsJson` pointing at a
fixture file `test/fixtures/models.json` that contains **only** the entries the tests need
(`anthropic/claude-sonnet-5` and `openrouter/anthropic/claude-sonnet-5` at 2/10/0.2/2.5,
`anthropic/claude-opus-5` at 5/25/0.5/6.25). Do not point at `~/.cache`.

1. **Sync prices at ingest.** Two-line transcript → `recorded new=2`, two scenario rows, both
   `priced_at` non-null and within a minute of now.
2. **Freeze holds across backfill.** Pin `anthropic/claude-sonnet-5` at output 999 in a scratch
   overrides file, `backfill --no-ship` → stdout contains `frozen: 2`, both costs and `priced_at`
   byte-identical to step 1. (Plan 004 verification 1.)
3. **Two syncs generate zero new scenario rows.** (Plan 004 verification 4.)
4. **Changed tokens re-price the event AND its scenario rows** — *C1, red today.* Rewrite the
   transcript with `output_tokens` 1000 → 3000 for `r1`, `backfill --no-ship`. Expect the event's
   cost to move, its `priced_at` to advance, **and** the scenario row for `r1` to move to the
   cost of the new tokens with a new `priced_at`; the scenario row for `r2` must be untouched.
5. **`reprice --dry-run` writes nothing.** Pin output 999, run it → stdout says 2 would change;
   outbox payloads unchanged. (Plan 004 verification 3.)
6. **`reprice` applies and stamps.** Same pin, `reprice --model anthropic/claude-sonnet-5` →
   costs moved, `priced_at` advanced, rows `synced = 0`.
7. **`reprice` picks up a billing change** — *C2, red today.* Change the source's `billing` from
   `free` to `api`, run `reprice` → both rows now `billing = 'api'`, cost unchanged.
8. **`reprice` fills missing rates** — *C2, red today.* Set `rate_input` and friends to `null` in
   one stored payload (simulating a pre-plan-003 row) with the price unchanged, run
   `reprice` → the row now carries rates and its `priced_at` is set.
9. **Strict flags.** `reprice --dryrun` and `reprice --model --dry-run` exit 2 and write nothing.
10. **`restore-archive` then `sync`.** Delete `state.sqlite`, `restore-archive` → `restored 2`;
    `sync --no-ship` → `unchanged=2`, archive line count unchanged.

### The two fixes in scope

**C1 — scenario rows must follow a token correction.** In `sync.js`, inside the extraction loop:
after `store.record(...)`, if `state === "changed"` and `frozen` is null, the event existed and
its pricing inputs changed. Collect its `eventKey` and, before `scenarioRows()` runs, call a new
`store.dropScenariosFor(keys)` that deletes those events' rows from `outbox_scenario`. The
existing incremental pass then regenerates them with a fresh `priced_at`, which is the honest
date. Do **not** add token counts to the scenario payload or a second "inputs unchanged" check;
the event freeze already knows exactly when inputs changed, and one decision point is the point.
Report the count as `report.scenariosInvalidated` and print it in `cmdSync` when non-zero.

**C2 — `reprice` must compare the whole valuation.** In `cli.js` `cmdReprice`, replace the
`moved` predicate with a comparison over every field in `DERIVED_FIELDS` except `priced_at`:
numbers compared with `1e-9` tolerance, `null` ≠ `0`, strings by equality. Import
`DERIVED_FIELDS` from `record.js`. The dry-run and sample output are unchanged. While there,
change the doctor detail at `doctor.js:225` from "run backfill" to
"run 'harness-usage reprice --model <provider/model>'", since under the freeze a backfill reuses
the stored nulls (review finding C3); and the same sentence in
`server/postgres/migrations/001-add-rates.sql:16-17`.

### Files

| File | Change |
|---|---|
| `agent/package.json` | `"test": "node --no-warnings --test test/"`. No new dependency. |
| `agent/test/helpers.js` *(new)* | as above |
| `agent/test/*.test.js` *(new, 8 files)* | as above |
| `agent/test/fixtures/models.json` *(new)* | three entries, listed in §8 |
| `agent/src/sink-postgres.js` | `export` `SCENARIO_COLUMNS` and `UPDATE_SET` |
| `agent/src/doctor.js` | `export` `redactDsn`; fix the "run backfill" advice |
| `agent/src/sync.js` | C1: collect changed-input keys, `dropScenariosFor` before the scenario pass |
| `agent/src/local-store.js` | C1: `dropScenariosFor(keys)` |
| `agent/src/cli.js` | C2: `moved` over `DERIVED_FIELDS` |
| `server/postgres/migrations/001-add-rates.sql` | comment: "backfill" → "reprice" |
| `README.md` | one paragraph under *Agent*: `npm test`, what it covers, that `doctor` is the live-data complement not a replacement |

## Verification

1. Write §8 tests 4, 7 and 8 **first** and run `npm test`: exactly those three must fail, with
   assertion messages naming the stale scenario cost / unchanged billing / null rates. Commit
   that red state separately so the history shows the tests caught the defects.
2. Apply the C1 and C2 fixes; `npm test` is fully green.
3. `npm test` runs in under 10 seconds on desktop and touches nothing under `~/.local/share`,
   `~/.cache` or `~/.claude` — verify by running with `HOME=$(mktemp -d)`.
4. Every existing `doctor` check still passes on desktop (the doctor is untouched apart from one
   string and one export).
5. Real-data check for C1: on desktop, `harness-usage sync` after the fix reports
   `scenariosInvalidated` 0 on a quiet run; then `SELECT count(*) FROM usage_scenario s JOIN
   usage_event e USING (harness, session_id, message_id) WHERE s.priced_at < e.priced_at` on
   rpi5 must trend to 0 as boundary rows are re-read — every scenario row valued before its event.
6. Real-data check for C2: `harness-usage reprice --dry-run` on desktop reports 0 would change
   (no pins have moved), and the doctor's "cost reproducible" check no longer counts any row as
   "priced but missing rates".

## Out of scope

The other review findings (override drift blind to the Vercel-sourced pin, Postgres orphans
after de-configuring a scenario, the `DISTINCT ON (project)` alias collapse in the dashboard,
doctor/extractor provider mapping mismatch, stale README sections and plan status lines, and
the plan-level questions about "priced at ingest" vs "priced when it happened"). Tests for the
Postgres sink against a live server, and any Grafana panel testing. Coverage tooling.
