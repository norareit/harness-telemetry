# Plan 025 — Read OpenCode 2 databases

Type: **task**
Status: **planned** (2026-11-27). Not implemented. The schema facts below were checked on the desktop client against
a backup copy of its 1.19.6 database, converted by OpenCode 2.4.2 in a scratch home (see "Findings").

Builds on 001–024, chiefly 004 (pricing frozen at ingest), 008 (project root) and 018 (extra homes).

## Feature

OpenCode 2 (npm `@opencode/cli`, 2.4.2) replaces OpenCode 1 on the devices and in the container sandboxes that plan
018 reads as extra homes. It keeps the database path (`~/.local/share/opencode/opencode.db`) but changes the schema,
and the OpenCode source in this agent can read only the old one. This plan makes the agent read both schemas, and
any mix of them, for as long as devices and homes still run or hold OpenCode 1 data. It also covers the price table,
which OpenCode 2 no longer writes to `~/.cache/opencode/models.json`.

No Postgres schema change, no change to the event shape, no repricing. Every event from an OpenCode 2 database is
priced once at ingest, as today.

## Findings

### Reported by the maintainer (2.4.2)

- New messages go only to `session_message`; the role is its `type` column. Assistant `data` keeps `tokens`,
  `agent` and `time.completed`; the model is `data.model.{providerID, id, variant}`.
- Sessions are in `session_v2`, with the same `tokens_*` rollup columns as `session`.
- A database created by OpenCode 2 has no `message` or `session` table.
- A 1.x database is converted in the background, in batches, while OpenCode 2 runs. The old `message`, `session`
  and `part` tables stay untouched.
- `~/.cache/opencode/models.json` is no longer written. The catalogue is in `opencode.db`, table `kv`, key
  `models-dev:v3:catalog`, a JSON value with `updatedAt`, `digest` and `body`.
- Logins moved from `auth.json` to the `credential` table, so a copy of a home carries them.
- There is no `session.idle` plugin event, and a 1.x plugin is not loaded (see "Out of scope").

### Checked on a converted copy (2026-11-27)

Method: an SQLite backup of the client's live 1.19.6 database (373 sessions, 9,229 messages, 8,403 of them
assistant messages) went into a scratch home. OpenCode 2.4.2 ran there, `--standalone`, with `HOME` and all `XDG_*`
variables pointing into that home, until `kv` held `migration.v1-v2 = {"phase":"completed"}`. All queries were
read-only. The scripts are not kept. The figures are:

1. **1.19.6 already has a `session_message` table.** It is empty and its foreign key points at `session`. Every
   OpenCode database on the client has it (the device's own, and all twelve sandbox and backlog homes). So the test
   for "2.x" must be **`session_v2`**, not `session_message`. After conversion, `session_message` has been recreated
   with its foreign key on `session_v2`.
2. **The ids are kept.** All 373 `session_v2` ids are `session` ids. Each converted assistant message keeps its id,
   `session_id`, `time_updated`, directory and `parent_id` (0 differences).
3. **Provider, model and agent are kept.** For all 8,387 converted assistant messages, `data.model.providerID` and
   `data.model.id` equal the old `providerID` and `modelID`, and the agent is unchanged. The `-fast` ids of plans 022
   and 023 stay ids (`gpt-6.1-sol-fast`, `gpt-6.2-sol-fast`). The effort goes into `variant` (`default`, `low`,
   `medium`, `high`, `xhigh`, `max`) and leaves the model id alone. Converted `data` has no `role` key.
4. **The token values are kept, but the JSON is not identical.** v2 drops `tokens.total`. Every counter matches.
5. **`time.completed` moves by 1 ms** in 3,322 of the converted assistant messages (rounding). `ts` is an event
   field, so the same message read from v2 would differ from the stored event.
6. **Compaction usage is lost in v2.** 16 converted assistant messages are not assistant rows in v2. They were 1.x
   compaction summaries (`agent`/`mode` = `compaction`, real calls on `gpt-5.6-terra-fast`, about 1.03M tokens). In
   v2 they are `type = 'compaction'` rows whose `data` holds only `status`, `reason`, `summary`, `metadata` and
   `time`: no tokens and no model. They are in 11 sessions. For those 11 sessions, the v2 assistant sums fall short
   of the `session_v2` rollups, so 362 of 373 sessions reconcile on v2. The rollups of `session` and `session_v2` are
   equal for all 373.
7. **Only assistant rows carry tokens.** Of the 9,625 converted rows (8,387 `assistant`, 797 `user`, 331 `system`,
   94 `synthetic`, 16 `compaction`), only assistant rows have non-zero tokens. 412 rows have ids that are not in
   `message` (331 `system` and 81 `synthetic`, all without tokens), and every v2 assistant id is also in `message`.
8. **`workspace` is replaced.** After conversion it is `workspace(id, provider, binding, created_at, last_used_at)`,
   with no `branch`. Today's query (`LEFT JOIN workspace w … w.branch`) then fails with `no such column: w.branch`.
   So the agent breaks on a **converted** database, not only on a new one. A branch was never recorded, though:
   every OpenCode database on the client has 0 workspaces and 0 sessions with a `workspace_id`, and none of the
   10,847 OpenCode events in the local store has a `git_branch`.
9. **The tables are ordinary**, and the ids are primary keys: `session_v2.id`, `session_message.id`, `message.id`
   and `kv.key`. `kv` is `kv(key TEXT PRIMARY KEY, value TEXT, time_created INTEGER, time_updated INTEGER)`.
10. **The catalogue was not reproduced.** In the scratch home (no logins: `auth.json` was not copied), neither
    `session list` nor `models` wrote a `models-dev:v3:catalog` row, and `models` listed only OpenCode's free models.
    The shape of `body` and the type of `updatedAt` are **not confirmed**. See change 2.

Not checked, because it needs real 2.x sessions: whether OpenCode 2 records the usage of a **new** compaction anywhere
(an assistant row, or only the rollup). The v2 reconciliation of change 4 will show it.

## Design

### Which tables a database has

Each OpenCode database, the device's own and each home's, is classified when opened:

- **v1 part**: `message` and `session` are ordinary tables. `workspace` is no longer read (finding 8).
- **v2 part**: `session_v2` and `session_message` are ordinary tables. `session_message` alone is not enough
  (finding 1).
- A database can have both parts (converted, or being converted), one part, or neither. **Neither** means "not an
  OpenCode database", reported as today. A view or virtual table under any of these names is rejected, as today.

### Reading both parts without double counting

Each part is read with its own watermark:

- **v1 part:** today's query without the `workspace` join, with today's watermark keys
  (`watermark:opencode:time_updated`, and `…:<path>` for a home). A device that upgrades the agent re-reads nothing.
  `git_branch` is null, as it already is for every stored OpenCode event (finding 8).
- **v2 part:** `session_message` joined to `session_v2`, `type = 'assistant'`, `time_updated >= ?`, with new keys
  `watermark:opencode-v2:time_updated` and `…:<path>`. `resetCursors` deletes every `watermark:%`, so `backfill`
  resets both.
- **A v2 row whose id is also in `message` is skipped** (`NOT EXISTS (SELECT 1 FROM message WHERE id = sm.id)`, when
  there is a v1 part). Converted messages are read from v1 only, for three reasons:
  - Read from v2, they would differ from the stored event (`ts` by 1 ms, finding 5). `record()` would report them
    `changed`, and the archive would get a second line for each of 3,322 messages.
  - The compaction calls exist only in v1 (finding 6). Without v1 they would be missing, not doubled.
  - Conversion writes rows with old `time_updated` values, possibly below a v2 watermark that new messages have
    already moved past. Those rows are all in `message`, so skipping them loses nothing.

  Because the ids and session ids are kept (finding 2), the primary-key upsert would still catch a converted message
  that the anti-join missed. It would be counted as `changed`, never as a second event.

### A v2 message as an event

| event field     | v1                                                | v2                                       |
|-----------------|---------------------------------------------------|------------------------------------------|
| role filter     | `data.role === 'assistant'`                       | `type = 'assistant'` (in SQL)            |
| `provider`      | `data.providerID`                                 | `data.model.providerID`                  |
| `model`         | `data.modelID`                                    | `data.model.id`; `variant` not stored    |
| `agent`         | `data.agent \|\| data.mode`                       | same                                     |
| `project`       | `session.directory`, then plan 008's root rule    | `session_v2.directory`, same rule        |
| `git_branch`    | null (the `workspace` join is dropped)            | null                                     |
| `is_sidechain`  | `session.parent_id`                               | `session_v2.parent_id`                   |
| `ts`            | `time.completed`, `time.created`, `time_updated`  | same                                     |
| tokens          | `tokens.*`                                        | same (`total` absent, never read)        |

`message_id` is the row id and `session_id` the row's `session_id`, in both parts. A home's v2 rows go through the
same `typeof` guards as `HOME_MESSAGE_QUERY` (text ids, type and data, an integer `time_updated` within
`Number.MAX_SAFE_INTEGER`) and through `wellFormed`. `variant` is dropped: it does not change the model id that
pricing looks up (finding 3), and no column holds it.

### Price table

OpenCode 2 no longer writes `models.json`, but the file stays on a moved device and ages. Under plan 004 a stale
table is permanent damage, so the agent must not keep using it there.

`loadPricing` reads every source the device has and uses the **fresher** one:

- `models.json` (`pricing.modelsJson`, unchanged), dated by its mtime, as today.
- The catalogue in the device's own OpenCode database: new config key `pricing.catalogDb`, default
  `~/.local/share/opencode/opencode.db`, opened read-only. The row `key = 'models-dev:v3:catalog'` of `kv`, dated by
  `updatedAt`, or by the row's `time_updated` (epoch ms, finding 9) when `updatedAt` cannot be read as a date. The
  table is `body`, decoded from a string first if it is one.

A source that is missing, unreadable, or not in the `models.json` shape
(`{ <providerId>: { models: { <modelKey>: { cost, … } } } }`) is ignored when the other one loads. When neither
loads, `tableError` is set, as today. `meta` records which source won, its path (for the database
`<path>#kv:models-dev:v3:catalog`) and its date. doctor's "price table" and "price table freshness" checks report
that source and date, not `models.json`'s mtime. Extra homes' catalogues are not read: the price table is the
device's own.

Only that `kv` row is read. The agent never queries `credential`, or any table this plan does not name.

### Doctor

- **opencode db:** counts per part, e.g. `9229 messages / 373 sessions (1.x), 70 messages / 8 sessions (2.x)`, plus
  the conversion phase when `kv` has `migration.v1-v2` (its `phase`, as stored). It passes when at least one part is
  present.
- **opencode reconciliation:** v1 as today, over `session`. v2 only over the sessions that are **not** in `session`,
  the ones OpenCode 2 created. Converted sessions are reconciled on v1 alone: their v2 rows lack the compaction
  tokens (finding 6), but their rollups are the same in both tables. A v2 mismatch is reported like a v1 mismatch.
  It is how a new 2.x compaction would show up if its usage is not recorded on an assistant row.
- **models priced:** `listModels` returns the pairs of both parts.
- **extra homes:** `readHomeDatabase` reads both parts, so the check and extraction agree, as plan 018 requires.
- **price table** / **price table freshness:** as above.

## Changes

1. `agent/src/sources/opencode.js`
   - A classifier returning `{ v1, v2 }` (finding 1), used for the device's own database and in
     `readHomeDatabase`. For the device's own database with neither part, nothing is yielded (doctor reports it),
     where today `sync` throws. For a home with neither part, the error is "not an OpenCode database: needs message
     and session, or session_v2 and session_message, as tables".
   - Drop the `workspace` join from `MESSAGE_QUERY`, and `branch` from it and from `HOME_MESSAGE_QUERY`.
   - Add `V2_MESSAGE_QUERY` and its guarded home variant, with the anti-join when there is a v1 part.
   - Add the v2 event mapping, and leave the v1 `toEvent` otherwise unchanged.
   - Separate watermark keys for the v2 part, for the device's own database and per home path.
   - `listModels` and `reconcile` cover both parts. `reconcile` returns `{ v1, v2 }`, each `null` when that part is
     absent, with v2 limited to the sessions not in `session`. Also export a small `conversionPhase(db)` for doctor.
   - Header comment: schema notes for 1.19.6 and 2.4.2, and why converted rows are read from v1 only (findings 5, 6).
2. `agent/src/pricing.js`: the catalogue source and the fresher-wins rule, with `meta.source` and `meta.updatedAt`.
   Rewrite the header comment that calls `models.json` the source of truth. **First**, look at a real
   `models-dev:v3:catalog` row, from the maintainer's 2.4.2 test home or from the first device that moves, and record
   its `body` and `updatedAt` types here (finding 10). If `body` is not in the `models.json` shape, stop and bring it
   back to the maintainer. Without the row, `models.json` keeps working, so this does not block step 2 of "Order of
   moving". It must be settled before a device moves.
3. `agent/src/config.js`: `pricing.catalogDb` in `DEFAULTS`, and the same key in `agent/config.example.json`. Pass it
   wherever `modelsJsonPath` is passed (`sync.js`, `cli.js` twice, `doctor.js`).
4. `agent/src/doctor.js`: the checks listed under "Doctor". "price table freshness" stops calling `stat` on
   `modelsJson` and uses `pricing.meta.updatedAt`. Its advice ("run OpenCode to refresh it") stays.
5. `README.md`: the data-sources diagram and text name both schemas and both price sources. Add one sentence that a
   copy of an OpenCode 2 home holds its logins and must be kept private.
6. Tests (`agent/test/`, synthetic databases only, no home access). Fixture schemas are copied from findings 1, 8
   and 9 (the 1.19.6 database with its empty `session_message` on `session`, and the 2.4.2 tables):
   - A 1.19.6 database with an empty `session_message` is read as v1 only, exactly as today.
   - A v2-only database yields its assistant rows, with provider and model from `data.model` and `is_sidechain`
     from `parent_id`. `user`, `system`, `synthetic` and `compaction` rows are ignored. A second run yields nothing.
   - A converted database, with 2.4.2's `workspace` (no `branch`) and `ts` 1 ms off in v2, yields each converted
     message once, from v1, with v1's `ts`. A compaction message is yielded from v1. A v2-only message is yielded.
     The two watermarks move independently. A converted row added later with an old `time_updated` is not yielded.
   - The device's own v2-only database no longer makes `extractOpenCode` throw. A database with neither part yields
     nothing.
   - A home with a v2-only database is read, and `session_v2` as a view is rejected. A v2 row with a non-text id or
     an out-of-range `time_updated` is dropped and the others are kept.
   - `reconcile`: a converted session with a v2 compaction row without tokens passes on v1 and is not reconciled on
     v2; a 2.x-native session with a short assistant sum fails. `listModels` on v1-only, v2-only and mixed databases.
   - `pricing.test.js`: the catalogue loads from a `kv` fixture, and the fresher source wins either way round. A
     missing row, or a `body` that is not the expected shape, falls back to `models.json`. Neither → `tableError`.
   - `doctor.test.js`: "opencode db" (with the conversion phase), "opencode reconciliation" and "extra homes" on
     v2-only and mixed databases, and "price table freshness" dated from the catalogue.
   - `npm test` in `agent/`, also as `HOME=$(mktemp -d) npm test`.
7. This plan: the catalogue facts (change 2), then the `Status:` line with what was verified.

## Order of moving

The agent change ships **before, or together with**, each move to OpenCode 2. The agent does not need the move to
have happened, so it can ship early. Moving first breaks `sync` on that device as soon as conversion starts
(finding 8), and a moved sandbox home drops out of the extra homes.

1. Implement, and verify on copies (steps 1 and 2 below), while OpenCode 1 still runs everywhere.
2. Update the agent on every device that runs it, still on OpenCode 1. On each: `doctor` passes, and a `sync`
   reports 0 `changed` events, so the v1 path is unchanged.
3. Move a device to OpenCode 2 only after step 2 on that device, and after change 2 has its catalogue facts. The same
   holds for the sandboxes, because the device's agent reads their homes. Once the device has the updated agent,
   sandboxes and device can move in either order.
4. After each move: step 3 of "Verification".
5. Keep reading both schemas. Dropping v1 support needs its own plan, once no device or home holds a 1.x-only
   database.

## Verification

Against **copies** only, never a live database. Copy with SQLite's backup (`node:sqlite`'s `backup()`, or
`sqlite3 <db> ".backup <copy>"`), not `cp`, so a running OpenCode's WAL is included. The client's database is about
2.8 GB. Run OpenCode 2 in a scratch home with `--standalone` (otherwise it starts a background service), and with
`HOME` and every `XDG_*_HOME` pointing into that home. Use a scratch agent config and data directory, with
`--no-ship`. A copy of a 2.x home holds credentials: keep it in a directory only the user can read, and delete it
afterwards.

1. **Before conversion:** on a backup copy of a 1.x database, `sync --no-ship`, and note the event count.
2. **Through conversion,** on the same copy:
   - Run OpenCode 2 once (`--standalone session list` converted 8 of 373 sessions in one run), then
     `sync --no-ship`: 0 new and 0 changed.
   - Repeat until `migration.v1-v2` is `completed`, then `sync --no-ship`: 0 new and 0 changed. Then `backfill`:
     0 changed, and the same event count and token sums as step 1.
   - `doctor` with the scratch config passes "opencode db" (both parts, phase `completed`), "opencode reconciliation"
     (v1 373/373, v2 0 sessions) and "models priced".
3. **On each device after it moves:** `doctor` passes, including "price table freshness" from the catalogue. The
   dashboard shows new OpenCode events from that device, with models and projects as before. After the first 2.x
   session that compacts, "opencode reconciliation" still passes. If it fails, OpenCode 2 does not record compaction
   usage on an assistant row, and that needs its own plan.
4. **Sandbox homes:** after a sandbox moves, doctor's "extra homes" lists its OpenCode events, and `sync` ships them.

## Out of scope

- **An OpenCode 2 plugin.** This repository has none (plan 001 mentioned a `session.idle` sync as an option that was
  never built). If one is ever added, it must use 2.x's plugin shape (a directory whose module default-exports
  `{ id, setup(ctx) }`, subscribing through `ctx.event.subscribe({ types })`) and the events
  `session.execution.succeeded` / `session.execution.failed`.
- **OpenCode dropping the 1.x tables** in a later version. The v2 part would then read the converted messages. They
  would upsert onto the same events (finding 2), but as `changed` (finding 5), and the converted compaction calls
  would have no usage left to read (finding 6). 2.4.2 keeps the tables. Revisit when a release notes their removal.
- **Storing `variant`.** It does not change the model id (finding 3) and has no column. Add one only if it turns out
  to change what a request costs.
- **A branch for OpenCode events.** None has ever been recorded (finding 8), and 2.x has nothing to read one from.
