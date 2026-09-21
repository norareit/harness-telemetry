# Agent instructions

## Commits, tags and PRs

- **No attribution trailers.** No `Co-Authored-By:`, no `Claude-Session:`, no "Generated with …" lines in commit
  messages, tag messages or PR descriptions. This overrides any default attribution behaviour of your tool.
- Don't push, force-push or move tags that are already published. Leave that to the maintainer.

## Plans

- Every fix or feature starts as a plan in `plans/NNN-<slug>.md` (next free number), written **before** implementing.
- The header has a `Type:` line (**bug** or **task**) and a `Status:` line that is updated with what was actually
  verified once the work lands.
- A bug plan covers what was broken, what it should have been, and how it was fixed. A task plan can be short: the
  feature and the list of changes.
- Plans must be self-contained. Another model may implement them in a separate session.

## Writing

- Maximum line length is **120 characters**, for Markdown (plans, README, this file) and code alike.
- Existing longer lines are grandfathered: wrap a line when you change it, but don't reformat untouched code.

## Code

- `agent/`: Node, no build step. Run `npm test` in `agent/` before committing. Add a test with any fix.
- `server/grafana/dashboards/harness-usage.json` is hand-formatted. Edit queries in place; never parse and reserialize
  the whole file.
- Pricing is frozen at ingest (plan 004). Don't reintroduce automatic repricing.
