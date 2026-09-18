// Which codebase a working directory belongs to (plans/008).
//
// `project` used to be the raw cwd, and a cwd moves — Claude Code's Bash tool
// persists `cd`, so one session files turns under `harness-telemetry` and then
// `harness-telemetry/agent`, and the dashboard (which shows the basename) splits
// one repository into `harness-telemetry`, `agent`, `server`, `src`. The stable
// identity is the repository root, so resolve the cwd to it.
//
// Filesystem only, no `git` binary: the nearest ancestor holding a `.git` (a
// directory OR a file — worktrees and submodules carry a `.git` file and are
// checkouts in their own right). When there is none, or the path is gone, or the
// only `.git` sits at/above $HOME, the working directory is kept unchanged —
// that is both the asked-for fallback and the pre-plan-008 behaviour.
//
// Split containers (a repo that is one repo for convenience but several projects
// in the mind — e.g. a `janestreet/` repo holding `archmadness`, `hint-singles`,
// each a project of its own): drop an empty `.harness-split` file in the
// CONTAINER, and each of its immediate children becomes its own project instead
// of collapsing into the repo. The marker is honoured the same way `.git` is —
// on disk, so it travels with the directory across devices and needs no
// per-device config — and, being deeper than the repo's `.git`, wins for paths
// inside a child while the repo root still applies to work at the top level.

import os from "node:os";
import nodeFs from "node:fs";
import { dirname, join } from "node:path";

// Presence in a directory means "each of my immediate children is its own
// project". Content is ignored (put a comment in it explaining why it's there).
export const SPLIT_MARKER = ".harness-split";

const cache = new Map();

/**
 * @param {string|null} dir  a working directory (absolute), or null
 * @param {object} [o]
 * @param {string} [o.home]  the boundary the walk stops before (default $HOME)
 * @param {object} [o.fs]    a fs module (statSync only), for tests
 * @returns {string|null} the repository root (or split sub-project), or `dir` unchanged
 */
export function projectRootOf(dir, { home = os.homedir(), fs = nodeFs } = {}) {
  if (!dir) return dir;
  if (cache.has(dir)) return cache.get(dir);

  let result = dir;
  if (exists(fs, dir)) {
    const stop = trimSlash(home);
    let d = dir;
    // Walk up to, but never onto, the filesystem root; and never onto $HOME or
    // above it (a dotfiles repo in ~ would otherwise swallow every project).
    while (dirname(d) !== d) {
      if (trimSlash(d) === stop) break;
      // A repo root ends the walk...
      if (exists(fs, join(d, ".git"))) {
        result = d;
        break;
      }
      // ...and so does being the immediate child of a split container. Checked
      // AFTER .git at the same level, but since the container sits one level
      // ABOVE its children this is reached first for a child, so a split repo's
      // sub-projects win over the repo's own `.git`.
      const parent = dirname(d);
      if (
        parent !== d &&
        trimSlash(parent) !== stop &&
        exists(fs, join(parent, SPLIT_MARKER))
      ) {
        result = d;
        break;
      }
      d = parent;
    }
  }

  cache.set(dir, result);
  return result;
}

// The memo is process-lifetime; a run is short and the tree does not move under
// it. Tests that build and tear down temp repos clear it between cases.
projectRootOf.cache = cache;

function exists(fs, path) {
  try {
    fs.statSync(path);
    return true;
  } catch {
    return false;
  }
}

function trimSlash(p) {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}
