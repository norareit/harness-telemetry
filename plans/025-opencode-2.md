# Plan 025 — Read OpenCode 2 databases

Type: **task**
Status: **planned** (2026-11-27). Not implemented. The facts under "Findings" were checked on the desktop client: the
schema against a backup copy of its 1.19.6 database, converted by OpenCode 2.4.2 in a scratch home, and the price
catalogue in a second scratch home after a login.

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
10. **The catalogue is written at login, in a new cost schema.** Checked in a second, empty scratch home where the
    maintainer logged in with `auth login`. Until the login, `session list` and `models` wrote no catalogue. The login
    wrote two `kv` rows:
    - `models-dev:v3:catalog`, 13.7 MB: `{"updatedAt": <epoch ms, number>, "digest": <hex>, "body": <string>}`.
      `body` is a JSON **string** (12.1 MB) that decodes to `{ <providerId>: { id, name, doc, env, models: {
      <modelKey>: { id, …, limit, cost } } } }`. That is the `models.json` layout, 331 providers against 326, with
      10,015 models that have a `cost` and 289 that do not.
    - `models-dev:v3:catalog:meta`, 191 bytes: `{updatedAt, digest, etag}`. The same `updatedAt` as the main row.
11. **`cost` is not in the `models.json` shape.** In `models.json` it is flat (`input`, `output`, `cache_read`,
    `cache_write`, `tiers`, `context_over_200k`). In the catalogue it is nested:

    ```json
    {"text":{"input":{"price":2,"cache":{"read":0.1,"write":{"30m":2.5,"12h":5}},
                      "overrides":[{"when":{"context":{"gt":272000}},"price":4,
                                    "cache":{"read":0.2,"write":{"30m":5,"12h":10}}}]},
             "output":{"price":10,"overrides":[{"when":{"context":{"gt":272000}},"price":15}]}},
     "web_search":{"price":10},
     "multipliers":[{"when":{"service_tier":{"equals":"priority"}},"factor":{"text":2}}, …]}
    ```

    (`openai/gpt-6.2-sol`, abridged.) Of the 9,769 entries in both files, none that has a `cost` has the same one in
    both. The 254 identical ones have no `cost` in either. Read as it is, the catalogue would price **nothing**. The variants, counted over all 10,015 costs:
    - `text.input.cache.write` is a number (1,785 entries) or an object keyed by TTL (1,056): `5m`/`1h` (Anthropic
      and others) or `30m`/`12h` (OpenAI). In 35 entries the cache rates sit under `cache.explicit.{read,write}`
      instead, and `models.json` took its `cache_write` from `explicit.write` there.
    - Context tiers are `overrides` whose `when` is `{context: {gt: N}}` (or `gte`, 107 entries). An override may
      leave out `price` and give only a cache rate. Other `when` keys (`service_tier`, `utc_hours`, `utc_days`,
      `region`, `date`, `thinking`, …) do not occur in `models.json` at all.
    - `multipliers` (590 entries: service tier, region, time of day), `web_search`, `image`, `audio` and `video`
      have no counterpart in `models.json`.
    - `text.output.reasoning` (220 entries) is a reasoning rate. `models.json` has a `reasoning` field too (194
      entries), and `pricing.js` ignores it: reasoning bills at the output rate (plan 002).
12. **A conversion reproduces `models.json` exactly.** A prototype applying the rules of change 2 to every catalogue
    `cost`, compared with `models.json` (the client's copy, written by 1.19.6 that day), gives identical base rates for
    all 9,420 models priced in both, and identical tiers for 9,418. The other two (`amazon-bedrock/openai.gpt-5.4`
    and `openai.gpt-5.5`) gain a 272k tier that only the catalogue lists. Every model the client's history uses
    (gpt-6.2-sol, gpt-6.1-sol, gpt-6-sol, gpt-5.6-sol, gpt-5.6-terra, gpt-6-astra, gpt-6-luna, gpt-5.4, gpt-5.4-mini,
    big-pickle, claude-opus-5, claude-sonnet-5, and the `openrouter/anthropic/claude-sonnet-5` scenario) converts to
    the same card. The models that need overrides today (`gpt-5.6-terra-fast`, `gpt-6.1-sol-fast`,
    `gpt-6.2-sol-fast`) have no `openai` entry in the catalogue either, so plans 022 and 023 stay as they are. The
    Anthropic 1-hour write rate in the catalogue is twice the input rate (claude-opus-5 10 against 5, claude-sonnet-5
    4 against 2), which is the rule `pricing.js` already applies.

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
  `~/.local/share/opencode/opencode.db`, opened read-only. It is the row `key = 'models-dev:v3:catalog'` of `kv`,
  dated by its `updatedAt` (epoch ms, finding 10). Its `body` is decoded with `JSON.parse`, and each entry's `cost`
  is converted to the `models.json` shape (below). Every other field of an entry is left as it is; `pricing.js`
  reads only `cost`.

**Converting a catalogue `cost`** to `models.json`'s flat shape. These rules reproduce `models.json` for 9,418 of
the 9,420 models priced in both (finding 12):

- `input` = `text.input.price`, `output` = `text.output.price`. Without both, the entry gets no `cost`, so it is a
  table miss, as an entry without `cost` is today.
- `cache_read` = `text.input.cache.read`, else `text.input.cache.explicit.read`.
- `cache_write` = `text.input.cache.write` when it is a number. When it is an object, the shortest TTL it lists, in
  the order `5m`, `30m`, `1h`, `12h`. Without `write`, `text.input.cache.explicit.write`, treated the same way.
  The field is left out when there is none, which keeps the cache fallbacks of plan 002.
- `tiers`: one per distinct `N` among the `overrides` of `text.input` and `text.output` whose `when` has exactly
  one key, `context`, with `gt: N` or `gte: N`. Its rates follow the base rules, applied to the override, and a
  rate the override leaves out is the base rate. The shape is `{input, output, cache_read?, cache_write?, tier:
  {type: "context", size: N}}`, sorted by size. `gte` is treated as `gt`, a difference of one token.
- Ignored: overrides with any other condition, `multipliers`, `web_search`, `image`, `audio`, `video`,
  `text.output.reasoning` and `cache.storage`. None of them has a counterpart in `models.json`, and the events carry
  no service tier, region or modality to apply them to.

A cost that is not an object, or a rate that is not a finite number, makes that one entry a miss. It does not make the
table fail to load. Converting takes the 12 MB `body` once per `loadPricing`, and `models.json` is parsed at a
similar size today.

A source that is missing or unreadable is ignored when the other one loads. When neither loads, `tableError` is set,
as today. `meta` records which source won, its path (for the database
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
2. `agent/src/pricing.js`: the catalogue source, the conversion of its `cost` (an exported `fromCatalogCost`), and
   the fresher-wins rule, with `meta.source` and `meta.updatedAt`. Rewrite the header comment that calls
   `models.json` the source of truth, and say there why the conversion ignores multipliers.
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
   - `pricing.test.js`: the catalogue loads from a `kv` fixture whose `body` is a JSON string, and the fresher
     source wins either way round. A missing row, or a `body` that does not parse, falls back to `models.json`.
     Neither → `tableError`.
   - `fromCatalogCost`, one case per rule, built from the entries quoted in findings 11 and 12: a numeric write
     (`opencode/big-pickle`), TTL writes `5m`/`1h` (`anthropic/claude-opus-5`, giving 6.25) and `30m`/`12h`
     (`openai/gpt-6.2-sol`, giving 2.5, with its 272k tier), `explicit` cache rates (`alibaba-cn/glm-5.1`, tier
     included), an override with only a cache rate (`nodecode/nodecode-cyber-v1`: the tier keeps input 0.33 and
     output 1.32), a `service_tier` override and a multiplier that are both ignored, and an entry without
     `text.output.price`, which is a miss. Each expected value is the `models.json` cost quoted in the finding.
     Then a card made from a converted cost prices an event exactly like the flat one (`price` on both).
   - `doctor.test.js`: "opencode db" (with the conversion phase), "opencode reconciliation" and "extra homes" on
     v2-only and mixed databases, and "price table freshness" dated from the catalogue.
   - `npm test` in `agent/`, also as `HOME=$(mktemp -d) npm test`.
7. This plan: the `Status:` line with what was verified.

## Order of moving

The agent change ships **before, or together with**, each move to OpenCode 2. The agent does not need the move to
have happened, so it can ship early. Moving first breaks `sync` on that device as soon as conversion starts
(finding 8), and a moved sandbox home drops out of the extra homes.

1. Implement, and verify on copies (steps 1 and 2 below), while OpenCode 1 still runs everywhere.
2. Update the agent on every device that runs it, still on OpenCode 1. On each: `doctor` passes, and a `sync`
   reports 0 `changed` events, so the v1 path is unchanged.
3. Move a device to OpenCode 2 only after step 2 on that device. The same holds for the sandboxes, because the
   device's agent reads their homes. Once the device has the updated agent,
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
