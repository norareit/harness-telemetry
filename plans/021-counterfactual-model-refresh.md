# Refresh counterfactual models

Type: task
Status: Implemented on this client; 207 tests pass, scenario resolution and shipping verified. MacBook update pending.

## Goal

Add Claude Fable 5.2, replace Gemini 3.1 scenarios with Gemini 4 Hydrogen and Carbon, and replace Kimi K2.7 Code
with Kimi K3.1 Pro. Keep the other scenarios. Scenario configuration is per device, so each client needs updating.

## Changes

- Update `agent/src/config.js` defaults and `agent/config.example.json` with these catalogue keys:
  - `openrouter/anthropic/claude-fable-5.2`
  - `openrouter/google/gemini-4-hydrogen`
  - `openrouter/google/gemini-4-carbon`
  - `openrouter/moonshotai/kimi-k3.1-pro`
- Update this client's `~/.config/harness-usage/config.json` scenario list, preserving other settings.
- Document how to repeat the change on another device and check that its catalogue resolves the new models.
- Run `harness-usage doctor --only "scenarios resolve"` and `harness-usage sync` on each updated client.
  Sync computes new scenarios for all locally stored events without repricing existing valuations.
- Removed scenarios are pruned from SQLite by sync, but not from Postgres. Back up the server before removing
  retired scenario rows there, in a transaction scoped to the updated device. An unmodified client can otherwise
  keep shipping the retired scenarios. The dashboard reads scenario names dynamically.

## Verification

Run the agent unit suite, check scenario resolution, and confirm sync ships the new scenario rows successfully.
Record the actual local and server results here; another client's deployment must be verified on that client.

### Verified results

- Updated defaults, example, README, and this client's explicit scenario list.
- `npm test` in `agent/`: 207 passed, zero failures.
- `harness-usage doctor --only "scenarios resolve"`: passed for all 14 configured targets.
- `harness-usage sync`: shipped 16 events and 134,748 scenario rows, with no queued backlog.
- Each of the four new targets has 33,647 rows for this client in Postgres.
- Ran the deployed server backup script successfully before server cleanup; dump verified with 20 entries.
- Removed 67,262 retired scenario rows for this client inside a checked Postgres transaction.
  Confirmed only the 14 configured scenario names remained for this client before committing.
- The other client's rows still contain Gemini 3.1 Pro Preview and Kimi K2.7 Code; its config and deployment have
  not been accessed or changed. Follow the README's per-device procedure there, then clean up its retired server rows.
