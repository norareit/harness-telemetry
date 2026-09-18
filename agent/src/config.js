// Config loading. The real config lives at ~/.config/harness-usage/config.json
// (per-device: DSN, device name, which sources are enabled) and is never
// committed. config.example.json in this repo documents the shape.

import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH =
  process.env.HARNESS_USAGE_CONFIG ||
  join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "harness-usage",
    "config.json",
  );

export const DATA_DIR =
  process.env.HARNESS_USAGE_DATA_DIR ||
  join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "harness-usage",
  );

const DEFAULTS = {
  device: hostname().split(".")[0],
  postgres: { dsn: null, connectionTimeoutMillis: 10000, statementTimeoutMillis: 30000 },
  sources: {
    "claude-code": {
      enabled: true,
      root: "~/.claude/projects",
      billing: "free",
    },
    opencode: {
      enabled: true,
      db: "~/.local/share/opencode/opencode.db",
      billing: "free",
    },
  },
  pricing: {
    modelsJson: "~/.cache/opencode/models.json",
    overrides: null, // defaults to bundled pricing-overrides.json
  },
  // Project identity (plans/008). true = file each event under the nearest
  // `.git` ancestor of its working directory (so subdirectories of one repo
  // collapse into it); false = the working directory itself (pre-plan-008).
  project: { detectRoot: true },
  // Liveness (plans/007). doctor's "last sync" / "last ship" checks fail once
  // the agent has not run to completion within this many minutes. 60 is
  // generous against desktop's 5-minute timer; a laptop that sleeps overnight
  // wants a larger value (or legitimately fails doctor the next morning).
  sync: { staleAfterMinutes: 60 },
  // Counterfactual targets materialized into Postgres for the dashboard
  // (plans/002). Defaulted rather than left empty so an existing config.json
  // written before this feature still gets scenarios. Set to [] to opt out.
  // `harness-usage compare --as <key>` is not limited to this list.
  scenarios: [
    "openrouter/anthropic/claude-opus-5",
    "openrouter/anthropic/claude-sonnet-5",
    "openrouter/openai/gpt-6-astra",
    "openrouter/google/gemini-3.1-pro-preview",
    "openrouter/qwen/qwen3.7-flash",
    "openrouter/moonshotai/kimi-k2.7-code",
    "tokengo/z-ai/glm-5.2",
  ],
};

export async function loadConfig() {
  let raw = {};
  let path = CONFIG_PATH;
  try {
    raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    path = null; // running on defaults
  }

  const cfg = deepMerge(structuredClone(DEFAULTS), raw);
  cfg._path = path;
  return cfg;
}

/** Expand a leading ~ or ~/ to the user's home directory. */
export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
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
