# Plan 007 — Make a dead sync visible: launcher exit codes and a staleness signal

Status: **approved, not yet implemented.**
Builds on 001–006, all implemented. Written 2026-09-18 from review finding P1 on plan 006,
which was prompted by the incident fixed in commit `b5aacf2`.

## Context

On 2026-09-17 the desktop systemd timer stopped feeding Grafana for about 13 hours and nothing
noticed. The root cause was in `agent/bin/harness-usage`, not the agent: the systemd user
service's `PATH` carried no `node`, the wrapper fell through to sourcing `~/.nvm/nvm.sh`, an
unbound variable in that script tripped the wrapper's `set -u`, and the wrapper aborted before
its `~/.nvm` glob fallback ever ran. It launched nothing, extracted nothing, shipped nothing.
Commit `b5aacf2` fixed that specific abort (the sourcing now happens in a subshell with
`set -eu` relaxed).

The fix is correct. What this plan addresses is **why thirteen hours passed unseen**, which
`b5aacf2` did not change:

1. **Exit code 3 means two different things.** The agent exits 3 for "extraction succeeded,
   shipping failed, rows queued locally" (`agent/src/cli.js:178`), and the unit whitelists it:
   `SuccessExitStatus=0 3` in `agent/install/harness-usage.service:14`. The wrapper's abort
   happened to exit 3 as well, so systemd logged every dead run as `Finished`. Any future
   wrapper failure that lands on status 3 is invisible in exactly the same way; the wrapper's
   only deliberate exits are the two `exit 127` paths at lines 101 and 106, and every other
   abort under `set -e` exits with whatever status the failing command had.

2. **Nothing measures "time since the last successful sync".** The outbox sat at 0 unsynced
   with cursors frozen at the last good run (2026-09-17 11:53), which matched Postgres exactly,
   so the local store, the dashboard and `doctor` all looked healthy. `doctor` has seventeen
   checks (plan 006 registry) and not one of them asks whether the agent has run lately.

3. **The dashboard has no liveness panel.** `usage_event.synced_at` is `now()` at upsert
   (`server/postgres/init/01-schema.sql:53`, and `sink-postgres.js` sets it on every conflict
   update), so Postgres already knows when each device last shipped. No panel shows it.

The same blind spot exists on the laptop, where launchd interprets no exit codes at all and
the only trace is `~/Library/Logs/harness-usage.log`.

## Decision

Three small, independent changes, in order of how early they would have caught the incident:

- the wrapper can never exit with an agent status code;
- `sync` stamps its own last success, and `doctor` reports its age;
- Grafana shows minutes since each device last shipped, with thresholds.

No daemon, no alerting stack, no change to the timer cadence. The signal is made visible in
the three places a person already looks: `journalctl`, `doctor`, and the dashboard.

## Design

### 1. Launcher exit codes are the launcher's own

Define the code map once, in a comment at the top of `agent/bin/harness-usage` and in the
README's "sync exits" sentence:

| code | meaning | who |
|---|---|---|
| 0 | ok | agent |
| 1 | error | agent |
| 2 | usage | agent |
| 3 | extracted, shipping failed, queued locally | agent |
| 127 | launcher could not start the agent | wrapper |

The wrapper must guarantee it never exits with 0–3 on its own behalf. Today the two explicit
failure paths exit 127, but an unexpected abort under `set -eu` exits with the failing
command's status. Add, immediately after `set -eu`:

```sh
# Any abort before exec is the LAUNCHER's failure. Exit 127, never a code the
# agent uses — status 3 once masqueraded as "queued offline" for 13 hours
# (2026-09-17) because SuccessExitStatus=0 3 in the unit treats it as success.
trap 'code=$?; [ "$code" -eq 0 ] || { echo "harness-usage: launcher aborted before starting the agent (status $code)" >&2; exit 127; }' EXIT
```

and immediately before the final `exec`:

```sh
trap - EXIT
exec "$NODE_BIN" --no-warnings "$ENTRY" "$@"
```

`exec` replaces the shell, so once the agent runs its status is its own. `exit` inside an
`EXIT` trap overrides the status in POSIX sh, dash and bash (macOS `/bin/sh` is bash in POSIX
mode), which is what makes this work without restructuring the resolution logic. Keep the two
explicit `exit 127` lines; they now also print through the trap's message, which is fine.

`SuccessExitStatus=0 3` in the unit stays. With the wrapper unable to produce 3, `Finished`
is honest again. Add one line to the unit comment saying why 3 is listed and that the wrapper
reserves 127.

### 2. `sync` stamps its last success; `doctor` reports the age

**Store.** Two `kv` keys, written by `runSync` in `agent/src/sync.js`, epoch seconds as
strings like the existing watermark:

- `sync:last_run` — written at the end of the extraction pass (after the last
  `transactionAsync` completes, before shipping). Means "the agent ran to the end of
  extraction". Written on `--no-ship` runs too.
- `sync:last_ship_ok` — written only when shipping completed with no `shipError`, **including**
  the "nothing to send" case (the tailnet was reachable, or there was no work; either way
  nothing is queued). Not written when `postgres.dsn` is unset.

Both go through `store.setKV`; no schema change. `resetCursors()` must **not** clear them
(it deletes `watermark:%` only; keep it that way and add a test).

**Report.** `runSync` returns `lastRunAt` / `lastShipOkAt` so `cmdSync` can print nothing new
(output stays byte-identical) — the fields exist for tests.

**Doctor.** Two new checks appended to the registry in `agent/src/doctor.js`, after
"postgres schema" so existing output order is untouched:

```
{ name: "last sync",  run: checkLastSync }
{ name: "last ship",  run: checkLastShip }
```

Each reads its key from `ctx.store.getKV`. Threshold from a new config field,
`sync.staleAfterMinutes`, default **60** in `config.js` `DEFAULTS` and shown in
`config.example.json` with a comment. Semantics:

- key absent → `ok: false`, detail `never recorded — run 'harness-usage sync'` (a fresh
  install failing doctor until its first sync is the intended prompt).
- age ≤ threshold → `ok: true`, detail `12 min ago (2026-09-18T09:41:03Z)`.
- age > threshold → `ok: false`, detail `13.2 h ago (…) — exceeds sync.staleAfterMinutes=60;
  check 'systemctl --user status harness-usage.timer' / 'journalctl --user -u harness-usage'`.
  On macOS the hint is `launchctl print gui/$(id -u)/com.ritenoar.harness-usage` and the log path.
- "last ship" additionally returns `null` (not applicable) when `postgres.dsn` is unset, so
  a `--no-ship`-only setup does not fail on it.

The threshold is per device on purpose: desktop is always on (60 is generous against a
5-minute timer), while a laptop that sleeps overnight would need a larger value or would
legitimately fail doctor the next morning, which is arguably also the right answer.

### 3. A liveness panel on the dashboard

Add panel `id: 50` to `server/grafana/dashboards/harness-usage.json`, placed at the top row
right (`gridPos` `{ h: 4, w: 6, x: 18, y: 0 }`, moving "Cache-read ratio" down or narrowing
the top row — whichever keeps the row readable), type `stat`, title
**Minutes since last ship, per device**:

```sql
SELECT device, EXTRACT(EPOCH FROM (now() - max(synced_at))) / 60 AS "minutes"
FROM usage_event
GROUP BY device ORDER BY device
```

`unit: "m"`, thresholds green < 30, orange < 180, red ≥ 180, `colorMode: "background"`.
Show one stat per device (`reduceOptions.values: true`), ignoring the dashboard time range
and the `$device` variable on purpose: a device that has fallen silent must stay visible.

`synced_at` is the right column, not `ts`: it is when the row reached Postgres, so it is the
one thing that keeps moving on a healthy device even with no new usage… except that a device
with no new usage ships nothing and its `max(synced_at)` stands still. That is inherent to a
ledger-shaped table and is why the `doctor` check (which stamps on every run, work or not) is
the authoritative signal and the panel is the glanceable one. Say so in the panel
description.

### Files

| File | Change |
|---|---|
| `agent/bin/harness-usage` | EXIT trap → 127 with a message; `trap - EXIT` before `exec`; code map comment |
| `agent/install/harness-usage.service` | one comment line on `SuccessExitStatus` |
| `agent/src/sync.js` | write `sync:last_run` and `sync:last_ship_ok`; return them in the report |
| `agent/src/config.js`, `agent/config.example.json` | `sync.staleAfterMinutes`, default 60 |
| `agent/src/doctor.js` | `checkLastSync`, `checkLastShip`, appended to `CHECKS` |
| `agent/src/local-store.js` | no code change; test that `resetCursors` leaves `sync:%` keys |
| `server/grafana/dashboards/harness-usage.json` | panel 50 |
| `README.md` | exit-code table; the two doctor checks in the list; one sentence on the panel |
| `agent/test/cli.test.js` | launcher test (below); after `sync --no-ship`, `kv` has `sync:last_run` and not `sync:last_ship_ok` |
| `agent/test/doctor.test.js` | the two checks against a hand-built ctx: absent, fresh, stale, and `null` when no DSN |
| `agent/test/local-store.test.js` | `resetCursors` keeps `sync:%` |

**Launcher test.** Spawn `bin/harness-usage --help` with `HOME` pointed at a scratch
directory and `PATH=/nonexistent`, and `NVM_DIR` at a scratch `nvm.sh` that is just
`: "$UNBOUND"`: expect exit **127**, stderr containing `launcher`, and **never** 0–3. Then
spawn it with the real `PATH`: expect exit 0 (the agent's `--help`). The plan-005 `scratch()`
helper already isolates `HOME`.

## Verification

1. `npm test` green; the launcher test fails before the trap is added (it exits with the
   `set -u` status, not 127) and passes after.
2. On desktop: `systemctl --user start harness-usage.service`, then `harness-usage doctor`
   shows `last sync` and `last ship` green with ages under a minute.
3. Simulate the incident: `systemctl --user stop harness-usage.timer`, wait past the
   threshold (or set `sync.staleAfterMinutes: 1` temporarily), `doctor` → both checks **FAIL**
   with the age and the `systemctl`/`journalctl` hint. Restart the timer, `doctor` green.
4. Simulate the launcher failure: run
   `env -i HOME=$HOME PATH=/nonexistent NVM_DIR=/nonexistent agent/bin/harness-usage sync`
   → exit 127 and the "launcher aborted" line on stderr; `journalctl --user -u harness-usage`
   after `systemctl --user start harness-usage.service` under the same broken environment
   shows `Failed`, not `Finished`.
5. Grafana: the new panel shows each device's minutes since last ship, desktop under 10 on a
   quiet run. Stop the timer for an hour and watch it turn orange.
6. `sync` stdout is byte-identical to before (the stamps add no output).

## Out of scope

Push alerting (Grafana alert rules, ntfy, email): the dashboard threshold is enough for a
two-device setup and can be promoted to an alert rule later without agent changes. A
watchdog timer in systemd (`WatchdogSec` needs a long-running service; this one is a
oneshot). Changing the timer interval. Making launchd interpret exit codes.
