# Harness Telemetry — per-session token & cost reporting for Claude Code + OpenCode

Status: **approved, not yet implemented.**
Research for this plan was done against the live machine on 2026-09-09; every number below was
measured, not estimated. Re-measure before trusting them if significant time has passed.

## Context

Stef runs two coding harnesses (Claude Code and OpenCode) across two machines — `desktop`
(a Linux desktop) and `laptop` (a macOS laptop) — and currently has no visibility into token
usage or what it would cost. The goal is a Grafana dashboard on the always-on Raspberry Pi
showing token usage and (potential) cost per session, per device, while **also** keeping a
readable/parseable copy of the data on each device itself.

Decisions already made with the user:

- **Local-first sync → Postgres.** A per-device agent reads each harness's own on-disk state,
  normalizes it, writes local JSONL, and upserts to Postgres on the Pi. Grafana queries Postgres.
  (Rejected alternative: native OTel push to a metrics TSDB — it starts from zero history, drops
  data whenever the laptop is off-tailnet, and handles per-session detail poorly.)
- **The user deploys the Pi stack themselves.** This repo produces the compose stack,
  provisioning and dashboards, plus the exact commands to run — do not attempt to SSH to the Pi.

## What the research established

Networking is already solved — Tailscale is up: `raspberrypi` 100.x.y.z, `desktop`
100.101.30.12, `laptop` 100.107.107.14. No port-forwarding needed, and the laptop reaches the
Pi from anywhere.

**Sources — both already on disk, so nothing needs configuring inside either harness:**

| | Claude Code 2.1.266 | OpenCode 1.18.29 |
|---|---|---|
| Store | `~/.claude/projects/**/*.jsonl` (25 files) | `~/.local/share/opencode/opencode.db` (SQLite) |
| Grain | one record per content block | one row per message |
| Usage | `message.usage` | `message.data` JSON → `tokens{}` |
| History | 4505 assistant records | 984 messages / 82 sessions |

### Five findings that drive the design

1. **Claude Code repeats usage per content block — must dedupe by `requestId`.**
   1509 requestIds carry multiple usage records. Usage *never* differs within a requestId
   (0 cases), even across the 742 where `apiBlockIndex` varies. Naive summing overcounts output
   tokens by **33%** (4.88M → 3.66M) and cache-creation by **~65%** (13.7M → 8.1M). The dedupe
   key is `requestId` **alone**, not `(requestId, apiBlockIndex)`.

2. **OpenCode's `cost` column is `0.0` for all 82 sessions** — subscription auth never computes a
   dollar figure. Real volume is 12.1M input / 593K output / 23M cache-read tokens with no cost
   attached. Cost must be computed by us.

3. **100% of Claude Code cache-creation is 1-hour TTL** (8.14M tokens, 0 at 5m). `models.json`
   carries only the 5m `cache_write` rate (1.25× input); the 1h rate is 2× input. Using the table
   value verbatim underprices every cache write by ~60%.

4. **`~/.cache/opencode/models.json` is a usable, auto-updating price table for *both* harnesses.**
   It covers `anthropic/claude-opus-5|sonnet-5|fable-5-1` as well as the OpenAI models in use.
   Only `ollama/*` (local, correctly $0) and Claude Code's `<synthetic>` pseudo-model (8 records,
   must be excluded) have no entry.

5. **Claude Code prunes its own transcripts after ~30 days** (`cleanupPeriodDays` default; unset
   in `settings.json`; `.last-cleanup` had run that day and the oldest surviving transcript was
   28 days old). The harness's own files are therefore **not** a durable archive. The local JSONL
   archive is what preserves history beyond 30 days, which makes local extraction load-bearing
   independently of whether the Pi is reachable.

OpenCode needs no dedupe: per-message sums reconcile **exactly** with the `session` rollup
columns for all 82/82 sessions.

### Runtime: Node, not Python

Node 24.14.1 is present, and Claude Code itself requires Node — so it is guaranteed on the Mac
too. `node:sqlite` is built into Node ≥22.5 and was **verified reading the live `opencode.db`
read-only** (984 messages, no locking issue), which removes the `better-sqlite3` native build on
arm64/macOS that was the only real argument for Python. `pg` is pure JS, so the agent is one
runtime plus one dependency and no build step. Both harnesses are JS/TS, so a future real-time
OpenCode plugin could import the same pricing/normalizer modules. (`node:sqlite` prints an
experimental warning in Node 24 — run with `--no-warnings`; the read-only API is stable.)

## Deliverables

```
harness-telemetry/            (git init — not yet a repo)
├── plans/001-harness-usage-telemetry.md   (this file)
├── agent/
│   ├── src/
│   │   ├── cli.js            sync | backfill | show | doctor
│   │   ├── pricing.js        models.json loader + overrides + tier/1h rules
│   │   ├── record.js         canonical UsageEvent
│   │   ├── sources/claude-code.js, opencode.js
│   │   ├── local-store.js    JSONL archive + state/outbox SQLite (node:sqlite)
│   │   └── sink-postgres.js  idempotent upsert (pg)
│   ├── pricing-overrides.json
│   ├── package.json          deps: pg  ·  engines: node >=22.5
│   ├── bin/harness-usage     wrapper that resolves node via nvm.sh (see §3b)
│   └── install/  harness-usage.{service,timer}  ·  com.ritenoar.harness-usage.plist
├── server/
│   ├── docker-compose.yml    postgres:17-alpine + grafana, bound to the Tailscale IP
│   ├── .env.example
│   ├── postgres/init/01-schema.sql
│   └── grafana/provisioning/{datasources,dashboards}/ + dashboards/harness-usage.json
└── README.md
```

Plain ES modules on Node ≥22.5. `pg` (pure JS) is the only dependency; SQLite comes from the
built-in `node:sqlite`, so there is no native build on any of the three platforms.

## Data model

One fact row per LLM API response, PK `(harness, session_id, message_id)` so re-syncing and
overlapping runs are idempotent.

```
harness device session_id message_id ts
provider model agent project git_branch is_sidechain
input_tokens output_tokens reasoning_tokens cache_read_tokens
cache_write_5m_tokens cache_write_1h_tokens
cost_usd  billing('api'|'local'|'free')  priced_by('table'|'override'|'none')
```

Splitting cache-write by TTL (rather than one `cache_write` column) is what makes finding 3
fixable, and `billing`/`priced_by` keep local Ollama traffic and unpriced models visibly separate
from real spend instead of silently reading as $0.

Session/day/project rollups are Postgres **views** over this table, not extra tables.

Local readable copy: `~/.local/share/harness-usage/events/YYYY-MM-DD.jsonl`, one object per line,
jq-friendly. `state.sqlite` alongside holds sync cursors and the unsynced outbox.

## Implementation

### 1 · Extraction

`claude-code.js` walks `~/.claude/projects/*/*.jsonl`, resumes from a per-file `(inode, byte
offset)` cursor (files are append-only), keeps `type=="assistant"` records that have
`message.usage`, **dedupes by `requestId`** (falling back to `uuid` when absent), and drops
`model=="<synthetic>"`. Maps `cache_creation.ephemeral_{1h,5m}_input_tokens` to the two TTL
columns and `output_tokens_details.thinking_tokens` to reasoning; carries `cwd`, `gitBranch`,
`isSidechain`.

`opencode.js` opens the DB **read-only** via `new DatabaseSync(path, {readOnly: true})` — verified
safe against a running OpenCode, since SQLite readers don't block writers — and selects assistant
messages joined to `session`, resuming from a `time_updated` watermark and upserting so edited
rows correct themselves. Session `directory` becomes `project`; `agent`/`mode` becomes `agent`.
Note the message `data` JSON does **not** contain `id`/`sessionID`; those are table columns.

### 2 · Pricing (`pricing.js`)

Load `models.json`, then apply in order:

- no entry (`ollama/*`) → cost 0, `billing='local'`, `priced_by='none'`
- Anthropic 1h cache write → `2 × input` rate; 5m → table `cache_write`
- OpenAI context tiers → when `input + cache_read > tier.size` (272k) use the tier rates
- `cost = (in·input + out·output + cr·cache_read + cw5m·cache_write + cw1h·input·2) / 1e6`

`pricing-overrides.json` covers table misses and pins rates so historical rows don't silently
reprice when `models.json` updates. **Do not add reasoning tokens to output** — for Anthropic
they are already inside `output_tokens` (see the open question below for OpenCode).

### 3 · Sync and offline behaviour

`harness-usage sync` extracts → appends JSONL → upserts Postgres over Tailscale → marks synced.
The two halves are deliberately independent:

- *Extraction always runs*, network or not, and writes the local JSONL archive immediately. Given
  finding 5, this is the only thing preserving history past Claude Code's 30-day prune.
- *Shipping* clears a `synced` flag in `state.sqlite` only on a confirmed upsert. Offline, or off
  the tailnet, rows simply accumulate and the whole backlog drains on the next successful run.
  The stable PK makes replays idempotent, so an upload interrupted halfway re-converges rather
  than duplicating or double-counting.
- Worst case, if `state.sqlite` is lost entirely, `backfill` rebuilds from the harnesses' own
  files (within their retention) plus the local JSONL archive (beyond it).

Config at `~/.config/harness-usage/config.json` (DSN, device name, enabled sources) — never
committed.

### 3b · How it actually runs on each device

The agent is a **short-lived process**, not a daemon: it wakes, syncs, exits. A missed run is
harmless — the next one just has more to do.

| Device | Mechanism | Notes |
|---|---|---|
| `desktop` (Linux) | systemd **user** timer | `OnUnitActiveSec=5min`, `Persistent=true` so a run missed while powered off happens after boot |
| `laptop` (macOS) | launchd **LaunchAgent** | `StartInterval: 300`; loads at login, fires once on wake rather than stacking missed runs |
| `raspberrypi` | none | hosts Postgres + Grafana only, unless a harness is also run there |

Two environment facts measured on `desktop` that the install must handle:

1. **Node is nvm-managed** — `/home/USER/.nvm/versions/node/v24.14.1/bin/node`. Neither systemd
   nor launchd sources `.zshrc`, so bare `node` is not on their `PATH`, and hardcoding that
   version-pinned path silently breaks on the next `nvm install`. Ship a `bin/harness-usage`
   wrapper that sources `nvm.sh` (falling back to a plain `node` lookup) and have both the unit
   and the plist invoke **the wrapper, never `node` directly**. The same wrapper works on macOS
   whether Node there is nvm- or Homebrew-managed.

2. **`Linger=no` for user `stef`** — user timers only run while a login session is active.
   Leave it that way: new data only exists while he is logged in using the harnesses, and
   anything missed self-heals on the next run. `sudo loginctl enable-linger $USER` if headless
   operation is ever wanted.

**Optional, opt-in — event-driven sync for a near-live dashboard.** A 5-minute timer means the
dashboard can lag by up to 5 minutes. Claude Code's **`SessionEnd`** hook (verified present) can
run `harness-usage sync` when a session ends, and OpenCode's plugin API exposes a `session.idle`
event for the same purpose. Cheap, since the sync is incremental, and the timer stays as the
safety net — but it adds coupling to each harness that the base design deliberately avoids.
Do not enable by default; ask first.

### 4 · Pi stack

`postgres:17-alpine` and `grafana/grafana` (both arm64), a volume for each, schema applied via
`postgres/init`. Ports bound to the **Tailscale IP only** (`"100.x.y.z:3000:3000"`) so
nothing is exposed to the LAN or the internet. Grafana is provisioned with the Postgres
datasource and the dashboard as code, so it comes up populated.

### 5 · Dashboard

Cost over time stacked by model; tokens over time split input/output/cache-read/cache-write;
month-to-date spend; top sessions by cost (table: project, model, duration, tokens); cost by
project; cost by device; billable-vs-local split; cache-read ratio.

## Open question to resolve during implementation

Whether OpenCode's `tokens.reasoning` is already included in `tokens.output` (for Anthropic it is;
OpenCode's AI-SDK accounting may report it separately). Verify against a `gpt-5.6-sol` session —
e.g. `ses_f834f199affeZeUVqDuSClOcyW` has output 6577 / reasoning 13902; reasoning exceeding
output would show it is clearly a separate counter. This affects OpenCode cost magnitude only.
Settle it with a real query and record the conclusion in `pricing.js` — do not guess.

## Verification

1. `harness-usage doctor` — resolves both source paths, loads pricing, reports models with no
   price entry, tests the Postgres connection.
2. **Dedupe regression check**: assert deduped Claude Code totals equal 3.66M output / 8.14M
   cache-creation (the measured figures); a naive-sum bug shows up immediately as 4.88M.
3. **OpenCode reconciliation**: assert per-session sums from the fact table equal the `session`
   rollup columns for all 82 sessions — the invariant already verified as 82/82.
4. **Idempotency**: run `sync` twice; row count and `SUM(cost_usd)` must be unchanged.
5. **Offline resilience**: stop Postgres (or `tailscale down`), run `sync` twice, confirm the
   JSONL archive still grows and rows queue unsynced; restore and confirm the whole backlog
   drains in one run with unchanged `SUM(cost_usd)`.
6. Spot-check one Claude Code session's computed cost by hand against `/cost` in that session.
6b. **Scheduling**: `systemctl --user start harness-usage.service` succeeds standalone, then
   `systemctl --user list-timers` shows the timer armed; confirm the unit runs through the
   `bin/harness-usage` wrapper by checking `journalctl --user -u harness-usage` for a clean run
   with no `node: command not found`.
7. On the Pi: `docker compose up -d`, confirm Grafana at `http://raspberrypi:3000` renders
   populated panels, and confirm the ports are *not* reachable from a non-tailnet address.
