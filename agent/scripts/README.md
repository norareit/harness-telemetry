# agent/scripts

One-off repairs. Nothing here runs on a schedule, and nothing here is imported
by the agent — these exist because some mistakes are only fixable by rewriting
already-recorded state, and doing that by hand gets it wrong.

The shape of the problem is always the same: the local store is three things
that must agree — the outbox payload, the JSONL archive line, and the `archived`
source hash. Change one without the others and the next `sync` either re-appends
the whole archive or quietly reverts the fix. Each script here changes all three
in step, and leaves Postgres to the normal `sync` path, which updates rows in
place because `device` and friends are in the sink's `ON CONFLICT` update set
while the PK is `(harness, session_id, message_id)`.

The rewrite mechanics are shared in `lib/rewrite-events.mjs`; each script is a
thin `map(ev)` over it.

| Script | For |
|---|---|
| `retag-device.mjs` | events recorded under the wrong `device` name — a config copied from another machine and never edited |
| `reroot-project.mjs` | events filed under a subdirectory of a repo (`project` was the raw cwd before plan 008) — re-files them under the repository root |

Every script takes `--apply` and does nothing without it. Before running one:

```sh
launchctl bootout gui/$(id -u)/com.ritenoar.harness-usage   # or: systemctl --user stop harness-usage.timer
cp -R ~/.local/share/harness-usage ~/.local/share/harness-usage.bak
```

Stopping the timer is not optional — a `sync` firing mid-rewrite ships half the
correction. Restart it after verifying with `harness-usage show`, `doctor`, and a
`GROUP BY device` against Postgres.

`reroot-project.mjs` must run **on the device the events came from**: it resolves
each `project` by walking that machine's filesystem for `.git`, so a path that
lives only on another machine is left untouched (and `doctor`'s "projects are
repo roots" check will keep flagging it until the script is run there).

If any repo should be split into per-child projects (a `.harness-split` marker —
see the README), **create the marker before running `reroot-project.mjs`**: it
uses the same resolver, so with the marker present the sub-projects are kept
distinct, and without it they collapse into the repo root. Adding the marker after
the fact means re-running the repair.
