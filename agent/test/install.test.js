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
