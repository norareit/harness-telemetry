# Plan 014 — Re-file whole sessions under a different project

Type: **task**
Status: **implemented** (2026-09-26). `npm test` is green at 127. On a scratch copy of the desktop data dir: the dry
run listed 2085 events in the 12 sessions, `--apply` moved them (norareit $433 → $148, agent-kit $6 → $291
notional), all 2085 were re-queued, the archive kept its 9109 lines (rewritten, not appended), and a re-run found
0 to retag. An unknown ID and a non-root `--to` were both refused. The real run on desktop is still to be done.

## Feature

`project` is derived from the session's working directory (plan 008). Sometimes the cwd is the wrong place: between
2026-09-04 and 2026-09-24, work on the **agent-kit** project (changes 0030, 0031, 0033, 0035–0039) was done from
`~/projects/norareit`, so about 600M tokens and $285 notional show up under `norareit` instead of `agent-kit`.

Add a one-off repair script, `agent/scripts/retag-project.mjs`, that moves every event of the named sessions to
another project. It is a thin `map(ev)` over `scripts/lib/rewrite-events.mjs`, like `retag-device.mjs`. That means
the outbox, the archive line and the `archived` hash are rewritten together, and Postgres is corrected by the next
`sync` (`project` is in the sink's `ON CONFLICT` update set).

This is deliberately **not** a durable override. Normal syncs read transcripts from their byte cursor, so they never
re-extract these events and the retag survives. A `backfill` re-extracts from the transcripts, where the cwd is still
`norareit`, and **reverts the retag**. The fix then is to re-run the script. The script header and the scripts README
say so. A config-level `session → project` override that the extractors honour was considered and rejected: it adds
a permanent feature for a one-time mistake.

## Changes

1. `agent/scripts/lib/rewrite-events.mjs`: export `retagSessions(sessionIds, to)`, which returns a `map(ev)` that
   sets `project = to` for events whose `session_id` is in the set and that aren't already on `to`. Otherwise it
   returns null. Session IDs are matched **exactly** (no prefixes), so a short ID can't catch the wrong session.
2. `agent/scripts/retag-project.mjs`:
   - usage: `retag-project.mjs --to DIR [--data-dir DIR] [--apply] SESSION_ID…`
   - refuses (exit 2) when `--to` isn't its own `projectRootOf` (not a repo root). Otherwise `doctor`'s "projects are
     repo roots" check would flag the result.
   - dry-run review table from the outbox: per session, the event count and the current project(s).
   - lists any session ID that matches no outbox row and exits 1 without writing. A typo must not look like success.
   - same legacy-hash refusal and `--apply` behaviour as `retag-device.mjs`.
3. `agent/scripts/README.md`: add a table row, plus a note that `backfill` reverts the retag.
4. `agent/test/scripts.test.js`: `retagSessions` moves only the listed sessions (every message of each), leaves other
   sessions and already-retagged events alone, doesn't prefix-match, and a re-record of a retagged event is
   `unchanged`.

## Operation (Stef runs this on desktop)

The sessions, all Claude Code on desktop: `80e76752-44f3-49c3-aa74-cb23fe6e5687`,
`694d854e-836c-467d-b3ed-3b86540d6d9b` (also has 3 writes to norareit 0032; moved whole),
`33012009-fbf3-43cd-97b6-767b163a2e7c`, `e7d71d6d-d86b-4f5e-a17d-014398a0a0aa`,
`2e3ce378-511f-438c-a32c-00709da446ae`, `6fc32e17-f83d-40e0-93cc-ca3b5f314a02`,
`947450ef-5880-4e2e-bc3f-f106639a50c2`, `1f469e2d-6e98-4722-8f43-2760c4fbde73`,
`15425e0d-a04b-4fd5-8048-afb37f4faaff`, `30b6f7a1-f9cc-4fd7-a621-e24767510f6e`,
`aa49bd31-67d2-42b5-b70e-dacf5189f458`, `cc42762f-e7c4-4b56-9c9a-ca3bbfc3716f` (also has 4 writes to 0041; moved
whole). `de9faf5c` (mostly norareit 0025–0027) stays.

Stop the timer, back up the data dir, dry-run, `--apply`, `harness-usage sync`, restart the timer. Verify with a
`GROUP BY project` against Postgres.
