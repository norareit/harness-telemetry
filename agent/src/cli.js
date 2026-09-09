#!/usr/bin/env node
// harness-usage — per-device telemetry agent.
//
//   sync       incremental extract -> local JSONL archive -> Postgres upsert
//   backfill   ignore cursors, re-scan everything, drain the whole outbox
//   show       print the local summary (totals, per-model, unsynced backlog)
//   doctor     preflight + regression checks
//
// Short-lived: it wakes, syncs, exits. A missed run is harmless — the next one
// just has more to do.

import { runSync } from "./sync.js";
import { runDoctor } from "./doctor.js";
import { LocalStore } from "./local-store.js";
import { loadConfig, CONFIG_PATH } from "./config.js";

const [cmd, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));

try {
  switch (cmd) {
    case "sync":
      await cmdSync({ full: false });
      break;
    case "backfill":
      await cmdSync({ full: true });
      break;
    case "show":
      await cmdShow();
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "-h":
    case "--help":
    case undefined:
      usage();
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      usage();
      process.exit(2);
  }
} catch (err) {
  console.error(`harness-usage ${cmd}: ${err.stack || err.message}`);
  process.exit(1);
}

async function cmdSync({ full }) {
  const r = await runSync({ full, noShip: flags.has("--no-ship") });
  const label = full ? "backfill" : "sync";
  const parts = Object.entries(r.extracted)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(
    `${label} [${r.device}] extracted { ${parts} }  ` +
      `recorded new=${r.recorded.new} changed=${r.recorded.changed} unchanged=${r.recorded.unchanged}`,
  );
  if (r.unpriced.length) {
    console.log(`  unpriced models: ${r.unpriced.join(", ")}`);
  }
  if (r.shipError) {
    console.log(`  ship: FAILED (${r.shipError}); ${r.unsynced} rows queued locally`);
    process.exitCode = 3;
  } else if (r.shipped) {
    console.log(`  ship: ${r.shipped} rows upserted to Postgres; backlog clear`);
  } else {
    console.log(`  ship: nothing to send`);
  }
}

async function cmdShow() {
  const store = new LocalStore();
  try {
    const s = store.summary();
    console.log("Harness usage — local archive\n");
    for (const t of s.totals) {
      console.log(
        `  ${t.harness.padEnd(12)} ${String(t.events).padStart(6)} events  ` +
          `${String(t.unsynced).padStart(5)} unsynced  ${t.first_ts?.slice(0, 10)} .. ${t.last_ts?.slice(0, 10)}`,
      );
    }
    console.log(
      `\n  total: ${s.totalEvents} events, ${s.totalUnsynced} unsynced, ` +
        `$${(s.totalCost || 0).toFixed(2)} (potential) cost\n`,
    );
    console.log("  by model:");
    for (const m of s.byModel) {
      console.log(
        `    ${String(m.provider || "?") + "/" + String(m.model || "?")}`.padEnd(34) +
          `${String(m.events).padStart(6)} ev  ` +
          `${fmtTokens(m.tokens).padStart(9)} tok  ` +
          `$${(m.cost_usd || 0).toFixed(4)}`,
      );
    }
  } finally {
    store.close();
  }
}

async function cmdDoctor() {
  const config = await loadConfig();
  console.log(`harness-usage doctor  (config: ${config._path || `${CONFIG_PATH} [missing]`})\n`);
  const checks = await runDoctor();
  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? "ok  " : "FAIL";
    if (!c.ok) failed++;
    console.log(`  [${mark}] ${c.name}`);
    if (c.detail) console.log(`         ${c.detail}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed) process.exit(1);
}

function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function usage() {
  console.log(`harness-usage <command> [--flags]

  sync              incremental extract -> local archive -> Postgres
  backfill          re-scan everything (ignores cursors), drain the outbox
  show              print the local summary
  doctor            preflight + regression checks

  --no-ship         sync/backfill: write the local archive only, skip Postgres

config: ${CONFIG_PATH}`);
}
