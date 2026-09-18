# Plan 008 — `project` is the repository root, not the working directory

Status: **implemented** (2026-09-18). `projectRootOf` + the `project.detectRoot` switch,
both extractors, the `distinctProjects`/`checkProjectsAreRoots` doctor check (now 20 checks),
the shared `rewrite-events.mjs` core (retag-device retooled onto it with byte-identical
output; new `reroot-project.mjs`), docs and tests all landed. `npm test` green at 121.
Verified end-to-end on scratch: a subdirectory cwd collapses to the repo root, the freeze
holds byte-identical, the archive is not duplicated, and doctor flips red→green after the
repair. Machine-side steps 2–7 (run the repair on desktop + laptop, confirm on rpi5) are
Stef's to run.
Builds on 001–007, all implemented. Written 2026-09-18 after "Cost by project" on the
dashboard started showing names like `agent`, `cdk`, `posts`, `src` and `0030-role-instructions`.
Measured against the live store on desktop the same day; every number below is from that
store, not estimated.

## Context

`project` is meant to answer "which codebase was this spend for". Today it is filled with a
**working directory**, and a working directory moves:

- **Claude Code**: `agent/src/sources/claude-code.js:163` stores each record's `cwd`. Claude
  Code's Bash tool persists `cd`, so a session that starts in `~/projects/harness-telemetry`
  and runs a few commands in `agent/` records the rest of its turns under
  `~/projects/harness-telemetry/agent`. The dashboard shows the basename
  (`regexp_replace(project, '^.*/', '')` in `server/grafana/dashboards/harness-usage.json`),
  so the same session appears as `harness-telemetry` and `agent`, and the Postgres views
  (`usage_project`, `usage_scenario_project`) group them apart.
- **OpenCode**: `agent/src/sources/opencode.js:99` prefers `session.directory`, which is where
  the session was *started*, and that can be a subdirectory too.

Measured on desktop's outbox (3,900 Claude Code events, ~1,060 OpenCode):

| what the walk finds | Claude Code events | OpenCode events | examples |
|---|---|---|---|
| `project` **is** a git root | 3,202 | 754 | `~/projects/norareit`, `~/projects/thoryn` |
| `project` is a **subdirectory** of a git root | **534** | **74** | `harness-telemetry/agent` (202), `norareit/cdk` (28), `finrite/api`, `harness-telemetry/agent/src`, `janestreet/archmadness-qwen3-6` |
| no `.git` above it | 198 | 222 | `~/.etlegacy/legacy/zaphod-research`, `~/projects/auctions`, `~/projects` (27), `~` |
| path no longer exists on this machine | 40 | 55 | `~/projects/ritespend`, scratch dirs under `/tmp` |

So about 14% of Claude Code events and 7% of OpenCode events are filed under a
subdirectory name. Every one of those has an unambiguous repository root one to three
levels up.

OpenCode already computes a root of its own: each message's `data.path.root`. It is the git
root when there is one, and **`/` when there is not** (`~/projects/auctions` → `/`,
`~/Documents/obsidian/...` → `/`). It cannot be used as-is, and it would give the two
harnesses different rules. Decision below: one rule, ours, applied to both.

### What the rule must and must not change

- **Valuation is untouched.** `project` is not a pricing input (`PRICING_INPUT_FIELDS` in
  `agent/src/valuation.js`), so re-extracting an event with a different `project` reuses its
  frozen valuation (`frozen: true`) and does **not** invalidate its scenario rows. Plan 004's
  ledger property holds.
- **The archive hash does change.** `project` is a source field, so it is inside `sourceOf()`
  (`agent/src/archive.js`). A `backfill` after this change appends a second archive line for
  every event whose `project` moved — the exact duplication `agent/scripts/retag-device.mjs`
  was written to avoid for `device`. And `backfill` only reaches events still inside Claude
  Code's ~30-day retention; anything older lives only in the archive and would keep its old
  `project` forever. **The existing rows therefore need a repair script, not a backfill**, and
  that script needs the same filesystem the transcript came from, so it runs per device.
- **Postgres updates in place.** `project` is in the sink's `UPDATE_SET`, so a re-shipped row
  overwrites the old value on the same primary key. No migration, no schema change.

## Decision

`project` = the nearest directory at or above the working directory that contains `.git`
(a directory **or** a file: worktrees and submodules have a `.git` file and are checkouts in
their own right). If there is none, `project` stays exactly what it is today. Same rule for
both harnesses. Resolved at extraction time on the device that owns the transcript, via the
filesystem only, no `git` binary.

Two consequences to accept knowingly:

1. **Sub-projects inside one repository collapse into it.** On desktop
   `~/projects/janestreet/{andysafternoonamble,pentupfrustration,hint-singles,archmadness-qwen3-6}`
   become `janestreet`, and `norareit/assets/puzzles/andys-afternoon-amble` becomes `norareit`.
   That is the definition doing its job: they are one repository. If a sub-project deserves
   its own line on the dashboard, giving it its own `.git` is the honest fix. A config
   opt-out is provided so this is reversible without a code change.
2. **Non-repositories keep their working-directory names**, including their subdirectories
   (`zaphod-research` and `zaphod-research/intermediates` stay separate). That is the
   fallback the user asked for, and it is also the pre-change behaviour, so nothing regresses.

## Design

### New module `agent/src/project.js`

```js
/**
 * The repository root for a working directory: the nearest ancestor (inclusive)
 * containing `.git` — a directory or a file — or `dir` itself when there is none,
 * when `dir` does not exist here, or when the only `.git` is at/above $HOME.
 * Filesystem only; memoised per process, since a few thousand events share a
 * few dozen directories.
 */
export function projectRootOf(dir, { home = os.homedir(), fs = node:fs } = {})
```

Rules, in order:

1. `dir` falsy → return it unchanged. `dir` does not exist (`statSync` throws) → return
   unchanged. This covers paths from another machine and deleted scratch directories; the
   walk must never turn a missing path into its nearest existing ancestor.
2. Walk `d = dir, dirname(d), …` until `dirname(d) === d`. At each step, if
   `join(d, ".git")` exists → return `d`. Nearest wins, so a nested repository inside a
   parent repository is its own project.
3. **Stop before `$HOME`.** A `.git` at `$HOME` or above is ignored (a dotfiles repository in
   the home directory is common, and would otherwise swallow every project into `~`). The
   walk also never reaches `/`. If the loop ends without a hit → return `dir` unchanged.
4. Memoise `dir → result` in a module-level `Map`. The process is short-lived, so no
   invalidation is needed; expose `projectRootOf.cache.clear()` for tests.

Pure enough to test with temp directories; no config, no store.

### Extractors

- `sources/claude-code.js` `parseRecord`: `project: projectRootOf(rec.cwd) || null`.
- `sources/opencode.js` `toEvent`: `project: projectRootOf(row.session_dir || d.path?.cwd) || null`.
  Drop the `d.path?.root` fallback: it is `/` when there is no repository, and using it would
  make the two harnesses disagree on the rule.

Both behind one config switch so the old behaviour is one line away:

```json
"project": { "//detectRoot": "true = file events under the nearest .git ancestor of the working directory; false = the working directory itself (pre-plan-008)", "detectRoot": true }
```

`config.js` `DEFAULTS` gets `project: { detectRoot: true }`; `config.example.json` shows it.
The extractors receive `config` already; when `detectRoot` is false they store the raw path.

### One-off repair: `agent/scripts/reroot-project.mjs`

Modelled on `retag-device.mjs`, and sharing its mechanics. Extract the common core into
`agent/scripts/lib/rewrite-events.mjs`:

```js
/**
 * Rewrite already-recorded events in place: outbox payload, archive line and
 * `archived` hash together, so the next record() sees state 'unchanged' and
 * appends nothing. `map(ev)` returns the new event or null to leave it alone.
 * Refuses to run while any legacy (pre-v2) archive hash exists, as today.
 * Returns { examined, changed, archiveLines } ; writes only with apply=true.
 */
export function rewriteEvents({ dataDir, map, apply })
```

`retag-device.mjs` becomes a thin wrapper (`map = ev => ev.device === FROM ? {...ev, device: TO} : null`)
and keeps its CLI and output verbatim. `reroot-project.mjs` uses
`map = ev => { const p = projectRootOf(ev.project); return p !== ev.project ? {...ev, project: p} : null; }`
and prints, in dry-run, the distinct `old → new` pairs with counts — that table is the
review step before `--apply`. Cleared `synced` re-ships the rows; Postgres updates in place.

The `scripts/README.md` table gains a row and its "stop the timer first" instruction applies
unchanged. Add one sentence there: rewriting `project` must run on the device the events
came from, because the walk needs that device's filesystem.

### Doctor check

Append `{ name: "projects are repo roots", run: checkProjectsAreRoots }` to the registry.
It reads distinct `project` values from `ctx.store` (one `SELECT DISTINCT json_extract(...)`;
add `LocalStore.distinctProjects()` for it), applies `projectRootOf` to each that exists on
this machine, and reports how many events sit under a value that resolves elsewhere:

- none → `ok: true`, detail `N distinct projects, all repository roots or non-repositories`.
- some → `ok: false`, detail `608 events under 12 subdirectories of a repo root, e.g.
  ~/projects/harness-telemetry/agent → ~/projects/harness-telemetry — run
  'node agent/scripts/reroot-project.mjs' (dry run first)`.
- `null` when `project.detectRoot` is false.

This is what tells you laptop still needs the repair after desktop is done, and it stays
useful afterwards: a `.git` removed or added later shows up here.

### Files

| File | Change |
|---|---|
| `agent/src/project.js` *(new)* | `projectRootOf` |
| `agent/src/sources/claude-code.js` | `parseRecord` uses it (behind `project.detectRoot`) |
| `agent/src/sources/opencode.js` | `toEvent` uses it; drop the `path.root` fallback |
| `agent/src/config.js`, `agent/config.example.json` | `project.detectRoot`, default true |
| `agent/src/local-store.js` | `distinctProjects()` |
| `agent/src/doctor.js` | `checkProjectsAreRoots`, appended |
| `agent/scripts/lib/rewrite-events.mjs` *(new)* | shared rewrite core |
| `agent/scripts/retag-device.mjs` | thin wrapper over the core; CLI and output unchanged |
| `agent/scripts/reroot-project.mjs` *(new)* | the repair, dry-run by default |
| `agent/scripts/README.md` | new row; per-device note |
| `agent/src/record.js` | comment on `project`: "repository root when one is detectable, else the working directory" |
| `README.md` | Data model: the definition of `project`, the opt-out, the repair step for existing rows |
| `agent/test/project.test.js` *(new)* | below |
| `agent/test/sources.test.js` | one CC and one OC case where the working directory is a subdirectory of a temp repo |
| `agent/test/scripts.test.js` *(new)* | `rewriteEvents` on a temp store: outbox, archive and hash agree afterwards; a following `record()` is `'unchanged'`; dry run writes nothing; refuses on a legacy hash |
| `agent/test/doctor.test.js` | the new check against a temp store with one nested project |

`project.test.js`, each in a temp tree:

- `.git` directory at `repo/`, input `repo/a/b` → `repo`.
- `.git` **file** at `wt/` (worktree shape), input `wt/src` → `wt`.
- nested: `outer/.git` and `outer/inner/.git`, input `outer/inner/x` → `outer/inner`.
- no `.git` anywhere under the temp root → input returned unchanged.
- input path that does not exist → returned unchanged, even when its parent is a repo.
- `home` set to the temp root with `.git` directly in it → ignored; input unchanged.
- memoisation: second call with the same input does not touch the filesystem (spy on `fs`).

## Verification

1. `npm test` green.
2. On desktop, timer stopped, backup taken as `agent/scripts/README.md` says:
   `node agent/scripts/reroot-project.mjs` (dry run) lists the `old → new` pairs; expect
   about **608** events (534 Claude Code + 74 OpenCode) and no pair whose new value is a
   non-repository. `--apply`, then `harness-usage sync`.
3. `harness-usage compact-archive` reports **0** removed: the script did not duplicate lines.
4. `harness-usage doctor`: "projects are repo roots" green; "cost reproducible from stored
   rates" still 0 mismatches (nothing about valuation moved).
5. On rpi5: `SELECT project, count(*) FROM usage_event GROUP BY 1 ORDER BY 2 DESC` shows no
   path that is a subdirectory of another listed path; `SUM(cost_usd)` unchanged from before
   the repair. "Cost by project" on the dashboard shows repository names only.
6. The freeze held: pick one rerooted event; `cost_usd`, `rate_*` and `priced_at` are
   byte-identical before and after.
7. On laptop, `doctor` goes red on the new check until the script is run there, then green.
8. Flip `project.detectRoot` to false in a scratch config and run `sync --no-ship` on the
   plan-005 fixture with a nested cwd: `project` is the raw cwd again.

## Out of scope

Recovering a better name for non-repositories (a `package.json` name, a `.project` marker):
the fallback stays the working directory, as asked. Keeping the raw working directory in a
second column; the archive's superseded lines retain it, and nothing reads it. Reading
OpenCode's `path.root`. A dashboard variable to filter by project.
