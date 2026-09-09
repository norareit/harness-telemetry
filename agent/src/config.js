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
