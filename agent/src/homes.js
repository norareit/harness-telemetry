// Extra homes (plans/018) — the one place that turns config into things to read.
//
// The agent reads the harness files of the user who runs it (`sources`). A
// harness that runs with another home — in a container whose home is mounted
// from the host, under a second CLAUDE_CONFIG_DIR, in a directory synced from
// another machine — is listed under `homes`, and every event from such a home
// is filed under one project name: its working directories are paths that mean
// nothing on this device.
//
// A home may be written by a sandboxed agent, so its content is untrusted. The
// sandbox can write only inside its own home, which makes a symlink its one way
// to have the agent read a file it cannot touch itself (the user's own
// transcripts, another home's database). Hence the rule: a file is read from a
// home only when its REAL path lies inside that home, and it is a regular file.

import nodeFs from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { expandHome } from "./config.js";

// Where each harness keeps its files, relative to a home.
const LAYOUT = {
  "claude-code": [".claude", "projects"],
  opencode: [".local", "share", "opencode", "opencode.db"],
};

const OWN_DEFAULT = {
  "claude-code": (src) => src.root || "~/.claude/projects",
  opencode: (src) => src.db || "~/.local/share/opencode/opencode.db",
};

/** The path of one harness's input (projects root or database) under a home. */
export function homeInputPath(harness, home) {
  return join(home, ...LAYOUT[harness]);
}

/**
 * Resolve the `homes` config entries to directories.
 *
 * `~` is expanded, and a path segment that is exactly `*` matches every
 * directory at that level (a symlink to a directory is not one). An entry
 * without `*` is returned whether or not it exists, so `doctor` can report it
 * missing; an entry with `*` yields only directories that are there.
 *
 * @returns {{home: string, project: string}[]} sorted by path, each path once
 *   (the first entry that names it wins). `project` is the entry's expanded
 *   override, or the home directory's own name.
 */
export function expandHomes(entries, { fs = nodeFs } = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of entries || []) {
    if (!entry || typeof entry.home !== "string" || !entry.home) continue;
    for (const home of expandPattern(entry.home, fs)) {
      if (seen.has(home)) continue;
      seen.add(home);
      out.push({ home, project: entry.project ? expandHome(entry.project) : basename(home) });
    }
  }
  return out.sort((a, b) => (a.home < b.home ? -1 : a.home > b.home ? 1 : 0));
}

/**
 * What one harness reads: first the device's own input (`project: null`, so
 * the repository-root rule applies), then one per home.
 *
 * An input whose real path equals that of an earlier one is left out: the
 * device's own wins over a home that resolves to it, and the first wins among
 * homes. Otherwise an OpenCode database reached twice would be read again under
 * a second watermark key and its events re-filed under the home's name. A path
 * that does not exist is compared as written.
 *
 * @returns {{path: string, project: string|null, home: string|null}[]}
 */
export function inputsFor(harness, config, { fs = nodeFs } = {}) {
  const own = OWN_DEFAULT[harness](config.sources?.[harness] || {});
  const inputs = [{ path: expandHome(own), project: null, home: null }];
  for (const { home, project } of expandHomes(config.homes, { fs })) {
    inputs.push({ path: homeInputPath(harness, home), project, home });
  }

  const seen = new Set();
  return inputs.filter((input) => {
    const real = realOrSame(fs, input.path);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/**
 * Whether `path` really is in `home`: its real path (every symlink followed)
 * is the home's real path or lies under it. False when either cannot be
 * resolved.
 */
export function insideHome(home, path, { fs = nodeFs } = {}) {
  try {
    const h = fs.realpathSync(home);
    const p = fs.realpathSync(path);
    return p === h || p.startsWith(h.endsWith(sep) ? h : h + sep);
  } catch {
    return false;
  }
}

/**
 * Whether `path` may be read as a file of `home`: inside it, and a regular
 * file. A directory or a FIFO with a transcript's name would fail or block the
 * read.
 */
export function fileInHome(home, path, { fs = nodeFs } = {}) {
  if (!insideHome(home, path, { fs })) return false;
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether a home's SQLite database may be opened: the database is a file of
 * the home, and so are the `-wal` and `-shm` files beside it when they exist —
 * SQLite opens those too.
 */
export function databaseInHome(home, dbPath, { fs = nodeFs } = {}) {
  if (!fileInHome(home, dbPath, { fs })) return false;
  for (const suffix of ["-wal", "-shm"]) {
    const side = dbPath + suffix;
    if (present(fs, side) && !fileInHome(home, side, { fs })) return false;
  }
  return true;
}

// One `homes` path to the directories it names. Literal segments before the
// first `*` are taken as written; after it, only what exists is kept.
function expandPattern(pattern, fs) {
  let dirs = [sep];
  let globbed = false;
  for (const seg of resolve(expandHome(pattern)).split(sep).filter(Boolean)) {
    const next = [];
    for (const d of dirs) {
      if (seg === "*") {
        for (const name of subdirectories(fs, d)) next.push(join(d, name));
      } else if (!globbed || isDirectory(fs, join(d, seg))) {
        next.push(join(d, seg));
      }
    }
    if (seg === "*") globbed = true;
    dirs = next;
  }
  return dirs;
}

function subdirectories(fs, dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// lstat, not stat: a symlink to a directory is not a match.
function isDirectory(fs, path) {
  try {
    return fs.lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Whether a directory entry is there at all, a dangling symlink included.
function present(fs, path) {
  try {
    fs.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function realOrSame(fs, path) {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}
