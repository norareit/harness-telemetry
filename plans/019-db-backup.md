# Plan 019 — Daily Postgres backups, pulled by a client

Type: **task**
Status: **planned** (2026-10-23).

Terms: the **server** is the machine running the stack in `server/docker-compose.yml`. A **client** is any other
machine that pulls dumps from it, usually a device that also runs the agent.

## Why

The server's Postgres has no backup. Most of it can be rebuilt from the devices (`restore-archive` + `sync`), but not
all of it:

- **Cost after a `reprice`.** `reprice` re-values the outbox and Postgres but appends no archive line, so Postgres is
  authoritative for cost (README, "Reading the archive correctly").
- **Anything fixed by hand in Postgres.**
- **A device that is gone.** Its archive went with it.

A backup that stays on the server doesn't survive the server's disk dying, so each dump is also copied to a client.

## Design

Two independent halves, each with its own timer:

1. **On the server:** a shell script dumps every night, checks the dump, and keeps the last 14. The server doesn't
   run the agent, so this half doesn't depend on it.
2. **On a client:** the agent command `harness-usage pull-backup` pulls new dumps every day. If the client was off at
   that time, it pulls on the next login.

They are deliberately decoupled. The server keeps 14 days, so a client can be off for up to two weeks without missing
a dump: one `rsync` fetches everything it doesn't have yet.

All client settings live in the agent's `config.json` under `backup`, next to the rest of the device's config. The
server address is not derived from `postgres.dsn`: the DSN holds whatever address Postgres is reached at (often a bare
Tailscale IP), while SSH may need a user name or an alias from `~/.ssh/config`.

### Daily-or-on-next-start on the client

This is what `OnCalendar=` + `Persistent=true` does. systemd stores the time of the last trigger
(`~/.local/share/systemd/timers/stamp-<timer>`). When the timer is activated and a calendar elapse was missed since
that stamp, the service fires right away, once. For a user timer, "activated" means the user manager starts, which
is at login. Plan 012's lesson doesn't apply here: `Persistent=` is ignored without `OnCalendar=`, but this unit has
both, and it doesn't use `OnBootSec=`.

The catch-up run happens at login, when the network (or Tailscale) may not be up yet. The service therefore retries:
`Restart=on-failure` with `RestartSec=10min` (allowed for `Type=oneshot` since systemd 244), bounded by
`StartLimitIntervalSec=3h` / `StartLimitBurst=6` in `[Unit]`.

## Changes

### `server/backup/backup.sh` (runs on the server)

`#!/usr/bin/env bash`, `set -euo pipefail`.

- `DEST="${HARNESS_BACKUP_DIR:-$HOME/backups/harness-telemetry}"`, `KEEP="${HARNESS_BACKUP_KEEP:-14}"`.
- Locate the compose file relative to the script (`$(dirname "$0")/../docker-compose.yml`), so it works from any
  working directory.
- Name: `harness-telemetry-$(date -u +%Y%m%dT%H%M%SZ).dump`. Sorting the names sorts by time.
- Dump into `<name>.tmp`:
  `docker compose -f "$COMPOSE" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'`.
  `pipefail` makes a failed `pg_dump` fail the script.
- Check: feed the `.tmp` file into `docker compose … exec -T postgres pg_restore --list` and require exit 0 and a
  non-empty listing. On failure, delete the `.tmp` file and exit non-zero.
- `mv` the `.tmp` file to its final name. The puller only ever sees finished files.
- Prune: delete all but the newest `$KEEP` `harness-telemetry-*.dump` files, by name.
- Print one line: the file name and its size.

### `harness-usage pull-backup` (runs on a client)

Config, in `agent/src/config.js` DEFAULTS and documented in `config.example.json`:

```js
backup: { source: null, dir: null, keep: 60, staleAfterHours: 48 }
```

- `source`: an rsync source such as `<server-host>:backups/harness-telemetry/`. No default: null means this device
  doesn't pull backups.
- `dir`: where the dumps go. null means `<DATA_DIR>/db-backups` (so `HARNESS_USAGE_DATA_DIR` moves it in tests).
- `keep`: how many dumps to keep locally. More than the server keeps, so the client holds the longer history.
- `staleAfterHours`: for the doctor check below.

`agent/src/backup.js`, `pullBackups(cfg, { rsync = "rsync" } = {})`:

- `mkdir -p` the dir, list `harness-telemetry-*.dump` in it, then run
  `rsync -a -e 'ssh -o BatchMode=yes -o ConnectTimeout=20' --include='harness-telemetry-*.dump' --exclude='*'
  <source> <dir>/` with `spawnSync` (argument array, no shell). `-a` keeps the server's mtime, so a file's mtime is
  when the dump was made, not when it was pulled. No `--delete`: the client keeps more than the server does.
- A non-zero rsync exit throws, with rsync's stderr in the message.
- Each file that wasn't there before must start with the custom-format magic `PGDMP`. This needs no `pg_restore` on
  the client. Bad files are deleted, and the function throws after pruning.
- Prune to the newest `keep`, by name.
- Returns `{ dir, pulled: [names], removed: [names], newest }`.

`agent/src/cli.js`: a `pull-backup` command. Without `backup.source` it prints what to set and where, and exits 2.
On success it prints one line per pulled file and a summary. A thrown error exits 1, like every other command, so
the unit retries.

### Units

`server/backup/harness-db-backup.service` + `.timer` (server, **user** units):

- Service: `Type=oneshot`, `ExecStart=%h/projects/harness-telemetry/server/backup/backup.sh` (comment: adjust if the
  checkout lives elsewhere), `Nice=10`.
- Timer: `OnCalendar=*-*-* 03:30`, `Persistent=true` (covers a server that was rebooting or down at 03:30),
  `RandomizedDelaySec=5min`.
- A headless server needs `loginctl enable-linger $USER` for the user manager to run without a login, or the timer
  never fires. The user must be in the `docker` group.

`agent/install/harness-db-pull.service` + `.timer` (client, user units, next to the agent's own):

- Service: `Type=oneshot`, `ExecStart=%h/projects/harness-telemetry/agent/bin/harness-usage pull-backup` (the
  wrapper, as for `harness-usage.service`), `Nice=10`, `Restart=on-failure`, `RestartSec=10min`, and
  `StartLimitIntervalSec=3h`, `StartLimitBurst=6` in `[Unit]`. `After=network-online.target` like
  `harness-usage.service`.
- Timer: `OnCalendar=*-*-* 11:30` (well after the server's 03:30 dump, and late enough that a client switched off
  overnight is usually on), `Persistent=true`, with a comment explaining the catch-up and that plan 012's
  `Persistent=` warning doesn't apply. Both times are the local time of the machine running the timer. Don't add a
  time zone suffix. The README says to change the time with a drop-in (`systemctl --user edit harness-db-pull.timer`)
  rather than by editing the shipped unit.

### `doctor`: a "last backup" check

- `agent/src/doctor.js`: a `{ name: "last backup", run: checkLastBackup }` entry after "last ship". Not applicable
  (`null`) without `backup.source`. Otherwise find the newest `harness-telemetry-*.dump` in the dir. Fail if there is
  none, or if its mtime is older than `staleAfterHours`. The detail gives the file, its age, and a hint:
  `harness-usage pull-backup`, or `systemctl --user status harness-db-pull.service` /
  `journalctl --user -u harness-db-pull`.
- Because the mtime is the dump's, the check also catches a server whose nightly dump stopped while the pull keeps
  succeeding.

### Tests (`agent/test/`)

- `install.test.js`: both new timers have `OnCalendar=` and `Persistent=true` and no `OnBootSec=`. The pull service
  has `Restart=on-failure`.
- `backup.test.js`, against a local directory as the rsync source (rsync copies local paths without SSH): pulls new
  dumps and keeps their mtime; a second run pulls nothing; a file without the magic is deleted and the run throws;
  pruning keeps the newest `keep`; an rsync failure (missing source) throws.
- `doctor.test.js`: "last backup" is not applicable without `source`, fails on an empty dir, fails on a stale file
  (set the mtime with `utimesSync`), passes on a fresh one. Update the check count.
- `cli.test.js`: `pull-backup` without `backup.source` exits 2 with the message.

### README

A "Backups" section under "Server stack":

- What is backed up and why a client copy exists (the summary under "Why" above).
- Install on the server: copy the units to `~/.config/systemd/user/`, `loginctl enable-linger`, `daemon-reload`,
  `enable --now harness-db-backup.timer`, and a manual first run: `systemctl --user start harness-db-backup`.
- Install on a client: key-based SSH to the server that works with `BatchMode=yes`, `rsync` on both machines,
  `backup.source` in `config.json`, a manual `harness-usage pull-backup`, the units,
  `enable --now harness-db-pull.timer`, and how to move the pull time with a drop-in.
- **Restore**, step by step: stop the agents' timers on every device so nothing ships mid-restore, then
  `docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists'
  < file.dump`, then restart the timers. Afterwards each device's `sync` re-ships anything newer than the dump from
  its outbox.
- **Before a manual fix:** run `backup.sh` by hand and do the fix inside `BEGIN … COMMIT`. A fix made only in
  Postgres is overwritten by the next `backfill` from the outbox (the plan 014 caveat), so lasting fixes belong in
  the outbox, as with `retag-project.mjs` / `reroot-project.mjs`.

Also: `pull-backup` in the Commands list, and "last backup" in the `doctor` checks list.

## Out of scope

- The Grafana volume. Dashboards and the datasource are provisioned from the repo, so it holds only users and
  preferences.
- Encryption. The dumps travel over the private network the stack is bound to, and stay on machines the operator
  controls.
- Offsite copies beyond the client.
- A launchd job for a macOS client. `harness-usage pull-backup` and the doctor check work there; scheduling it is
  left to the operator.

## Verification

1. `npm test` in `agent/` is green, and the new tests fail before the change.
2. `systemd-analyze --user verify` is clean for all four units. `bash -n` and `shellcheck` (if installed) are clean
   for `backup.sh`.
3. `backup.sh` against a throwaway copy of the stack (a scratch copy of `server/`, its own `.env`, another
   `COMPOSE_PROJECT_NAME`): writes a dump that `pg_restore --list` reads, prunes to `KEEP`, and leaves no `.tmp`
   file when the dump fails (container stopped).
4. On the server: one manual run writes a dump. **Restore test:** restore it into a throwaway database
   (`createdb harness_restore_test`, `pg_restore -d harness_restore_test`). Compare `count(*)` and `sum(cost_usd)` of
   `usage_event` with the live database, then `dropdb`. `systemctl --user list-timers` shows the next elapse.
5. On a client: `harness-usage pull-backup` fetches the dump, and `doctor` passes "last backup".
6. Catch-up: with the client off (or logged out) over 11:30, the pull runs at the next login. Check with
   `journalctl --user -u harness-db-pull`. With the server unreachable at that moment, it retries 10 minutes later.
