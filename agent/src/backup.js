// Database backups, client side (plans/019). The server dumps Postgres every
// night with server/backup/backup.sh; a client pulls those dumps with rsync so a
// copy survives the server's disk. Nothing here talks to Postgres.

import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, readSync, closeSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, expandHome } from "./config.js";

// backup.sh names dumps harness-telemetry-<UTC timestamp>.dump, so sorting the
// names sorts by time.
const DUMP = /^harness-telemetry-.*\.dump$/;

// pg_dump's custom format (-Fc) starts with these five bytes.
const MAGIC = "PGDMP";

/** Where this device keeps pulled dumps. */
export function backupDir(config) {
  return expandHome(config.backup?.dir) || join(DATA_DIR, "db-backups");
}

/** The dump file names in `dir`, oldest first. A missing dir has none. */
export function listDumps(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return names.filter((n) => DUMP.test(n)).sort();
}

/** The newest dump in `dir` as { name, mtimeMs }, or null. */
export function newestDump(dir) {
  const name = listDumps(dir).at(-1);
  return name ? { name, mtimeMs: statSync(join(dir, name)).mtimeMs } : null;
}

/**
 * Pull new dumps from `backup.source` into the backup dir, check them, prune.
 * Throws when rsync fails or a pulled file is not a dump — the systemd unit
 * retries on a non-zero exit.
 */
export function pullBackups(config, { rsync = "rsync" } = {}) {
  const { source, keep = 60 } = config.backup || {};
  if (!source) throw new Error("backup.source is not set");
  const dir = backupDir(config);
  mkdirSync(dir, { recursive: true });

  const before = new Set(listDumps(dir));
  // -a keeps the server's mtime, so a file's age is the dump's age, not the
  // pull's. No --delete: the client keeps more dumps than the server does.
  const res = spawnSync(
    rsync,
    [
      "-a",
      "-e",
      "ssh -o BatchMode=yes -o ConnectTimeout=20",
      "--include=harness-telemetry-*.dump",
      "--exclude=*",
      source,
      dir + "/",
    ],
    { encoding: "utf8" },
  );
  if (res.error) throw new Error(`cannot run ${rsync}: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`rsync exited ${res.status}: ${(res.stderr || "").trim() || "no output"}`);
  }

  const pulled = [];
  const bad = [];
  for (const name of listDumps(dir)) {
    if (before.has(name)) continue;
    if (hasMagic(join(dir, name))) pulled.push(name);
    else {
      unlinkSync(join(dir, name));
      bad.push(name);
    }
  }

  const all = listDumps(dir);
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const name of removed) unlinkSync(join(dir, name));

  if (bad.length) {
    throw new Error(`deleted ${bad.length} pulled file(s) that are not pg_dump output: ${bad.join(", ")}`);
  }
  return { dir, pulled, removed, newest: all.at(-1) ?? null };
}

function hasMagic(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(MAGIC.length);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("latin1", 0, n) === MAGIC;
  } finally {
    closeSync(fd);
  }
}
