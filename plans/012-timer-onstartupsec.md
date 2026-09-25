# Plan 012 — The systemd user timer never fires when login is more than 2 minutes after boot

Type: **bug**
Status: **implemented** (2026-09-25). `npm test` is green at 126, and the new test failed against the old timer.
`systemd-analyze --user verify` is clean. On desktop, the installed timer was patched and re-armed (next elapse
shown), and a manual sync shipped the 287-event backlog. `doctor` now passes `last sync` / `last ship`. Step 4
(a late login) has not been observed yet.

## What was broken

On 2026-09-25 `harness-usage doctor` on desktop failed `last sync` / `last ship` at 6.7 h. The timer was loaded and
enabled but `systemctl --user status harness-usage.timer` showed `active (elapsed)`, `Trigger: n/a`, and
`NextElapseUSecMonotonic=infinity`. The service had not run at all in the current boot.

`agent/install/harness-usage.timer` had:

```ini
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true
```

- `OnBootSec=` counts from **kernel boot**, even in a user manager. The user manager (and the timer) only start at
  login. If login happens more than 2 minutes after boot, that trigger is already in the past when the timer is
  activated. systemd 255 doesn't fire it.
- `OnUnitActiveSec=` counts from the service's last activation. The service never ran in this boot, so this trigger has
  no base and never elapses.
- `Persistent=` only applies to `OnCalendar=` triggers, so it did nothing here. The README and the unit comment both
  claimed it caught up missed runs.

The journal shows exactly this split on 2026-09-25:

| boot | timer started | gap | fired |
|---|---|---|---|
| 13:08:12 | 13:08:34 | 22 s | yes, 13:10 |
| 13:28:58 | 13:29:33 | 35 s | yes, 13:31 |
| 15:12:30 | 15:16:34 | 4 min | never |
| 19:47:20 | 19:58:53 | 11.5 min | never |

Plan 007 did its job: the staleness checks caught this.

## What it should be

The first run happens shortly after the user manager starts, whatever the boot-to-login gap was. After that, runs
repeat every 5 minutes.

## Fix

`agent/install/harness-usage.timer`:

- `OnBootSec=2min` → `OnStartupSec=2min`. For a user manager this counts from the manager's own start, which is login.
- Drop `Persistent=true` and its misleading comment. Replace it with a comment explaining why `OnStartupSec` is used.
- Keep `OnUnitActiveSec=5min` and `AccuracySec=30s`.

`README.md`: replace the "`Persistent=true` catches up one missed run after boot" sentence with the actual
behaviour: the first run is 2 minutes after login, then every 5 minutes. Users with an installed copy must re-copy
the timer and run `daemon-reload` plus `restart harness-usage.timer`.

Test: `agent/test/install.test.js` parses the `[Timer]` section of the shipped unit. It asserts there is no
`OnBootSec=`, that `OnStartupSec=` is present, and that `Persistent=` only appears alongside `OnCalendar=`.

## Verification

1. `npm test` in `agent/` is green, and the new test fails against the old timer.
2. `systemd-analyze --user verify` on the new timer reports no errors.
3. On desktop, re-install the timer, `daemon-reload`, and `restart harness-usage.timer`. `systemctl --user list-timers`
   shows a next elapse. After the first run, `harness-usage doctor` passes `last sync` / `last ship`.
4. After the next login that comes more than 2 minutes after boot, the service runs about 2 minutes after login.
