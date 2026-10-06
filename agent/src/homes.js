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
 * A directory named twice — by two entries, or by an entry and a symlink to it
 * in another — is returned once, as the FIRST entry in the config names it.
 *
 * @returns {{home: string, project: string}[]} sorted by path. `project` is
 *   the entry's expanded override, or the home directory's own name.
 */
export function expandHomes(entries, { fs = nodeFs } = {}) {
  return byPath(homesInConfigOrder(entries, fs), (h) => h.home);
}

// Precedence is settled here, in config order, and sorting is left to the
// callers: sorting first would let an alias lose to its target merely because
// of its spelling. Within one entry the matches of a `*` are in path order.
function homesInConfigOrder(entries, fs) {
  const out = [];
  const seen = new Set();
  for (const entry of entries || []) {
    if (!entry || typeof entry.home !== "string" || !entry.home) continue;
    for (const home of expandPattern(entry.home, fs).sort()) {
      const real = realOrSame(fs, home);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push({ home, project: entry.project ? expandHome(entry.project) : basename(home) });
    }
  }
  return out;
}

function byPath(list, key) {
  return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * What one harness reads: first the device's own input (`project: null`, so
 * the repository-root rule applies), then one per home, sorted by path.
 *
 * An input whose real path equals that of an earlier one is left out. Earlier
 * means: the device's own, then the homes in CONFIG order — two distinct homes
 * can reach one file (a home inside another, linking to its database), and the
 * entry configured first is the one that keeps it. Otherwise an OpenCode
 * database reached twice would be read again under a second watermark key and
 * its events re-filed under the other name. A path that does not exist is
 * compared as written.
 *
 * A home's input that is there but not really inside its home is left out
 * BEFORE that comparison, so it can never claim a real path. Were it compared
 * first, home `a` linking its database to home `b`'s would take `b`'s place as
 * the duplicate and then be refused by the extractor — and neither would be
 * read: a sandbox could switch off another project's telemetry.
 *
 * @returns {{path: string, project: string|null, home: string|null}[]}
 */
export function inputsFor(harness, config, { fs = nodeFs } = {}) {
  const own = OWN_DEFAULT[harness](config.sources?.[harness] || {});
  const seen = new Set([realOrSame(fs, expandHome(own))]);
  const fromHomes = [];
  for (const { home, project } of homesInConfigOrder(config.homes, fs)) {
    const path = homeInputPath(harness, home);
    if (present(fs, path) && !insideHome(home, path, { fs })) continue;
    const real = realOrSame(fs, path);
    if (seen.has(real)) continue;
    seen.add(real);
    fromHomes.push({ path, project, home });
  }
  return [{ path: expandHome(own), project: null, home: null }, ...byPath(fromHomes, (i) => i.path)];
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

const TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
];
// provider and model are indexed together in Postgres, agent and git_branch
// are not: see the bounds below.
const INDEXED_LABELS = ["provider", "model"];
const PLAIN_LABELS = ["agent", "git_branch"];

// Bounds on what a home may put in an event. They are far beyond anything a
// harness writes, and exist because of what lies downstream: Postgres refuses a
// NUL in text, a key too long for its index, a cost beyond numeric(14,6) and a
// timestamp outside its range — and rows are shipped in batches, so one refused
// row blocks the shipment of all the others, on every run. A lone surrogate is
// refused here as well: it is sent as U+FFFD, so two different ids can arrive
// as one key, and Postgres rejects a batch that upserts the same key twice.
//
// The text bounds are in UTF-8 BYTES, which is what Postgres stores and what
// its limit on an index row (2704 bytes) counts; a JavaScript string's length
// counts UTF-16 units, and one of those can be three bytes. Every indexed
// column gets the same bound, so the widest index over home-supplied text —
// the primary key (harness, session_id, message_id), or (provider, model) —
// stays under a quarter of that limit. `project` and `device` are indexed too,
// but come from this device's config, not from the home.
const MAX_INDEXED_BYTES = 200;
const MAX_LABEL_BYTES = 500;
const MAX_TOKENS = 1e9; // per counter, for one API response
const MIN_TS = Date.UTC(2000, 0, 1);
const MAX_TS = Date.UTC(2100, 0, 1);

/**
 * Whether an event extracted from a home has the shape, and stays within the
 * bounds, the rest of the pipeline assumes: short text ids, a plausible
 * timestamp, text-or-null labels and token counts that are non-negative whole
 * numbers. The parsers were written for files the harnesses themselves
 * produce; a home's file may hold anything, and one event the pricing, the
 * store or Postgres refuses would stop the sync or the shipment for everything
 * else. Such an event is dropped instead. Never throws.
 */
export function wellFormed(ev) {
  if (!ev || typeof ev !== "object") return false;
  if (!text(ev.session_id, MAX_INDEXED_BYTES) || !ev.session_id) return false;
  if (!text(ev.message_id, MAX_INDEXED_BYTES) || !ev.message_id) return false;
  if (typeof ev.ts !== "string" && typeof ev.ts !== "number") return false;
  const ts = new Date(ev.ts).getTime();
  if (!(ts >= MIN_TS && ts < MAX_TS)) return false;
  for (const f of INDEXED_LABELS) if (ev[f] != null && !text(ev[f], MAX_INDEXED_BYTES)) return false;
  for (const f of PLAIN_LABELS) if (ev[f] != null && !text(ev[f], MAX_LABEL_BYTES)) return false;
  for (const f of TOKEN_FIELDS) {
    if (!Number.isSafeInteger(ev[f]) || ev[f] < 0 || ev[f] > MAX_TOKENS) return false;
  }
  return true;
}

function text(v, maxBytes) {
  // The length test first: it is cheap, and bytes are never fewer than units.
  return (
    typeof v === "string" &&
    v.length <= maxBytes &&
    v.isWellFormed() &&
    !v.includes("\u0000") &&
    Buffer.byteLength(v, "utf8") <= maxBytes
  );
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
