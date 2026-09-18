# harness-telemetry

Per-session token usage and (potential) cost for **Claude Code** and **OpenCode**,
across every device, on one Grafana dashboard — while keeping a readable, parseable
copy of the data on each device.

Local-first: a short-lived per-device agent reads each harness's own on-disk state,
normalizes it, writes a local JSONL archive, and upserts to Postgres on the Pi over
Tailscale. Grafana queries Postgres. Extraction and shipping are independent — the
archive is written even with no network, and a backlog drains on the next run.

```
                 ┌──────────── desktop / laptop ────────────┐
  ~/.claude/projects/**/*.jsonl ─┐                             │
  ~/.local/share/opencode.db  ───┤─▶ harness-usage (agent) ────┼─▶ ~/.local/share/harness-usage/
  ~/.cache/opencode/models.json ─┘         │  every 5 min      │       events/YYYY-MM-DD.jsonl
                                           │                   │       state.sqlite (cursors + outbox)
                                           ▼                   │
                              Postgres 17 on rpi5         ◀────┘   (Tailscale, idempotent upsert)
                                           ▼
                                   Grafana dashboard
```

## Layout

| Path | What |
|---|---|
| `agent/` | the per-device sync agent (Node ≥22.13, one dependency: `pg`) |
| `agent/scripts/` | one-off repairs for already-recorded state — see its README |
| `server/` | `docker compose` stack for the Pi: Postgres + Grafana, provisioned |
| `agent/test/` | `node --test` suite: `npm test` (no dependency, no network, no home access) |
| `plans/` | the design and the research behind it — 001 (pipeline) → 006 (structure), each self-contained |

---

## How it works

The agent is a **normalizer**. Each harness records usage in its own shape; `harness-usage`
converts both into one canonical row, prices it, and stores it in three places: a JSONL
archive, a local SQLite outbox, and Postgres.

### Raw → canonical: three transformations

Most fields are a straight rename (`cwd` → `project`, `gitBranch` → `git_branch`,
`requestId` → `message_id`). Only three things actually change:

1. **Reasoning is split out of output.** Claude Code reports `output_tokens: 1514` with
   `thinking_tokens: 292`; the canonical row stores `output_tokens: 1222` +
   `reasoning_tokens: 292`. Same total — separated because OpenCode reports reasoning as a
   *separate* counter while Anthropic folds it in. Normalizing here means one costing rule
   works for both, and the cost is unchanged (both are billed at the output rate).
2. **Cache-creation is split by TTL.** `cache_creation_input_tokens` becomes
   `cache_write_5m_tokens` / `cache_write_1h_tokens`, because Anthropic's 1-hour writes
   cost `2 × input` while the table only carries the 5-minute rate.
3. **Deduplication.** Claude Code writes one JSONL line *per content block*, each repeating
   identical usage. The agent keeps one row per `requestId`. Without this, totals overcount
   by roughly 2.3×.

### Where cost is computed

**`pricing.js`, in `computeCost()` — the only place, ever.** No SQL computes cost; Postgres
only sums a finished `cost_usd`. A worked example, `claude-fable-5-1`:

```
    32 × $10      input                        =      320
  1514 × $50      output + reasoning           =   75,700
104645 × $0.25    cache read                   =   26,161.25
   727 × $20      cache write 1h (= 2 × input) =   14,540
                                                 ─────────
                                         ÷ 1e6 =  $0.116721
```

The `rate_*` columns store exactly those multipliers, so any row can be re-derived from
itself — that is what `usage_cost_audit` checks.

### Is the JSONL line the Postgres row?

Yes. `record()` builds one JSON string and writes it to *both* the archive and the outbox;
shipping parses that same string, and `COLUMNS = FIELD_ORDER`, so every field is a column
in the same order. Postgres adds one thing of its own: `synced_at`.

### How the modules relate

```
cli.js ──▶ sync.js ──┬──▶ sources/claude-code.js ─┐
                     │    sources/opencode.js  ───┴──▶ raw events
                     ├──▶ pricing.js        cost is computed HERE
                     ├──▶ valuation.js      freeze/reprice policy (what a row's cost SHOULD be)
                     ├──▶ record.js         canonical shape (FIELD_ORDER)
                     ├──▶ counterfactual.js scenario costs + `compare`
                     ├──▶ archive.js        the JSONL file format + hash rule
                     ├──▶ local-store.js    state.sqlite (outbox, cursors) + owns an Archive
                     └──▶ sink-postgres.js  idempotent upsert
```

`config.js` feeds all of them; `doctor.js` re-reads the same modules — importing the
sources' own parsers rather than re-implementing them. `valuation.js` is the single place
that decides whether a stored cost may be reused (ingest freeze) or must move (`reprice`);
after plan 006 the word "reprice" means exactly one thing in the tree — the escape-hatch
command — while the counterfactual code lives in `counterfactual.js`.

### Why counterfactuals are not in the JSONL

Because they are **derived, not observed**. The archive exists for one job: preserving
token counts past Claude Code's ~30-day prune. Token counts are facts from the harness;
scenario costs are recomputable from those facts plus a price table. Archiving them would
add bulk and, worse, churn — every price change would append a duplicate line per event.

Scenario rows live in `outbox_scenario` (state.sqlite) and ship to `usage_scenario` in
Postgres, joined back on `(harness, session_id, message_id)`. One event therefore has one
archive line and *N* scenario rows — same tokens, N different rate cards.

### Inspecting the local store

```sh
harness-usage show          # the readable summary

# raw archive — one JSON object per line, but read it LAST-WINS per event
jq -s 'group_by(.harness + .session_id + .message_id) | map(last)
       | map(.cost_usd) | add' ~/.local/share/harness-usage/events/*.jsonl

# state.sqlite — no sqlite3 binary needed, node:sqlite is built in.
# A quoted heredoc, not -e '...': the SQL needs single quotes around '$.model'
# (SQLite reads double quotes as an identifier), which would close an outer -e '...'.
node --no-warnings - <<'EOF'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(
  process.env.HOME + "/.local/share/harness-usage/state.sqlite",
  { readOnly: true },
);
console.table(
  db.prepare(`SELECT json_extract(payload, '$.model')                     AS model,
                     COUNT(*)                                             AS n,
                     ROUND(SUM(json_extract(payload, '$.cost_usd')), 4)   AS cost
              FROM outbox GROUP BY 1 ORDER BY cost DESC`).all(),
);
db.close();
EOF
```

Always open it `{readOnly: true}` — the timer may be mid-sync, and SQLite readers never
block the writer.

| table | what |
|---|---|
| `outbox` | one row per event, `payload` = the canonical JSON, `synced` = shipped yet |
| `outbox_scenario` | one row per (event, scenario) counterfactual |
| `cc_cursor` | per-transcript `(inode, byte offset)` resume points |
| `kv` | the OpenCode `time_updated` watermark |
| `archived` | hash per event deciding whether a JSONL line needs appending |

---

## Agent

### Install on a device

```sh
cd agent
npm install                              # pulls `pg`; SQLite is built into Node
ln -s "$PWD/bin/harness-usage" ~/.local/bin/harness-usage   # or anywhere on PATH

mkdir -p ~/.config/harness-usage
cp config.example.json ~/.config/harness-usage/config.json
$EDITOR ~/.config/harness-usage/config.json   # set device name + Postgres DSN
```

**Set `device` before the first sync.** It defaults to the hostname, but a
config copied from another machine keeps that machine's name, and every row
ships under it — `agent/scripts/retag-device.mjs` exists to clean that up.

`bin/harness-usage` is a POSIX-sh wrapper that resolves `node` at run time (PATH,
then `nvm.sh`, then the newest `~/.nvm/.../node`), skipping any candidate whose
`node:sqlite` is missing — that needs Node ≥22.13, and an older one fails at
import with `ERR_UNKNOWN_BUILTIN_MODULE` before the agent can explain itself.
**Always invoke the wrapper**, never `node src/cli.js` directly — systemd and
launchd do not get an nvm `node` on their `PATH`, and a version-pinned nvm path
breaks on the next `nvm install`.

### Commands

```sh
harness-usage sync        # incremental: extract → local archive → Postgres upsert
harness-usage backfill    # ignore cursors, re-scan everything, drain the outbox
harness-usage show        # local summary: totals, per-model cost, unsynced backlog
harness-usage doctor      # preflight + regression checks (see below)

harness-usage sync --no-ship   # write the local archive only, skip Postgres

npm test                   # the unit suite (node:test; no deps, no network, no ~ access)
```

`npm test` checks the code before it lands; `doctor` checks this machine's live
data. They are complements, not substitutes — keep both.

### Counterfactual repricing

`compare` answers "what would this exact token stream have cost somewhere else?"
It works against **any** model in the price table (~7,600), not just the configured
scenarios:

```sh
harness-usage compare --as openrouter/qwen/qwen3.7-flash
harness-usage compare --as openrouter/anthropic/claude-sonnet-5 \
                      --as tokengo/z-ai/glm-5.2 --group project
harness-usage compare --only-local --as openrouter/qwen/qwen3.5-9b   # what Ollama saves
```

`--group` takes `project`, `model`, `agent`, `day`, `harness` or `device`.

**Always read the `cache` column.** A target marked `none` has no prompt caching, so
its cache-read tokens are billed at the full input rate. On this workload — which is
overwhelmingly cache reads — that matters far more than the headline per-token price,
and a "cheap" model without caching can easily cost more than an expensive one with it.

Repriced figures are **estimates**: token counts are not portable across tokenizers,
so treat them as "2x or 20x", not as a budget.

The `scenarios` list in `config.json` is the subset materialized into Postgres for the
dashboard; set it to `[]` to skip that work entirely.

Exit codes are split between the agent and its launcher (`bin/harness-usage`) so a
launch failure can never be mistaken for a healthy run — it once was, silently, for
13 hours (plans/007):

| code | meaning | who |
|---|---|---|
| `0` | ok | agent |
| `1` | error | agent |
| `2` | usage | agent |
| `3` | extracted, shipping failed, rows queued locally | agent |
| `127` | launcher could not start the agent (e.g. no usable node) | wrapper |

The systemd unit keeps `SuccessExitStatus=0 3` (a queued-offline run is a success);
the wrapper reserves `127` and now aborts to it via an `EXIT` trap, so a launch
failure shows as `Failed`, not the whitelisted `3`.

### Scheduling

**desktop (Linux) — systemd user timer:**

```sh
mkdir -p ~/.config/systemd/user
cp agent/install/harness-usage.{service,timer} ~/.config/systemd/user/
# the unit's ExecStart assumes the repo is at ~/projects/harness-telemetry — edit if not
systemctl --user daemon-reload
systemctl --user enable --now harness-usage.timer
systemctl --user list-timers | grep harness-usage      # confirm it is armed
journalctl --user -u harness-usage -f                   # watch a run
```

`Persistent=true` catches up one missed run after boot. User timers only run while
the user has a login session (`Linger=no`) — that is fine, new data only appears while
he is logged in using the harnesses, and anything missed self-heals next run. Run
`sudo loginctl enable-linger $USER` only if headless operation is ever wanted.

**laptop (macOS) — launchd LaunchAgent:**

```sh
cp agent/install/com.ritenoar.harness-usage.plist ~/Library/LaunchAgents/
# the plist's ProgramArguments path assumes ~/projects/harness-telemetry — edit if not
launchctl load ~/Library/LaunchAgents/com.ritenoar.harness-usage.plist
launchctl start com.ritenoar.harness-usage
tail -f ~/Library/Logs/harness-usage.log
```

`StartInterval: 300` fires once on wake rather than stacking missed runs.

**Optional, opt-in: near-live sync.** A 5-minute timer means the dashboard can lag
up to 5 minutes. Claude Code's `SessionEnd` hook and OpenCode's `session.idle`
plugin event can each call `harness-usage sync` when a session ends. This adds
coupling to each harness that the base design avoids — not enabled by default.

### `doctor` checks

`doctor` runs against *this machine's live data* — it answers "is the data sane
right now", where `npm test` answers "is the code right" before it lands. Each
check is a named entry in the `doctor.js` registry; `harness-usage doctor --only
"<name>"` runs one. In order:

* **config file / device name / data dir** — where it is reading and writing
* **claude-code transcripts** — the source path resolves; file count
* **claude-code dedupe regression** — deduped vs naive output / cache-creation
  totals; the naive sum must stay ≥1.5× the deduped one (it runs ~2.2–2.3×; a
  dedupe bug collapses it to ~1.0), and 0 usage conflicts within a `requestId`
* **opencode db / opencode reconciliation** — the DB opens; per-message token
  sums match the `session` rollup columns
* **price table** — loads, model count
* **reasoning tokens billed** — 1M reasoning tokens cost the full output rate
  (the permanent guard against the reasoning-exclusion regression)
* **scenarios resolve** — every configured counterfactual target has a rate card
* **cost reproducible from stored rates** — recomputes `cost_usd` from the stored
  token counts and applied rates; drift is a corrupted write
* **price table freshness** — `models.json` newer than 14 days (stale = permanent
  mis-valuation under the freeze)
* **override drift** — each pin vs the live table, reporting pins the table can no
  longer confirm rather than passing them silently
* **no unpriced billable events** — every non-local event carries a rate card
* **models priced** — every provider/model pair in use resolves
* **postgres connection / postgres schema** — the DSN connects; `usage_event` and
  `usage_scenario` exist with no missing columns
* **last sync / last ship** — how long since the agent last ran extraction to the
  end, and last shipped with nothing left queued. Both fail past
  `sync.staleAfterMinutes` (default 60) with the `systemctl`/`journalctl` (or
  `launchctl`/log) hint; this is the check that catches a dead timer, since the
  outbox and Postgres freeze at the last good run and otherwise look healthy. "last
  ship" is skipped when no DSN is configured.
* **projects are repo roots** — every stored `project` is a repository root, a
  `.harness-split` sub-project, or a genuine non-repository; a value that resolves to a
  different root on this machine is a pre-plan-008 subdirectory, repairable with
  `reroot-project.mjs`. Skipped when `project.detectRoot` is false.

---

## Pricing

Rates come from `~/.cache/opencode/models.json` (auto-updating, covers both
harnesses). `agent/pricing-overrides.json` does two jobs: it fills table misses
(a model the table does not carry, or carries only under another provider), and
it pins a rate you want to use in place of the table's. Note it is **not** what
protects historical rows from a table update — the plan-004 freeze does that, by
valuing each row once at ingest. That makes a pin pure forward policy: it applies
to future ingests and to an explicit `reprice`, and can drift from the table
unnoticed, which is why `doctor`'s override-drift check exists. Rules, in order:

* a local provider (`ollama`, `lmstudio`, `llamacpp`, `local`) → cost `0`, `billing='local'`,
  checked *before* the table so a coincidental name match cannot attribute spend to it
* no entry otherwise → cost `0`, `priced_by='none'` (stays visibly distinct from spend)
* Anthropic **1-hour** cache write → `2 × input` rate (the table only carries the
  5-minute rate; 100% of Claude Code cache-creation is 1-hour TTL)
* OpenAI context tiers → when `input + cache_read` exceeds `tier.size` (272k), the
  tier rates apply to the whole request
* `cost = (input·in + billable_output·out + cache_read·cr + cw5m·cw + cw1h·cw1h) / 1e6`

**Reasoning tokens.** At extraction, `output_tokens` is normalized to *exclude*
reasoning for **every** harness — Claude Code subtracts `thinking_tokens`, and
OpenCode/OpenAI already report `reasoning` as a separate counter (verified against
the live DB: `total == input + output + reasoning + cache_read`). `reasoning_tokens`
is stored alongside and billed at the output rate, so billable output is uniformly
`output_tokens + reasoning_tokens`, with **no per-provider special case**.

An earlier version kept a `provider === 'anthropic'` branch here, left over from
before that normalization existed. The two were individually correct and jointly
wrong: Anthropic thinking tokens were billed at $0, understating the history by
$25.41. `usage_cost_audit` now recomputes with `(output_tokens + reasoning_tokens)`
in SQL, so the regression cannot come back unnoticed.

`billing` is `free` (subscription — Stef's Max / OpenCode auth), `api` (paid per
token), or `local` (`ollama`/`lmstudio` and friends, genuinely $0). Set per source in
`config.json`.

### Stored rates and the cost audit

Every row also stores the rate card that was **actually applied** — `rate_input`,
`rate_output`, `rate_cache_read`, `rate_cache_write_5m`, `rate_cache_write_1h`, plus
`cache_model` and `tier_applied`. These are post-tier-selection and post-fallback, so
they can differ from `models.json` as written: a model with no `cache_read` has its
cache reads billed at the input rate, and Anthropic 1h writes are `2 × input`.

That makes `cost_usd` reproducible from stored data alone:

```sql
SELECT count(*) FROM usage_cost_audit WHERE abs(drift_usd) > 0.000001;  -- expect 0
```

This is the only invariant in the system checkable **without trusting the agent that
produced the number**. It also permanently guards the reasoning-token regression, since
the view recomputes with `(output_tokens + reasoning_tokens)`.

Rates are nullable on purpose: a row priced with no rate card has *unknown* rates, and
`0` would be a lie that silently passes the audit.

**Prices are frozen at ingest.** An event is costed once, when it is first extracted, and
never recomputed. Postgres is a **ledger of what each request would have cost when it
happened** — a vendor changing its prices does not rewrite your history.

`priced_at` records when each valuation was made. For a normally-ingested event it lands
close to `ts`; `NULL` means the row was valued before this rule existed and the date is
not recoverable. A scenario added long after the fact carries a `priced_at` far later than
its event's `ts`, which is the visible marker that the counterfactual could **not** use
contemporaneous rates — no archive of past rate tables exists to price it against.

*"What would this cost at today's rates"* is still answerable, on demand and without
mutating anything, via `harness-usage compare`.

Deliberate correction — after fixing a pricing bug or adding an override — is explicit:

```sh
harness-usage reprice --dry-run                  # what would change, writes nothing
harness-usage reprice --unpriced-only            # events that never got a rate card
harness-usage reprice --model openai/gpt-5.6-terra-fast
harness-usage reprice --scenario openrouter/qwen/qwen3.7-flash   # drop + recompute
```

Because frozen costs do not self-heal, `doctor` now watches the two things that would
otherwise rot silently: the age of `models.json` (which OpenCode maintains, not this repo)
and any pinned override that has diverged from the live table.

---

## Pi stack (you deploy this)

On `rpi5`, with Docker + compose installed:

```sh
cd server
cp .env.example .env
$EDITOR .env        # set POSTGRES_PASSWORD, GRAFANA_ADMIN_PASSWORD;
                    # TAILSCALE_IP defaults to rpi5's 100.x.y.z (`tailscale ip -4`)
docker compose up -d
docker compose ps
docker compose logs -f grafana
```

* `postgres:17-alpine` — schema in `postgres/init/01-schema.sql` is applied on first
  boot (fresh volume only). Session / day / project rollups are **views**.
* **Schema changes to an existing database** go in `postgres/migrations/`, because
  `postgres/init/` only ever runs against an empty data directory. `harness-usage doctor`
  reports missing tables *and* missing columns, and points here. Apply with:

  ```sh
  docker compose exec -T postgres psql -U harness -d harness \
    < postgres/migrations/001-add-rates.sql
  ```

  Migrations are idempotent and non-destructive. Reach for `down -v` only when you
  actually intend to destroy stored history.
* `grafana/grafana:11.4.0` — datasource and the `harness-usage` dashboard are
  provisioned from `grafana/provisioning/`, so it comes up populated. The top row's
  **Minutes since last ship, per device** stat (green/orange/red on 30/180 min)
  ignores the time range and `$device` so a silent device stays visible; it is the
  glanceable companion to `doctor`'s authoritative `last sync`/`last ship` checks.
* Both ports are published on `${TAILSCALE_IP}` only — not the LAN, not the
  internet. Open `http://rpi5:3000` from any tailnet device.

Verify the binding is tailnet-only:

```sh
ss -tlnp | grep -E ':3000|:5432'          # should show 100.x.y.z, not 0.0.0.0
curl -sS --max-time 3 http://<pi-LAN-ip>:3000 && echo REACHABLE || echo "blocked (good)"
```

### Point an agent at it

In `~/.config/harness-usage/config.json`:

```json
"postgres": { "dsn": "postgres://harness:THE_PASSWORD@100.x.y.z:5432/harness" }
```

then `harness-usage doctor` and `harness-usage backfill`.

---

## Data model

One fact row per LLM API response, PK `(harness, session_id, message_id)` — so
re-syncing and overlapping runs are idempotent. For Claude Code `message_id` is the
API `requestId` (the dedupe key: Claude Code repeats `message.usage` on every
content-block record; summing naively overcounts output ~127% and cache-creation
~121%). For OpenCode it is the message row id (no dedupe needed).

```
harness device session_id message_id ts
provider model agent project git_branch is_sidechain
input_tokens output_tokens reasoning_tokens cache_read_tokens
cache_write_5m_tokens cache_write_1h_tokens
cost_usd  billing('api'|'local'|'free')  priced_by('table'|'override'|'none')
```

`project` is **the repository root** the work belongs to: at extraction each
event's working directory is resolved to its nearest `.git` ancestor (a directory
or a file, so worktrees and submodules count), so subdirectories of one repo no
longer split into separate "projects" on the dashboard. A working directory with
no `.git` above it (or whose path is gone) keeps its raw value, and a `.git` at or
above `$HOME` is ignored so a dotfiles repo cannot swallow everything into `~`. Set
`"project": { "detectRoot": false }` in `config.json` to store the raw working
directory instead (pre-plan-008 behaviour). Events recorded before this was
introduced keep their old subdirectory value until repaired in place with
`node agent/scripts/reroot-project.mjs` (run per device — it walks that machine's
filesystem; `doctor`'s "projects are repo roots" check flags what still needs it).

#### Splitting one repo into several projects — `.harness-split`

Sometimes one git repo is, in your head, several projects — a `janestreet/` repo
that holds `archmadness`, `pentupfrustration`, `hint-singles` as distinct things.
By default all of those collapse into `janestreet`. To keep them separate **without
splitting the repo**, drop an empty marker file named **`.harness-split`** in the
container directory:

```sh
touch ~/projects/janestreet/.harness-split   # content is ignored; a comment is nice
```

Now each **immediate child** of `~/projects/janestreet` (`archmadness`,
`pentupfrustration`, …) becomes its own `project`, while:

- work at `janestreet`'s own top level still resolves to `janestreet` (the repo root);
- every *other* repo still collapses to its root as usual;
- the marker lives in the repo, so it is identical on every device — no per-device config.

The fine print, because this is finicky:

- **Presence is the whole signal.** An empty file is enough; its contents are never read.
- **One level only.** It splits the container's *immediate* children, not grandchildren.
  A path deeper inside a child (`archmadness/puzzles/x`) still resolves to `archmadness`.
- **It beats the repo's `.git`** for paths inside a child (the marker sits one level above
  the children, so the walk reaches it first), which is why the sub-projects win.
- **It only takes effect at extraction time**, on the machine that has the files — and
  `reroot-project.mjs` honours it too, so **create the marker _before_ you run the repair**,
  or the old rows will collapse to the repo root instead of staying split. Adding the marker
  later means re-running the repair.
- **Ignored at or above `$HOME`**, same as `.git`.

Local readable copy: `~/.local/share/harness-usage/events/YYYY-MM-DD.jsonl`, one
object per line. `state.sqlite` alongside holds the sync cursors and the unsynced
outbox. Claude Code prunes its own transcripts after ~30 days, so the JSONL archive
is the only durable history past that window — which is why extraction runs and
archives regardless of whether the Pi is reachable.

If `state.sqlite` is ever lost, recovery is two steps, in this order:

```sh
harness-usage restore-archive   # JSONL archive -> outbox (all durable history)
harness-usage sync              # ship it, then pick up anything newer
```

`restore-archive` reads the archive last-wins per event and inserts only what the
outbox is missing, so it never overwrites live state with an archived line whose
cost fields are as-of-first-archival. **`backfill` alone is not enough** — it only
re-reads the harnesses' own files, and Claude Code has pruned anything past ~30
days.

### Reading the archive correctly

The archive is **append-only, and a line can be superseded**. Read it *last-wins per
`(harness, session_id, message_id)`* — never as a naive sum:

```sh
# WRONG — double-counts superseded lines
jq -s 'map(.cost_usd) | add' events/*.jsonl

# right — last line per event wins
jq -s 'group_by(.harness + .session_id + .message_id)
       | map(last) | map(.cost_usd) | add' events/*.jsonl
```

Postgres is unaffected either way: `sink-postgres.js` upserts on the same key, so
superseded lines collapse onto one row.

A line is appended only when the **extracted** data is new or changed — never for a
reprice, since costs are derived and recomputable. Under the plan-004 freeze the
archive's cost and Postgres therefore agree for every row **except one repriced
since it was first archived**: `reprice` re-values the outbox (and Postgres) but
appends no archive line, since the token counts did not change. So the archive is
authoritative for token counts and **Postgres is authoritative for cost** — they
differ only where an explicit reprice has run.

`harness-usage compact-archive` rewrites the files keeping the last line per event, if
duplicates accumulated before this rule existed.
