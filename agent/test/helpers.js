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
    // catalogDb null: the CLI must not read the real OpenCode database (plan 025).
    pricing: { modelsJson: FIXTURE_MODELS, catalogDb: null, overrides: null },
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

/**
 * An OpenCode database at `path` with the tables of a given version (plan 025):
 *
 * - `v1` (default true): 1.19.6's `message` and `session`. 1.19.6 also has an
 *   EMPTY `session_message` whose foreign key is on `session`, and a
 *   `workspace` with a `branch` column. It has no `kv` table.
 * - `v2`: 2.4.2's `session_v2` and `session_message`, `workspace` without
 *   `branch`, and `kv`. With `v1` as well, this is a converted database.
 *
 * Rows: `sessions` / `messages` go to the 1.x tables, `sessionsV2` /
 * `messagesV2` to the 2.x ones, `workspaces` to `workspace`, `kv` is a
 * { key: value } map (a non-string value is JSON-encoded). `data` is JSON-
 * encoded unless it is already a string.
 */
export function openCodeDb(path, spec = {}) {
  const { v1 = true, v2 = false } = spec;
  const rollups = `tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
    tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0`;
  const db = new DatabaseSync(path);
  try {
    if (v1) {
      db.exec(`
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, workspace_id TEXT, ${rollups});
      `);
    }
    if (v2) {
      db.exec(`
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, workspace_id TEXT, ${rollups});
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
          seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE workspace (id TEXT PRIMARY KEY, provider TEXT, binding TEXT, created_at INTEGER,
          last_used_at INTEGER);
        CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL);
      `);
    } else {
      db.exec(`
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id),
          type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
          data TEXT NOT NULL);
        CREATE TABLE workspace (id TEXT PRIMARY KEY, branch TEXT, directory TEXT);
      `);
    }
    const json = (v) => (typeof v === "string" ? v : JSON.stringify(v));
    const insertSession = (tbl, s) =>
      db
        .prepare(
          `INSERT INTO ${tbl} (id, directory, parent_id, workspace_id, tokens_input, tokens_output,
             tokens_reasoning, tokens_cache_read, tokens_cache_write) VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(s.id, s.directory ?? null, s.parent_id ?? null, s.workspace_id ?? null, s.tokens_input ?? 0,
          s.tokens_output ?? 0, s.tokens_reasoning ?? 0, s.tokens_cache_read ?? 0, s.tokens_cache_write ?? 0);
    for (const s of spec.sessions || []) insertSession("session", s);
    for (const s of spec.sessionsV2 || []) insertSession("session_v2", s);
    for (const w of spec.workspaces || []) {
      db.prepare("INSERT INTO workspace (id, branch) VALUES (?, ?)").run(w.id, w.branch ?? null);
    }
    for (const m of spec.messages || []) {
      db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
        m.id, m.session_id, m.time_created ?? 0, m.time_updated ?? 0, json(m.data));
    }
    let seq = 0;
    for (const m of spec.messagesV2 || []) {
      db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)").run(
        m.id, m.session_id, m.type ?? "assistant", seq++, m.time_created ?? 0, m.time_updated ?? 0, json(m.data));
    }
    for (const [key, value] of Object.entries(spec.kv || {})) {
      db.prepare("INSERT INTO kv VALUES (?,?,?,?)").run(key, json(value), 0, spec.kvTimeUpdated ?? 0);
    }
  } finally {
    db.close();
  }
  return path;
}

/** The assistant `data` of a 1.x message; override anything. */
export const ocData1 = (over = {}) => ({
  role: "assistant",
  providerID: "openai",
  modelID: "gpt-6.2-sol",
  agent: "build",
  time: { created: 1795000000000, completed: 1795000003000 },
  tokens: { total: 1165, input: 100, output: 10, reasoning: 5, cache: { read: 1000, write: 50 } },
  ...over,
});

/** The same message as 2.4.2 stores it: model nested, no role, no tokens.total. */
export const ocData2 = (over = {}) => ({
  agent: "build",
  model: { providerID: "openai", id: "gpt-6.2-sol", variant: "high" },
  finish: "stop",
  cost: 0,
  time: { created: 1795000000000, completed: 1795000003000 },
  tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 1000, write: 50 } },
  ...over,
});

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
