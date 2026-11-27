# Plan 025 — Read OpenCode 2 databases

Type: **task**
Status: **planned** (2026-11-27). Not implemented.

Builds on 001–024, chiefly 004 (pricing frozen at ingest), 008 (project root) and 018 (extra homes).

## Feature

OpenCode 2 (npm `@opencode/cli`, 2.4.2) replaces OpenCode 1 on the devices and in the container sandboxes that plan
018 reads as extra homes. It keeps the database path (`~/.local/share/opencode/opencode.db`) but changes the schema,
and the OpenCode source in this agent can read only the old one. This plan makes the agent read both schemas, and
any mix of them, for as long as devices and homes still run or hold OpenCode 1 data. It also covers the price table,
which OpenCode 2 no longer writes to `~/.cache/opencode/models.json`.

No Postgres schema change, no change to the event shape, no repricing. Every event from an OpenCode 2 database is
priced once at ingest, as today.

## What OpenCode 2.4.2 does (observed by the maintainer)

These were seen with a fresh home and with a copy of a 1.19.6 database:

- **Messages** are written only to `session_message(id, session_id, type, seq, time_created, time_updated, data)`.
  The role is the `type` column: `user`, `assistant`, `idle`, `system`, `synthetic`, `compaction`. The assistant
  `data` JSON keeps `tokens {input, output, reasoning, cache:{read,write}}`, `agent` and `time.completed` as in 1.x.
  The model moved: it is `data.model.{providerID, id, variant}`, no longer `data.providerID` / `data.modelID`.
- **Sessions** are in `session_v2` (`directory`, `parent_id`, `workspace_id`, `version`, `agent`, `model`, and the
  same `tokens_*` rollup columns as 1.x `session`). `workspace` has no `branch` column any more.
- **A database created by OpenCode 2** has no `message` or `session` table. Today the agent skips such a home as
  "not an OpenCode database" (`readHomeDatabase`), and the device's own database makes `sync` fail, because
  `MESSAGE_QUERY` is prepared outside any error handling (`extractDatabase` in `agent/src/sources/opencode.js`).
- **A 1.x database is converted in the background**, in batches, while OpenCode 2 runs. 373 sessions took three
  short runs. The old `message`, `session` and `part` tables are left untouched. Converted rows keep the message ids
  and `time_updated`, and the token sums matched exactly.
- **Prices:** `~/.cache/opencode/models.json` is no longer written. The catalogue is in `opencode.db`, table `kv`,
  key `models-dev:v3:catalog`, a JSON value with `updatedAt`, `digest` and `body`.
- **Logins** moved from `auth.json` to a `credential` table in `opencode.db`, so a copy of a home now carries them.
- **Plugins:** there is no `session.idle` event; a turn ends with `session.execution.succeeded` or
  `session.execution.failed`. A 1.x plugin is not loaded. This repository ships no OpenCode plugin (plan 001 only
  mentioned a `session.idle` sync as an option that was never built), so nothing here breaks. See "Out of scope".

### Not yet confirmed, to check first on a copy (step 1 of "Verification")

The implementer must answer these against a **copy** before writing the matching code, and record the answers in
this plan:

1. Do converted rows keep the **session id** as well as the message id? The event key is
   `(harness, session_id, message_id)`; a new session id would make every converted message a second event.
2. Does `data.model.id` of a converted message equal the old `data.modelID`, and `data.model.providerID` the old
   `data.providerID`, for every converted assistant message? In particular, do the `-fast` model ids priced by plans
   022 and 023 survive as ids, or become a base id plus a `variant`? Provider and model are pricing inputs.
3. Do rows of any `type` other than `assistant` (`compaction` especially) carry non-zero `tokens`? Run the
   reconciliation of change 4 on the copy: if assistant rows alone sum to the `session_v2` rollups for every session,
   only assistant rows carry usage.
4. The column names of `kv` (key and value), and the shape of `body`: a JSON string or an object, and whether it is
   the `models.json` shape (`{ <providerId>: { models: { <modelKey>: { cost, … } } } }`). Also whether `updatedAt` is
   epoch milliseconds or an ISO string.
5. Whether `session_v2` and `session_message` are ordinary tables (not views) and whether `session_message.id` and
   `message.id` are indexed (primary keys), which the anti-join of change 2 relies on.

If answer 1 or 2 is "no", stop and bring it back to the maintainer: the design below assumes "yes".

## Design

### Which tables a database has

Each OpenCode database, the device's own and each home's, is classified when opened:

- **v1**: `message`, `session` and `workspace` are ordinary tables (today's check, `HOME_TABLES_QUERY`).
- **v2**: `session_message` and `session_v2` are ordinary tables.
- A database can be both (converted or being converted), only one, or neither. **Neither** is "not an OpenCode
  database", reported as today. The same view/virtual-table rule applies to the v2 names.

### Reading a v1 + v2 database without double counting

Both parts are read, each with its own watermark:

- **v1 part:** exactly today's query and watermark keys (`watermark:opencode:time_updated`, and
  `watermark:opencode:time_updated:<path>` for a home). A device that upgrades the agent re-reads nothing.
- **v2 part:** `session_message` joined to `session_v2`, `type = 'assistant'`, `time_updated >= ?`, with new keys
  `watermark:opencode-v2:time_updated` and `watermark:opencode-v2:time_updated:<path>`. `resetCursors` already
  deletes every `watermark:%`, so `backfill` resets both.
- **A v2 row whose id is also in `message` is skipped** (`NOT EXISTS (SELECT 1 FROM message WHERE id = sm.id)`),
  when the database has a `message` table. Converted messages therefore keep coming from v1 only. If they came from
  v2 instead, the PK upsert would absorb them, but not unchanged: v2 has no branch, so `git_branch` would be
  overwritten with null, `record()` would report the event `changed`, and the archive would get a second line per
  converted message. With the anti-join nothing converted is read twice. The upsert is still the backstop, and step 2
  of "Verification" checks that, too.

  The anti-join also makes the order of conversion irrelevant to the watermarks: conversion inserts rows with old
  `time_updated` values, possibly below a v2 watermark that new messages have already advanced. Those rows are all in
  `message`, so skipping them loses nothing.

### A v2 message as an event

`toEvent` gets a v2 sibling that differs only in where it reads:

| event field     | v1 (unchanged)                    | v2                                                 |
|-----------------|-----------------------------------|----------------------------------------------------|
| role filter     | `data.role === 'assistant'`       | `type` column = `'assistant'` (in SQL)             |
| `provider`      | `data.providerID`                 | `data.model.providerID`                            |
| `model`         | `data.modelID`                    | `data.model.id`; `variant` is not stored           |
| `agent`         | `data.agent \|\| data.mode`       | same                                               |
| `project`       | `session.directory`               | `session_v2.directory` (then plan 008's root rule) |
| `git_branch`    | `workspace.branch`                | null: OpenCode 2 does not record one               |
| `is_sidechain`  | `session.parent_id`               | `session_v2.parent_id`                             |
| `ts`            | `time.completed`, `time.created`, `time_updated` | same                                |
| tokens          | `tokens.*`                        | same                                               |

`message_id` is the row id and `session_id` the row's `session_id`, as in v1. A home's v2 rows go through the same
`typeof` guards as `HOME_MESSAGE_QUERY` (text ids and data, integer `time_updated` within `Number.MAX_SAFE_INTEGER`)
and through `wellFormed`. The `variant` is dropped because nothing downstream has a column for it and, if question 2
is answered "yes", it does not affect the model id that pricing looks up.

The losing `git_branch` is accepted: it is a label, not a pricing input, and OpenCode 2 has nothing to read it from.

### Price table

OpenCode 2 no longer writes `models.json`, but the file stays on a device that has moved, ageing. Under plan 004 a
stale table is permanent damage, so the agent must not keep reading the old file there.

`loadPricing` reads both sources the device has and uses the **fresher** one:

- `models.json` (`pricing.modelsJson`, unchanged), dated by its mtime, as today.
- The catalogue in the device's own OpenCode database: new config key `pricing.catalogDb`, default
  `~/.local/share/opencode/opencode.db`, opened read-only. Row `models-dev:v3:catalog` of `kv`, dated by `updatedAt`.
  Its `body` is parsed as the table (decoded from a string first if question 4 says it is one).

A source that is missing or unreadable is ignored when the other loads. When neither loads, `tableError` is set as
today. `meta` records which source won, its path (for the database, `<path>#kv:models-dev:v3:catalog`), and its date,
so doctor's "price table" and "price table freshness" checks report that source and date instead of `models.json`'s
mtime. Extra homes' catalogues are not read: the price table is the device's own.

Only the `kv` row is read. The agent never queries `credential` or any table other than those named in this plan.

### Doctor

- **opencode db:** counts per part, e.g. `412 messages / 82 sessions (1.x), 38 messages / 3 sessions (2.x)`.
  Passes when at least one part is present.
- **opencode reconciliation:** the existing check on the v1 part, and the same check on the v2 part (assistant rows
  of `session_message` summed per session against `session_v2.tokens_*`). Each part is reconciled on its own tables.
  Do not combine them, because a converted session has its messages in both.
- **models priced:** `listModels` returns the pairs of both parts.
- **extra homes:** `readHomeDatabase` reads both parts, so the check and extraction agree, as plan 018 requires.
- **price table** / **price table freshness:** as described above.

## Changes

1. `agent/src/sources/opencode.js`
   - Replace the fixed table check with a classifier returning `{ v1, v2 }` (both booleans), used by the device's
     own database and by `readHomeDatabase`. Neither present → the device's own database is skipped (reported by
     doctor, not thrown in `sync`); a home's throws "not an OpenCode database: needs message, session and workspace,
     or session_message and session_v2, as tables", as today.
   - Add `V2_MESSAGE_QUERY` and its guarded home variant, with the anti-join when `v1` is true.
   - Add the v2 event mapping (table above); keep `toEvent` for v1 unchanged.
   - Separate watermark keys for the v2 part, for the device's own database and per home path.
   - `listModels` and `reconcile` handle both parts. `reconcile` returns per part, e.g. `{ v1: {...}, v2: {...} }`,
     each `null` when that part is absent.
   - Update the header comment: the schema notes for 1.x and 2.x, and why converted rows are read from 1.x only.
2. `agent/src/pricing.js`: the catalogue source and the fresher-wins rule; `meta` gains `source` and `updatedAt`.
   Update the header comment that calls `models.json` the source of truth.
3. `agent/src/config.js`: `pricing.catalogDb` in `DEFAULTS`; `agent/config.example.json` gets the same key.
   Pass it wherever `modelsJsonPath` is passed (`sync.js`, `cli.js` twice, `doctor.js`).
4. `agent/src/doctor.js`: the checks listed under "Doctor". "price table freshness" stops calling `stat` on
   `modelsJson` and uses `pricing.meta.updatedAt`; its advice ("run OpenCode to refresh it") stays.
5. `README.md`: the data-sources diagram and text name both schemas and both price sources. One sentence that a
   copy of an OpenCode 2 home contains its logins (`credential` table) and must be kept private.
6. Tests (`agent/test/`, synthetic databases only, no home access):
   - `sources.test.js`: a v2-only database yields its assistant rows with provider and model from `data.model`,
     `git_branch` null, `is_sidechain` from `parent_id`; `user`/`idle`/`system`/`synthetic`/`compaction` rows are
     ignored even with tokens; a second run yields nothing new.
   - Mixed database: a message in both `message` and `session_message` is yielded once, with its v1 branch; a v2-only
     message is yielded; the two watermarks advance independently; a converted row added later with an old
     `time_updated` is not yielded.
   - The device's own v2-only database no longer makes `extractOpenCode` throw; a database with neither part yields
     nothing.
   - A home with a v2-only database is read; `session_message` as a view is rejected; a v2 row with a non-text id or
     an out-of-range `time_updated` is dropped, the others kept.
   - `reconcile` and `listModels` on v1-only, v2-only and mixed databases.
   - `pricing.test.js`: the catalogue loads from a `kv` fixture; the fresher source wins either way round; a missing
     `kv` row or a malformed `body` falls back to `models.json`; neither → `tableError`.
   - `doctor.test.js`: "opencode db", "opencode reconciliation" and "extra homes" on v2-only and mixed databases;
     "price table freshness" dated from the catalogue.
   - `npm test` in `agent/`, also as `HOME=$(mktemp -d) npm test`.
7. This plan: answers to the five questions, then the `Status:` line with what was verified.

## Order of moving

The agent change ships **before, or together with**, each move to OpenCode 2. Nothing in the agent depends on the
move having happened, so it can ship early. Moving first means `sync` fails on a device whose own database becomes
2.x-only (fresh install) and a moved sandbox home drops out silently.

1. Implement, and verify on copies (steps 1 and 2 below). OpenCode 1 still runs everywhere.
2. Update the agent on every device that runs it, still on OpenCode 1. On each: `doctor` passes and a `sync` reports
   0 `changed` events, so the v1 path is unchanged.
3. Move a device to OpenCode 2 only after step 2 on that device. The same applies to the sandboxes, because the
   device's agent reads their homes. Sandboxes and the device can move in either order once the device has the
   updated agent.
4. After each move: `doctor` (step 3 below).
5. Keep reading both schemas. Dropping v1 support needs its own plan, once no device or home holds a 1.x-only
   database.

## Verification

Against **copies** only, never a live database. Copy with SQLite's backup (`sqlite3 <db> ".backup <copy>"`, or
`node:sqlite`'s `backup()`), not `cp`, so a running OpenCode's WAL is included consistently. A device database can be
several GB, so check free space first. Use a scratch config and data directory (`--no-ship`). A copy of a 2.x home
holds credentials: keep it in a directory only the user can read and delete it afterwards.

1. **Answer the five questions** on a copy of a 1.x database converted by OpenCode 2.4.2 (run OpenCode 2 with `HOME`
   pointing at a scratch home holding the copy, until conversion is done).
2. **Overlap**, on a fresh copy of the same 1.x database:
   - `sync --no-ship` with the updated agent before conversion. Note the event count.
   - Let OpenCode 2 convert part of it (stop it after one short run), `sync --no-ship`: 0 new, 0 changed.
   - Finish the conversion, `sync --no-ship`: 0 new, 0 changed. Then `backfill` (a full re-read): 0 changed.
   - Backstop check: with the anti-join disabled (a local edit, not committed), a `backfill` against the converted
     copy reports no new events and the same token sums. Record how many are `changed` and why (expected: branch).
   - Send one prompt with OpenCode 2 in the scratch home, `sync --no-ship`: exactly 1 new event per assistant
     message, with the right provider, model and project, and priced (`priced_by` not `none` for a priced model).
   - `doctor` with the scratch config: "opencode db", "opencode reconciliation" (both parts), "models priced", "price
     table" and "price table freshness" (from the catalogue) pass.
3. **On each device after it moves:** `doctor` passes; the dashboard shows new OpenCode events from that device with
   models and projects as before the move.
4. **Sandbox homes:** after a sandbox moves, `doctor`'s "extra homes" lists its OpenCode events and `sync` ships them.

## Out of scope

- **An OpenCode 2 plugin.** None exists here. If an event-driven sync is ever added (plan 001's optional idea), it
  must use 2.x's plugin shape (a directory whose module default-exports `{ id, setup(ctx) }`, subscribing through
  `ctx.event.subscribe({ types })`) and `session.execution.succeeded` / `session.execution.failed`, not
  `session.idle`.
- **OpenCode dropping the 1.x tables** in a later version. The v2 part would then read the converted messages. With
  the session ids preserved they upsert onto the same events, but their `git_branch` would be overwritten with null
  and each would be appended to the archive again as `changed`. 2.4.2 keeps the tables. Revisit when a release notes
  their removal.
- **Storing `variant`.** It has no column. Add one only if it turns out to change what a request costs.
- **Branch for 2.x sessions.** OpenCode 2 does not record one, and this plan does not derive one from the directory.
