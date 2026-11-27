# Plan 026 — Adopt AgentRite

Type: **task**
Status: **implemented** (2026-11-27) on the desktop client, with agentrite 8.5.0. The plans were moved before the
checks below were run, since most of them need the `history-` directories. Verified:

- `npm test` in `agent/`: 269 pass, 0 fail, the same as before the change
- `npm run check-changes` exits 0 and `npx agentrite units` prints `no units`, with the history directories in place
- Plans 001 to 025 are identical to their versions on `master`, and `git log --follow` on
  `history-001-harness-usage-telemetry/plan.md` reaches its first commit, e4dad82
- `claude -p --agent specifier`, in a scratch clone of the branch, names a new unit `changes/0001-...`. It noted
  that `process.md` read literally would give 0027, and that the kit's `agentrite-units.mjs` and `AGENTS.md`
  settle it as 0001
- The `commit-msg` hook refused an empty test commit with a `Co-Authored-By:` trailer, and no commit was made
- After the review findings (see "Review findings"), on `9a5cea3`: `npm test` in `agent/` 269 pass, 0 fail, on the
  host, and the same inside the sandbox (`./sandbox.sh --in-place`, image built with `sandbox/Dockerfile`, after
  `npm ci` in `agent/`), where `command -v rsync` printed `/usr/bin/rsync`. `npm run check-changes` exits 0
- Two separate checks for C1. The kit's image without the Dockerfile has no `rsync`: the first review found it absent
  in the base image, and here `command -v rsync` found none in the AgentRite repository's own sandbox image, which
  is built on the kit's image and adds no `rsync`. The six backup tests that fail without `rsync` were reproduced by the
  first review on the host, with `rsync` taken off `PATH`, and not in the kit's image. That run was not repeated here

## The task

Work in this repository moves to AgentRite, the kit at `../agentrite` that is published on npm as `agentrite`
(8.5.0 at the time of writing). From then on a change is a unit under `changes/`, specified, planned, implemented and
reviewed by the kit's roles, and no longer a file under `plans/`.

The 26 plans written so far, this one included, are the project's history. They move to `changes/`, one directory per
plan, named `history-` followed by the plan's number and name, the way the AgentRite repository keeps the units it took
over from another project (`changes/history-0030-role-instructions/` and the others there). Their text is not changed.

This is the last plan written under the old process. It is worked as before: on the branch
`task-026-adopt-agentrite`, with commits prefixed `Plan 026:`, and moved to `changes/` itself as the last step.

## Reference

Read these in `../agentrite` (or in `node_modules/agentrite/` once installed) before starting:

- `README.md`, "Quick start"
- `SETUP.md`, "Installing it into a project", "How the kit's instructions reach an agent", "Git hooks" and
  "The project's settings"
- `process.md`, "Changes": a unit's directory is `changes/<number>-<kebab-name>/`, its number four digits, and the
  highest number in any existing change directory plus one. Directories under an older naming are allowed and left
  as they are. A `history-` directory does not start with a number, so it does not count toward the next one

## Changes

### 1. Install the kit

The repository has no `package.json` at its root; the agent's is in `agent/` and stays where it is.

- Add a root `package.json` with `"name": "harness-telemetry"`, `"private": true` and no other dependency. `init`
  refuses to run for the sandbox without a `name`
- `npm install --save-dev agentrite` at the root. Commit `package.json` and `package-lock.json`. The root
  `node_modules/` is already ignored by `.gitignore`
- `npx agentrite init claude opencode`, with the sandbox, on `master` as the default branch (the default, so no
  `--default-branch`)
- Commit what `init` wrote: `agentrite.json`, the role wrappers under `.claude/agents/` and `.opencode/agents/`,
  `.agentrite/instructions.md`, `opencode.json`, `sandbox.sh`, `sandbox/compose.project.yml`, `.dockerignore`, and the
  `check-changes` script it adds to `package.json`
- Add `.reviews/` and `.orchestrator/` to `.gitignore` if `init` did not, as the other projects using the kit do
- The `commit-msg` hook `init` writes into `.git/hooks/` is not committed (git does not track hooks). It refuses
  `Co-Authored-By` and `Claude-Session` trailers, which matches the rule this repository already has

### 2. `CLAUDE.md`

`init` leaves an existing `CLAUDE.md` untouched and names the lines it lacks. Make it hold, in this order:

```
@node_modules/agentrite/process.md
@node_modules/agentrite/standards.md
@AGENTS.md
```

### 3. `AGENTS.md`

`init` leaves an existing `AGENTS.md` untouched and prints the three sections it would have written (Development
Guidelines, Roles, Changes in this project). Paste them in at the top, and put what is in the file now under the
marked section for what is specific to the project, with these changes:

- Remove "Plans": the kit's process replaces it
- Remove from "Commits, tags and PRs" and "Writing" what the kit's `standards.md` already says, so that nothing is
  stated in both places. Keep what it does not, at least: don't push, force-push or move published tags; the
  120-character line limit with grandfathered longer lines; naming machines by role, with site-specific values as
  config or examples, never defaults
- Keep "Code" as it is. `npm test` in `agent/` needs `npm ci` in `agent/` first, in a fresh clone and in the sandbox
  alike, since the root install does not install the agent's dependencies; say so there
- Add a section on the history, in substance:

  > `changes/history-001-…` to `changes/history-026-…` are the plans written before the project used AgentRite,
  > each as the `plan.md` of its directory. They are history: they stay, and their text is not changed, also where it
  > names paths or rules that have changed since. A reference to "plan NNN" or "plans/NNN" in the code or the
  > documents means `changes/history-NNN-*`. The history directories have numbering of their own and do not count
  > toward a unit's number: the first unit under the kit is `0001`.

  This is how the AgentRite repository does it: its `changes/0001-norareit-history` came after
  `history-0030-role-instructions` and the others it copied in.

### 4. Move the plans

Once the work above is committed:

- `git mv plans/NNN-<slug>.md changes/history-NNN-<slug>/plan.md` for each plan 001 to 026, keeping the three-digit
  number and the slug as they are, e.g. `plans/004-freeze-price-at-ingest.md` becomes
  `changes/history-004-freeze-price-at-ingest/plan.md`. Use `git mv` so that `git log --follow` keeps each file's
  history. The content is not edited
- Remove `plans/review-instructions.md`, the prompt that was handed to the reviewing model. The kit's reviewer role
  replaces it, and it is not a plan. It stays findable in git history
- Remove the empty `plans/` directory

### 5. References to `plans/`

The plans' own text is left alone. Outside them:

- `README.md`: the row for `plans/` in the layout table becomes a row for `changes/`, saying that it holds the
  change units, with the history of plans 001 to 026 as `history-NNN-*`
- `AGENTS.md`: "Pricing is frozen at ingest (plan 004)" stays; the history section of step 3 says where plan 004 is
- Code comments that say `plans/NNN` (in `agent/src/`, e.g. `backup.js`, `cli.js`, `doctor.js`, `pricing.js`) may stay
  as they are: the history section makes them findable. Do not rewrite them in this plan
- `grep -rn "plans/" --exclude-dir=node_modules --exclude-dir=changes .` afterwards shows only such comments

## Verification

- `npm test` in `agent/` passes, with the same count as before the change
- `npm run check-changes` at the root exits 0 with the `history-` directories in place
- `npx agentrite units` runs and lists no open unit
- The specifier, asked for a trial unit (not committed), numbers it `0001`. If the kit counts the `history-`
  directories instead, stop and report it rather than renaming them
- `git log --follow changes/history-001-harness-usage-telemetry/plan.md` reaches the plan's first commit
- `diff` of each moved file against its version on `master` shows no difference
- `claude --agent specifier` starts in the repository and finds the kit's instructions
- A test commit with a `Co-Authored-By:` trailer is refused by the hook (then not made)

These checks run after step 4, since most of them need the `history-` directories. Record in `Status:` what was
run and the results, in the moved file.

## Review findings

The first review (of `91ce9fe`, in `.reviews/history-026-adopt-agentrite/review-91ce9fe.md`) found four things. This
unit has no `record.md`, so their outcomes are recorded here and in `Status:`. Work added for them:

- **C1** (blocking): `agent/test/backup.test.js` runs the real `rsync`, which the kit's image (`node:26-bookworm`
  with a few packages) lacks. Add `sandbox/Dockerfile`, built on `${AGENTRITE_IMAGE}` as "Adding software to the
  sandbox" of the kit's `SANDBOX.md` says, that installs `rsync` from bookworm's packages. Then run `npm ci` and
  `npm test` in `agent/` inside the project's sandbox
- **S1**: the old `AGENTS.md` also banned "Generated with …" lines and attribution in tag messages and PR
  descriptions, which the kit's standards do not cover (they cover commit trailers). Keep that part under
  "Commits, tags and PRs"
- **P1**: step 4 said to record the verification before the move, while the checks need the moved paths. Step 4 and
  "Verification" now say move first, verify second, as was done
- **P2**: a fresh clone has no `commit-msg` hook, since git does not copy hooks. Document the fresh-clone steps in
  `AGENTS.md`: `npm ci` at the root, `npx agentrite refresh` for the hook, and `npm ci` in `agent/`

Outcomes, all accepted and applied:

- **C1**: `sandbox/Dockerfile` installs `rsync`, in `9a5cea3`. The suite passes inside the sandbox, as `Status:` says
- **S1**: "Commits, tags and PRs" in `AGENTS.md` keeps the ban on "Generated with …" lines and on attribution in tag
  messages and PR descriptions, in `9a5cea3`
- **P1**: step 4 and "Verification" reworded, in `1eb254f`
- **P2**: "A fresh clone" in `AGENTS.md` gives `npm ci`, `npx agentrite refresh` and `npm ci` in `agent/`, in
  `9a5cea3`

The second review (of `93ec57c`, in `review-93ec57c.md`) found all four resolved, and one new finding:

- **P3** (non-blocking): the `Status:` entry placed the six failing backup tests in the kit's image, while the first
  review reproduced them on the host with `rsync` off `PATH`. Accepted: `Status:` now states the two checks apart
