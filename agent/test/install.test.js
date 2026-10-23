// install.test.js — invariants of the shipped systemd units (plans/012).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function section(path, name) {
  const lines = readFileSync(new URL(path, import.meta.url), "utf8").split("\n");
  const out = {};
  let inside = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) inside = line === `[${name}]`;
    else if (inside && line && !line.startsWith("#")) {
      const [key, ...rest] = line.split("=");
      out[key.trim()] = rest.join("=").trim();
    }
  }
  return out;
}

test("timer's first run is relative to the user manager's start, not kernel boot", () => {
  const timer = section("../install/harness-usage.timer", "Timer");
  // OnBootSec counts from kernel boot. A login more than that long after boot leaves the timer with no
  // next elapse for the whole session (2026-09-25).
  assert.equal(timer.OnBootSec, undefined);
  assert.ok(timer.OnStartupSec, "OnStartupSec must arm the first run");
  assert.ok(timer.OnUnitActiveSec, "OnUnitActiveSec must repeat the run");
  // Persistent= only affects OnCalendar=, so on its own it only suggests a catch-up that never happens.
  if (timer.Persistent) assert.ok(timer.OnCalendar, "Persistent= without OnCalendar= does nothing");
});

// plans/019: the backup timers run daily, and catch up a missed run when the timer next starts (the server after a
// reboot, a client at the next login). That catch-up is what Persistent= does, and it needs OnCalendar=.
for (const path of ["../install/harness-db-pull.timer", "../../server/backup/harness-db-backup.timer"]) {
  test(`${path.split("/").at(-1)} runs daily and catches up a missed run`, () => {
    const timer = section(path, "Timer");
    assert.ok(timer.OnCalendar, "OnCalendar must schedule the run");
    assert.match(timer.OnCalendar, /^\*-\*-\* \d\d:\d\d$/, "local time, no time zone suffix");
    assert.equal(timer.Persistent, "true");
    assert.equal(timer.OnBootSec, undefined);
  });
}

test("the pull retries when the server is unreachable, a bounded number of times", () => {
  const service = section("../install/harness-db-pull.service", "Service");
  const unit = section("../install/harness-db-pull.service", "Unit");
  assert.equal(service.Type, "oneshot");
  assert.equal(service.Restart, "on-failure");
  assert.ok(service.RestartSec, "RestartSec must space the retries");
  assert.ok(unit.StartLimitIntervalSec && unit.StartLimitBurst, "the retries must be bounded");
  assert.match(service.ExecStart, /\/agent\/bin\/harness-usage pull-backup$/, "through the wrapper, never node");
});
