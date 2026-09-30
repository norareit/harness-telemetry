# Plan 015 — A working directory missing at sync time still resolves to its repository

Type: **bug**
Status: **implemented** (2026-09-30). `npm test` is green at 131 (three new cases in `project.test.js`). On desktop's
real tree, a missing `~/projects/agent-kit/changes/9999-…` resolves to `~/projects/agent-kit`, while a Mac path
(`/Users/stef/...`) and a missing `/tmp` dir are returned unchanged. Repaired on desktop the same day, with the timer
stopped and a backup taken: the `reroot-project.mjs` dry run listed exactly the one pair (2 events), `--apply`, then
`sync` exited 0 with the backlog clear, and `doctor` shows "projects are repo roots" and "cost reproducible from stored
rates" both ok.

## What was broken

`doctor` on desktop, 2026-09-30:

```
[FAIL] projects are repo roots
       2 events under 1 subdirectory of a repo root, e.g. ~/projects/agent-kit/changes/0010-init-command →
       ~/projects/agent-kit — run 'node agent/scripts/reroot-project.mjs' (dry run first)
```

These are two Claude Code events from session `a371b583-…`, at 2026-09-27T22:54:44Z and 22:54:51Z. The session's other
83 events are correctly filed under `~/projects/agent-kit`. Both events were first recorded (`outbox.first_seen`) at
2026-09-28 00:59:59 local time. agent-kit's reflog shows `task-0009-readme-cleanup` checked out from 00:56:13 to
01:05:35. `changes/0010-init-command/` exists only on `feature-0010-init`, so at 00:59:59 that directory did not exist
on disk.

Plan 008's rule 1 says: "`dir` does not exist → return unchanged". `projectRootOf` therefore stored the raw cwd. A
later checkout brought the directory back, so `doctor` now resolves it to the repo and reports a subdirectory.

This will keep happening. Any `git switch` that removes the session's cwd (a per-change directory, a new package, a
scratch folder on a branch) and lands before the sync timer runs will file those turns under the subdirectory for good.

## What it should be

A path that is missing on disk but sits under an existing repository belongs to that repository. Plan 008 guarded
against turning a missing path into "its nearest existing ancestor", and that concern still holds for a plain ancestor
like `~/projects`. A `.git` hit is different: it identifies the project unambiguously, whether the subdirectory is
missing now or not.

## Fix

`agent/src/project.js` `projectRootOf`: drop the `exists(dir)` guard and always run the walk. The walk is lexical
(`dirname`), and each step already asks the filesystem only for `join(d, ".git")` and `join(parent, SPLIT_MARKER)`.
A missing component therefore can't produce a false hit. The result for each kind of path:

- missing, under an existing repo → the repo root (the fix);
- missing, inside a split container's child → that child, which may itself be missing (same rule as when it exists);
- from another machine (`/Users/stef/...` on Linux) or a deleted scratch dir with no `.git` above → unchanged, as
  before;
- the `$HOME` stop and the memo are unchanged.

Accepted edge: a deleted *nested* repository (`outer/inner/.git` gone, together with `inner`) now resolves to `outer`.
Its identity went with its `.git`, so that is the only answer the filesystem still supports.

`isProjectRoot` keeps its own `exists(dir)` check, so a mistyped `--to` is still refused.

Side effects:

- `doctor` "projects are repo roots" now also flags missing-but-under-a-repo values it used to pass, and
  `reroot-project.mjs` repairs them. Both call `projectRootOf`, so they need no change.
- Comments/docs that state the old rule: `project.js` header, `sources/claude-code.js` (extractor comment),
  `scripts/reroot-project.mjs` header, README "Data model" paragraph on `project`.

### Tests (`agent/test/project.test.js`)

- Replace "a path that does not exist is returned unchanged, even under a repo" with: a missing path under a repo →
  the repo root.
- A missing path with no `.git` above → unchanged.
- A missing path inside a split child → the child.

## Repair of the existing rows

On desktop, after this lands: timer stopped, backup taken (see `agent/scripts/README.md`), then
`node agent/scripts/reroot-project.mjs` (dry run: expect the one pair above, 2 events), `--apply`, `sync`, and
`doctor` shows green.
