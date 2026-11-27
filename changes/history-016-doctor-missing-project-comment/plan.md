# Plan 016 — Correct doctor's missing-project comment

Type: **bug**
Status: **implemented** (2026-09-30). Verified the comment against `projectRootOf` and checked the diff with
`git diff --check`.

## What was broken

The comment above `checkProjectsAreRoots` says a project path that is gone resolves to itself and is not flagged.
Plan 015 changed that: a missing path beneath an existing repository resolves to that repository root and is flagged.

## What it should be and how to fix it

Describe the current behavior accurately: a missing path under a detectable repository is flagged, while a missing
path with no detectable repository or split marker above it stays unchanged. Update only the stale comment in
`agent/src/doctor.js`. Verify the diff and that the comment agrees with `projectRootOf`.
