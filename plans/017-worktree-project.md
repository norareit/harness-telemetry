# Plan 017 — A linked git worktree is filed under its main repository

Type: **bug**
Status: **implemented** (2026-10-04). `npm test` is green at 139 (eight new cases in `project.test.js`, one renamed).
Checked against real git in a scratch directory: a worktree nested under `main/.claude/worktrees/` and a sibling
worktree both resolve to `main`, and a submodule (`gitdir: ../.git/modules/sub`) stays its own project. Repaired on
desktop the same day, with the timer stopped and a backup taken: the `reroot-project.mjs` dry run listed exactly the
one pair (42 events), `--apply`, then `sync` exited 0 with the backlog clear (51 events shipped: the 42 plus 9 new), a
re-run found nothing to reroot, and `doctor` passed 20/20 with "projects are repo roots" ok. The Mac has not been
checked.

## What was broken

The dashboard on 2026-10-04 shows a project called `agent-a9ad065d34463ec7c`. It is not a project. It is a git worktree
that Claude Code made for a subagent in the `agentrite` repository:

- Session `d1adec76-beb1-492d-9de6-7ad41e916ccc` (cwd `~/projects/agentrite`) spawned a `planner` subagent with worktree
  isolation ("Plan unit 0025 release notes"). Claude Code checks such a subagent out under
  `<repo>/.claude/worktrees/agent-<id>`, here `~/projects/agentrite/.claude/worktrees/agent-a9ad065d34463ec7c`.
- The subagent's transcript (`<session>/subagents/agent-a9ad065d34463ec7c.jsonl`, 154 lines) has that directory as its
  cwd, and so do 101 lines of the parent session's own transcript. Both carry the parent's session ID.
- A linked worktree's root holds a `.git` **file**. `projectRootOf` (`agent/src/project.js`) stops at the nearest
  `.git`, file or directory, and plan 008 chose that on purpose: "worktrees and submodules carry a `.git` file and are
  checkouts in their own right". The walk therefore ended at the worktree and never reached `agentrite/.git`.
- The dashboard shows the basename, hence `agent-a9ad065d34463ec7c`.

The worktree has since been removed. A sync that runs *after* removal files the events correctly, because plan 015's
lexical walk finds no `.git` in the missing directory and continues up to `agentrite`. The 42 events on desktop went
wrong because the sync timer ran while the worktree still existed.

This will keep happening: every subagent run with worktree isolation, in any repository, makes a new "project" with a
random name if a sync lands during its lifetime. The same holds for a worktree made by hand with `git worktree add`.

## What it should be

A linked worktree is a second checkout of the same repository, so its work belongs to that repository's project. The
stable identity (plan 008) is the main checkout's root.

This applies to **every** linked worktree, not only those under `.claude/worktrees/`. A hand-made
`~/projects/agentrite-hotfix` is filed under `~/projects/agentrite` too. Matching only `.claude/worktrees/` was
considered and rejected: it is the same codebase either way, and a path pattern would tie the rule to one harness.

A submodule also has a `.git` file, but it is a different repository. It stays a project of its own, as now.

## Fix

`agent/src/project.js`, `projectRootOf`. Stay filesystem-only (no `git` binary).

### Telling a linked worktree from a submodule

The `.git` file holds one line, `gitdir: <path>` (absolute, or relative to the directory holding the file). That path
is the checkout's private git directory:

| checkout        | private git dir                     | has a `commondir` file |
| --------------- | ----------------------------------- | ---------------------- |
| linked worktree | `<main>/.git/worktrees/<name>`      | yes, content `../..`   |
| submodule       | `<super>/.git/modules/<name>`       | no                     |

`commondir` is a path (relative to the private git dir, or absolute) to the repository's shared git directory. For a
worktree of a normal repository that is `<main>/.git`, and its parent directory is the main checkout.

Add a helper, `mainCheckoutOf(worktreeRoot, fs)`, that returns the main checkout's root or `null`:

1. Read `join(worktreeRoot, ".git")`. If it is a directory, unreadable, or does not start with `gitdir:` → `null`.
2. Resolve the `gitdir` path against `worktreeRoot`. Read `commondir` inside it. Missing or unreadable → `null` (this
   is the submodule case).
3. Resolve the trimmed `commondir` content against the private git dir. If the result's basename is not `.git`, or it
   is not an existing directory → `null`. (A worktree of a bare repository has no main checkout to name.)
4. Return its `dirname`.

The example from this bug:

```
worktree   /home/stef/projects/agentrite/.claude/worktrees/agent-a9ad065d34463ec7c
.git       gitdir: /home/stef/projects/agentrite/.git/worktrees/agent-a9ad065d34463ec7c
commondir  ../..  →  /home/stef/projects/agentrite/.git
main       /home/stef/projects/agentrite
```

### Using it in `projectRootOf`

Translate the path into the main checkout first, then resolve it as usual. Before the existing walk:

1. Find the nearest ancestor of `dir` (including `dir`) that holds a `.git`, with the same stop rules as the walk
   (never onto `/`, never onto `$HOME` or above).
2. If `mainCheckoutOf` returns a root `M` for it, and `M` is neither `$HOME` nor above it, replace `dir` with
   `join(M, relative(worktreeRoot, dir))`.
3. Run the existing walk on the result. Translate at most once: `M` holds a `.git` directory, so a second translation
   cannot apply.

Translating before the walk, instead of swapping the result after it, keeps `.harness-split` working. A split marker
committed in a repository is present in its worktrees as well, and the walk reaches it before it reaches the `.git`
file. Without the translation, `<worktree>/archmadness` would become a project of its own. With it, the path becomes
`<main>/archmadness` and resolves exactly like work done in the main checkout. The translated path need not exist
(a directory that only exists on the worktree's branch): the walk is lexical since plan 015.

Whenever `mainCheckoutOf` returns `null`, nothing changes: the worktree or submodule is its own project, as today.

Other details:

- The injected `fs` for tests is documented as "statSync only". It now also needs `readFileSync`. Update the JSDoc.
- The memo stays keyed on the original `dir`.
- `isProjectRoot` needs no change. A linked worktree no longer resolves to itself, so it is refused as a `--to`
  target for `retag-project.mjs`, which is right: the main checkout is the project.
- `doctor`'s "projects are repo roots" and `scripts/reroot-project.mjs` both call `projectRootOf`, so a stored
  worktree path is flagged and repaired without changes to either, whether the worktree still exists or not.
- Both extractors (`sources/claude-code.js`, `sources/opencode.js`) call `projectRootOf` and need no change.

Accepted edge: a worktree whose `.git` file points at a git directory that is gone (the main repository was moved or
deleted) stays its own project. The filesystem no longer says which repository it belonged to.

### Comments and docs that state the old rule

- `agent/src/project.js` header: "worktrees and submodules carry a `.git` file and are checkouts in their own right".
- `README.md`, "Data model" paragraph on `project`: "(a directory or a file, so worktrees and submodules count)".
- `agent/scripts/reroot-project.mjs` header: add that it also re-files events stored under a linked worktree.

### Tests (`agent/test/project.test.js`)

The `tree()` helper's `gitFile` writes `gitdir: /elsewhere`. Keep it (it is the "unresolvable" case) and add a helper
that builds a real linked-worktree shape: `<main>/.git/worktrees/<name>/commondir` containing `../..`, and a `.git`
file in the worktree pointing at that directory.

- A linked worktree's root → the main checkout's root.
- A subdirectory of a linked worktree → the main checkout's root.
- A worktree nested inside the main checkout (`<main>/.claude/worktrees/x`, the shape from this bug) → the main root.
- A relative `gitdir:` path is resolved against the worktree root.
- A linked worktree of a split container, cwd in a child → `<main>/<child>`.
- A submodule shape (private git dir exists, no `commondir`) → the submodule root, unchanged.
- A worktree of a bare repository (`commondir` resolves to a directory not named `.git`) → the worktree, unchanged.
- The existing "a .git FILE (worktree/submodule shape) counts as a root" case keeps passing: its `gitdir` target does
  not exist. Rename it to say so.
- A main checkout at `$HOME` → the worktree, unchanged.

Run `npm test` in `agent/`.

## Repair of the existing rows

On desktop the worktree is already gone, so `reroot-project.mjs` can repair the rows today, before or after the fix.
The dry run on 2026-10-04 printed:

```
42 events under 1 subdirectory project(s):
      42  /home/stef/projects/agentrite/.claude/worktrees/agent-a9ad065d34463ec7c  →  /home/stef/projects/agentrite
```

Steps, as in `agent/scripts/README.md`: stop the timer, back up the data dir, `node agent/scripts/reroot-project.mjs`
(dry run: expect that one pair), `--apply`, `harness-usage sync`, then `doctor` shows "projects are repo roots" ok and
the dashboard no longer lists `agent-a9ad065d34463ec7c`.

`retag-project.mjs` with the session ID would also work, but `reroot-project.mjs` needs no argument and moves only the
affected events. A later `backfill` does not revert this repair: re-extraction resolves the same cwd to `agentrite`,
through plan 015 while the worktree is missing and through this plan if one exists.

Run `doctor` on the Mac as well. Any worktree project there shows up under the same check and is repaired the same way.
