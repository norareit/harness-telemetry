# Development Guidelines

How work is done here is not specific to this project. It lives in AgentRite, installed as the npm package
`agentrite`, and the files [`.agentrite/instructions.md`](.agentrite/instructions.md) names are **required reading**
before any change: the kit's `process.md`, the project's standards, and the file of each role. `process.md` holds the
changes process in `changes/`, the status progression and the freeze, and the commit prefixes; the standards hold the
rules on text, documentation, commits, code and tests. The kit writes the list from `agentrite.json`. This file holds
only what is specific to this project, and nothing is stated in both places.

Read [README.md](README.md) before making changes. It is the source of truth for the project itself.

The kit is a dependency: `npm ci` installs it, on the host or inside the sandbox, and moving to a newer release is a
change to `package.json` and `package-lock.json`. An improvement to it is made in the kit repository, never under
`node_modules/`.

## Roles

[`.agentrite/instructions.md`](.agentrite/instructions.md) names the file of each of the four roles that do the work
in `changes/`. The harnesses reach them through the role wrappers in these directories. Each wrapper is a pointer to
one role file and holds no instructions of its own:

* `.claude/agents/`
* `.opencode/agents/`

## Changes in this project

The change check is `npm run check-changes`, which runs the kit's script.

## Specific to this project

### History

`changes/history-001-…` to `changes/history-026-…` are the plans written before the project used AgentRite, each as
the `plan.md` of its directory. They are history: they stay, and their text is not changed, also where it names paths
or rules that have changed since. A reference to "plan NNN" or "plans/NNN" in the code or the documents means
`changes/history-NNN-*`.

The history directories have numbering of their own and do not count toward a unit's number: the first unit under
the kit is `0001`.

### Commits, tags and PRs

- Don't push, force-push or move tags that are already published. Leave that to the maintainer.

### Writing

- Maximum line length is **120 characters**, for Markdown (specs, plans, records, README, this file) and code alike.
- Existing longer lines are grandfathered: wrap a line when you change it, but don't reformat untouched code.
- The project is public. In units, README and code, name machines by role (**server**, **client**/**device**), not by
  the maintainer's host names or hardware. Site-specific values (hosts, paths, times) are config or examples, never
  defaults.
  - A unit's `record.md` may name the machine where something was verified: it records what happened.
  - The history plans are left as they are.

### Code

- `agent/`: Node, no build step. Run `npm test` in `agent/` before committing. Add a test with any fix. The root
  install does not install the agent's dependencies: run `npm ci` in `agent/` first, in a fresh clone and in the
  sandbox alike.
- `server/grafana/dashboards/harness-usage.json` is hand-formatted. Edit queries in place; never parse and reserialize
  the whole file.
- Pricing is frozen at ingest (plan 004). Don't reintroduce automatic repricing.
