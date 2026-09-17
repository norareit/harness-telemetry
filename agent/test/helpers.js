// Shared test helpers. No test reads the real ~/.cache, ~/.claude,
// ~/.local/share/opencode or the real config — each is given a synthetic table
// object or pointed at a fixture through HARNESS_USAGE_CONFIG /
// HARNESS_USAGE_DATA_DIR.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = join(HERE, "..", "src", "cli.js");
export const FIXTURE_MODELS = join(HERE, "fixtures", "models.json");

/**
 * Build a models.json-shaped object from a flat { "provider/model": cost } map,
 * so each test's rate card stays visible in the test itself. The provider is
 * the first path segment; the rest is the model key (matching buildIndex).
 */
export function table(entries) {
  const out = {};
  for (const [key, cost] of Object.entries(entries)) {
    const slash = key.indexOf("/");
    const provider = key.slice(0, slash);
    const model = key.slice(slash + 1);
    out[provider] ??= { models: {} };
    out[provider].models[model] = { cost };
  }
  return out;
}

/** A canonical event with every token count at 0. Override anything. */
export function event(overrides = {}) {
  return {
    harness: "claude-code",
    device: "testdev",
    session_id: "s1",
    message_id: "m1",
    ts: "2026-09-01T10:00:00Z",
    provider: "anthropic",
    model: "claude-sonnet-5",
    agent: null,
    project: "/p",
    git_branch: null,
    is_sidechain: false,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    ...overrides,
  };
}

/**
 * A throwaway working area: its own data dir, config file and Claude Code
 * transcript tree, plus a `run` that spawns the real CLI against them. Nothing
 * touches the user's home.
 */
export function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  const dataDir = join(dir, "data");
  const configPath = join(dir, "config.json");
  const ccRoot = join(dir, "cc");
  mkdirSync(join(ccRoot, "proj"), { recursive: true });

  const defaults = {
    device: "testdev",
    postgres: { dsn: null },
    sources: {
      "claude-code": { enabled: true, root: ccRoot, billing: "free" },
      opencode: { enabled: false },
    },
    pricing: { modelsJson: FIXTURE_MODELS, overrides: null },
    scenarios: [],
  };

  function writeConfig(obj = {}) {
    const merged = deepMerge(structuredClone(defaults), obj);
    writeFileSync(configPath, JSON.stringify(merged, null, 2));
    return merged;
  }
  writeConfig(); // a usable config exists even if a test never calls it

  function writeOverrides(overrides) {
    const p = join(dir, "overrides.json");
    writeFileSync(p, JSON.stringify({ overrides }, null, 2));
    return p;
  }

  function writeTranscript(lines) {
    const p = join(ccRoot, "proj", "sess1.jsonl");
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return p;
  }

  function run(...argv) {
    const res = spawnSync(process.execPath, ["--no-warnings", CLI, ...argv], {
      env: {
        ...process.env,
        HARNESS_USAGE_CONFIG: configPath,
        HARNESS_USAGE_DATA_DIR: dataDir,
        NODE_NO_WARNINGS: "1",
      },
      encoding: "utf8",
    });
    return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
  }

  function cleanup() {
    rmSync(dir, { recursive: true, force: true });
  }

  return {
    dir,
    dataDir,
    configPath,
    ccRoot,
    writeConfig,
    writeOverrides,
    writeTranscript,
    run,
    cleanup,
  };
}

/** Parsed outbox event payloads, with pk + synced attached, ordered by ts. */
export function readOutbox(dataDir) {
  const db = new DatabaseSync(join(dataDir, "state.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT pk, synced, payload FROM outbox ORDER BY ts")
      .all()
      .map((r) => ({ pk: r.pk, synced: r.synced, ...JSON.parse(r.payload) }));
  } finally {
    db.close();
  }
}

/** Parsed scenario payloads, with pk + scenario + synced attached. */
export function readScenarios(dataDir) {
  const db = new DatabaseSync(join(dataDir, "state.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT pk, scenario, synced, payload FROM outbox_scenario")
      .all()
      .map((r) => ({
        pk: r.pk,
        scenario: r.scenario,
        synced: r.synced,
        ...JSON.parse(r.payload),
      }));
  } finally {
    db.close();
  }
}

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      base[k] = deepMerge(base[k] && typeof base[k] === "object" ? base[k] : {}, v);
    } else {
      base[k] = v;
    }
  }
  return base;
}
