// Which codebase a working directory belongs to (plans/008).
//
// `project` used to be the raw cwd, and a cwd moves — Claude Code's Bash tool
// persists `cd`, so one session files turns under `harness-telemetry` and then
// `harness-telemetry/agent`, and the dashboard (which shows the basename) splits
// one repository into `harness-telemetry`, `agent`, `server`, `src`. The stable
// identity is the repository root, so resolve the cwd to it.
//
// Filesystem only, no `git` binary: the nearest ancestor holding a `.git` (a
// directory OR a file — a submodule carries a `.git` file and is a repository
// in its own right). When there is none, or the only `.git` sits
// at/above $HOME, the working directory is kept unchanged — that is both the
// asked-for fallback and the pre-plan-008 behaviour. A path that is gone (another
// branch checked out, a deleted dir) still resolves to an existing repo above it
// (plans/015); with no `.git` above it, it too is kept unchanged.
//
// Linked worktrees (plans/017) also carry a `.git` file, but they are a second
// checkout of the SAME repository — Claude Code makes one per isolated subagent
// under `<repo>/.claude/worktrees/agent-<id>`, and each would otherwise show up
// as a project with a random name. A path inside one is first translated to the
// same path in the main checkout, and then resolved as usual.
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
import { basename, dirname, join, relative, resolve } from "node:path";

// Presence in a directory means "each of my immediate children is its own
// project". Content is ignored (put a comment in it explaining why it's there).
export const SPLIT_MARKER = ".harness-split";

const cache = new Map();

/**
 * @param {string|null} dir  a working directory (absolute), or null
 * @param {object} [o]
 * @param {string} [o.home]  the boundary the walk stops before (default $HOME)
 * @param {object} [o.fs]    a fs module (statSync and readFileSync), for tests
 * @returns {string|null} the repository root (or split sub-project), or `dir` unchanged
 */
export function projectRootOf(dir, { home = os.homedir(), fs = nodeFs } = {}) {
  if (!dir) return dir;
  if (cache.has(dir)) return cache.get(dir);

  const stop = trimSlash(home);
  // plans/017: resolve a path inside a linked worktree as the same path in the
  // main checkout. Done BEFORE the walk, not to its result, so that a split
  // marker checked out in the worktree can't claim the path first.
  let d = inMainCheckout(dir, stop, fs);
  let result = d;
  // The walk is lexical, so it also runs for a path that is missing right now
  // (plans/015): a branch switch can remove the cwd before the sync runs, and a
  // missing directory can't produce a false `.git` or marker hit.
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

  cache.set(dir, result);
  return result;
}

/**
 * Whether `dir` is a project root in its own right: it exists, holds a `.git` or
 * is the immediate child of a split container (under the same $HOME boundary as
 * projectRootOf), and resolves to itself. Unlike `projectRootOf(dir) === dir`,
 * this is false for a mistyped path or a plain directory — projectRootOf returns
 * those unchanged. For validating a user-given target project (plans/014).
 *
 * @param {string|null} dir  an absolute path, without a trailing slash
 * @param {object} [o]  as for projectRootOf
 * @returns {boolean}
 */
export function isProjectRoot(dir, { home = os.homedir(), fs = nodeFs } = {}) {
  if (!dir || !exists(fs, dir)) return false;
  const stop = trimSlash(home);
  const parent = dirname(dir);
  if (trimSlash(dir) === stop) return false;
  const marked =
    exists(fs, join(dir, ".git")) ||
    (parent !== dir && trimSlash(parent) !== stop && exists(fs, join(parent, SPLIT_MARKER)));
  return marked && projectRootOf(dir, { home, fs }) === dir;
}

// The memo is process-lifetime; a run is short and the tree does not move under
// it. Tests that build and tear down temp repos clear it between cases.
projectRootOf.cache = cache;

// `dir` moved from a linked worktree into its main checkout, or `dir` itself
// when its nearest `.git` (same stop rules as the walk) is anything else. The
// result need not exist — a directory only on the worktree's branch — which
// the lexical walk allows (plans/015).
function inMainCheckout(dir, stop, fs) {
  for (let d = dir; dirname(d) !== d && trimSlash(d) !== stop; d = dirname(d)) {
    if (!exists(fs, join(d, ".git"))) continue;
    const main = mainCheckoutOf(d, fs);
    if (!main || main === stop || stop.startsWith(main.endsWith("/") ? main : main + "/")) return dir;
    return join(main, relative(d, dir));
  }
  return dir;
}

// The main checkout a linked worktree belongs to, or null when `root` is not
// one. A worktree's `.git` file names its private git dir
// (`<main>/.git/worktrees/<name>`), whose `commondir` file points at the shared
// `<main>/.git`. A submodule's git dir has no `commondir`, and a worktree of a
// bare repository has a common dir that is not a `.git` — neither has a main
// checkout to name, and nor does a worktree whose repository is gone.
function mainCheckoutOf(root, fs) {
  try {
    const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(join(root, ".git"), "utf8"));
    if (!gitdir) return null;
    const own = resolve(root, gitdir[1].trim());
    const common = resolve(own, fs.readFileSync(join(own, "commondir"), "utf8").trim());
    if (basename(common) !== ".git" || !fs.statSync(common).isDirectory()) return null;
    return dirname(common);
  } catch {
    return null;
  }
}

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
