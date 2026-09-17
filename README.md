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
| `plans/001-harness-usage-telemetry.md` | the design + the research it is based on |

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
                     ├──▶ pricing.js       cost is computed HERE
                     ├──▶ record.js        canonical shape (FIELD_ORDER)
                     ├──▶ reprice.js       counterfactuals + `compare`
                     ├──▶ local-store.js   JSONL archive + state.sqlite
                     └──▶ sink-postgres.js idempotent upsert
```

`config.js` feeds all of them; `doctor.js` re-reads the same modules to check them.

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

# state.sqlite — no sqlite3 binary needed, node:sqlite is built in
node --no-warnings -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.local/share/harness-usage/state.sqlite",{readOnly:true});
console.table(db.prepare(`SELECT json_extract(payload,"$.model") model,
                                 COUNT(*) n,
                                 ROUND(SUM(json_extract(payload,"$.cost_usd")),4) cost
                          FROM outbox GROUP BY 1 ORDER BY cost DESC`).all());
db.close();'
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
```

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

`sync` exits `0` on success, `3` if extraction succeeded but shipping failed
(rows are safely queued locally), `1` on a real error.

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

* both source paths resolve; history size reported
* price table loads; every provider/model pair in use resolves to a rate card
* **Claude Code dedupe regression** — recomputes deduped vs naive output /
  cache-creation totals and asserts the naive sum is still ≥1.5× the deduped one
  (it runs ~2.2–2.3×; a dedupe bug collapses it to ~1.0). Also asserts 0 usage
  conflicts within a `requestId`.
* **OpenCode reconciliation** — per-message token sums vs the `session` rollup
  columns, all sessions (invariant: 82/82 at time of writing).
* Postgres connection + `usage_event` present

---

## Pricing

Rates come from `~/.cache/opencode/models.json` (auto-updating, covers both
harnesses). `agent/pricing-overrides.json` fills table misses and pins rates so
historical rows do not silently reprice on a table update. Rules, in order:

* a local provider (`ollama`, `lmstudio`, `llamacpp`, `local`) → cost `0`, `billing='local'`,
  checked *before* the table so a coincidental name match cannot attribute spend to it
* no entry otherwise → cost `0`, `priced_by='none'` (stays visibly distinct from spend)
* Anthropic **1-hour** cache write → `2 × input` rate (the table only carries the
  5-minute rate; 100% of Claude Code cache-creation is 1-hour TTL)
* OpenAI context tiers → when `input + cache_read` exceeds `tier.size` (272k), the
  tier rates apply to the whole request
* `cost = (input·in + billable_output·out + cache_read·cr + cw5m·cw + cw1h·cw1h) / 1e6`

**Reasoning tokens.** For Anthropic they are already inside `output_tokens` and
billed at the output rate — `output_tokens` is billed as-is. For OpenCode / OpenAI
`reasoning` is a **separate** counter (verified against the live DB: `total ==
input + output + reasoning + cache_read`), billed at the output rate — so
`billable_output = output_tokens + reasoning_tokens`. The switch is on
`provider === 'anthropic'`. At extraction, `output_tokens` is normalized to
*exclude* reasoning for every harness; `reasoning_tokens` is stored alongside.

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
  provisioned from `grafana/provisioning/`, so it comes up populated.
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

Local readable copy: `~/.local/share/harness-usage/events/YYYY-MM-DD.jsonl`, one
object per line. `state.sqlite` alongside holds the sync cursors and the unsynced
outbox. Claude Code prunes its own transcripts after ~30 days, so the JSONL archive
is the only durable history past that window — which is why extraction runs and
archives regardless of whether the Pi is reachable.

If `state.sqlite` is ever lost, `harness-usage backfill` rebuilds from the
harnesses' own files (within their retention) plus the JSONL archive (beyond it).

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
reprice, since costs are derived and recomputable. The consequence is that cost fields
in an archived line are as-of-first-archival and may be stale; **Postgres is
authoritative for cost**, the archive for token counts.

`harness-usage compact-archive` rewrites the files keeping the last line per event, if
duplicates accumulated before this rule existed.
