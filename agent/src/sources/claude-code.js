// Claude Code source — walks ~/.claude/projects/<slug>/<session>.jsonl, and the
// same tree under each extra home (plans/018).
//
// The transcripts are append-only, so each file is resumed from a stored
// (inode, byte offset) cursor. We only read whole lines: the byte offset is
// always advanced to the last newline, and a partial trailing line is left for
// the next run.
//
// Dedupe: Claude Code writes one JSONL record per content block, and every
// record of a turn repeats the same `message.usage`. Summing naively overcounts
// output tokens by ~127% and cache-creation by ~121% (measured 2026-09-09).
// Usage is byte-identical across records that share a requestId (0 conflicts
// observed), so the dedupe key is `requestId` ALONE — not (requestId,
// apiBlockIndex). We fall back to `uuid` if a record somehow lacks requestId.
//
// `model === "<synthetic>"` records (Claude Code's internal pseudo-model, e.g.
// for quota messages) are dropped — they have no price and are not real usage.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileInHome, inputsFor } from "../homes.js";
import { projectRootOf } from "../project.js";

const HARNESS = "claude-code";

export async function* extractClaudeCode({ store, config, full = false }) {
  // plans/008: file each event under the repository root of its cwd. Applied
  // here, where `config` is in hand, rather than inside parseRecord (which is
  // pure and shared with doctor). projectRootOf is a no-op when the path has no
  // .git ancestor, so pre-008 behaviour is the fallback.
  const detectRoot = config.project?.detectRoot !== false;
  // plans/018: the device's own projects root, then one per extra home.
  for (const input of inputsFor(HARNESS, config)) {
    for (const path of await transcriptsOf(input)) {
      for await (const ev of readFileIncremental({ store, path, full })) {
        // An event from a home is filed under the home's project: its cwd is a
        // path inside a container and means nothing on this device.
        if (input.home) ev.project = input.project;
        else if (detectRoot) ev.project = projectRootOf(ev.project);
        yield ev;
      }
    }
  }
}

// The transcripts to read for one input. A home's content is untrusted
// (plans/018): only regular files that really are inside the home are read, and
// a projects root that cannot be listed is skipped rather than failing the sync.
async function transcriptsOf(input) {
  if (!input.home) return listTranscripts(input.path);
  let paths;
  try {
    paths = await listTranscripts(input.path);
  } catch {
    return [];
  }
  return paths.filter((path) => fileInHome(input.home, path));
}

/**
 * Every *.jsonl transcript path under a Claude Code projects root, in readdir
 * order. A missing root is empty, not an error; an unreadable project dir is
 * skipped. Shared with `doctor` so it walks the transcripts exactly as the
 * extractor does, rather than keeping its own copy.
 */
export async function listTranscripts(root) {
  let projectDirs;
  try {
    projectDirs = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const out = [];
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const projDir = join(root, d.name);
    let files;
    try {
      files = (await readdir(projDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) out.push(join(projDir, f));
  }
  return out;
}

async function* readFileIncremental({ store, path, full }) {
  const st = await stat(path);
  const cursor = full ? null : store.getFileCursor(path);

  let startOffset = 0;
  if (cursor && cursor.inode === st.ino && cursor.offset <= st.size) {
    startOffset = cursor.offset;
  }
  if (startOffset === st.size) return; // nothing new

  const stream = createReadStream(path, { start: startOffset, encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  // Dedupe within this batch. Cross-run dupes (a turn split across two syncs)
  // are caught by the idempotent PK upsert downstream.
  const seen = new Set();
  let consumed = startOffset;
  let pendingLineBytes = 0;

  for await (const line of rl) {
    // +1 for the newline that readline stripped.
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    pendingLineBytes = lineBytes;

    const ev = parseLine(line, seen);
    consumed += lineBytes;
    if (ev) yield ev;
  }

  // If the file does not end in a newline, the last "line" may be a partial
  // record still being written. Roll the cursor back to before it.
  const endsWithNewline = await fileEndsWithNewline(path, st.size);
  let finalOffset = consumed;
  if (!endsWithNewline && pendingLineBytes > 0) {
    finalOffset = consumed - pendingLineBytes;
  }
  finalOffset = Math.min(finalOffset, st.size);

  store.setFileCursor(path, {
    inode: st.ino,
    offset: finalOffset,
    size: st.size,
  });
}

// Dedupe within a batch. Cross-run dupes are caught by the idempotent PK upsert.
function parseLine(line, seen) {
  const rec = parseRecord(line);
  if (!rec || seen.has(rec.dedupeKey)) return null;
  seen.add(rec.dedupeKey);
  return rec.event;
}

/**
 * Everything the extractor knows about one transcript line, WITHOUT the dedupe
 * step: `{ dedupeKey, model, usage, event }`, or null for a line it would
 * ignore (blank, bad JSON, non-assistant, no usage, `<synthetic>`, or no
 * requestId/uuid to dedupe on). Exported so `doctor` reads a record exactly the
 * way the extractor does, instead of re-implementing the parse and drifting
 * from it (review finding C7).
 */
export function parseRecord(line) {
  if (!line.trim()) return null;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (rec.type !== "assistant") return null;
  const msg = rec.message;
  if (!msg || !msg.usage) return null;
  if (msg.model === "<synthetic>") return null;

  const dedupeKey = rec.requestId || rec.uuid;
  if (!dedupeKey) return null;

  const u = msg.usage;
  const thinking = u.output_tokens_details?.thinking_tokens ?? 0;
  const outputTotal = u.output_tokens ?? 0;
  // Normalize: output_tokens excludes reasoning for every harness.
  const output = Math.max(0, outputTotal - thinking);

  const cc = u.cache_creation || {};
  const cw1h = cc.ephemeral_1h_input_tokens ?? 0;
  const cw5m = cc.ephemeral_5m_input_tokens ?? 0;
  // If the TTL breakdown is missing, fall back to the flat total as 5m.
  const cwFlat = u.cache_creation_input_tokens ?? 0;
  const haveBreakdown = "cache_creation" in u;

  const provider = providerOf(msg.model);

  const event = {
    harness: HARNESS,
    session_id: rec.sessionId || rec.session_id,
    message_id: dedupeKey,
    ts: rec.timestamp,
    provider,
    model: msg.model,
    agent: rec.attributionSkill || null,
    project: rec.cwd || null,
    git_branch: rec.gitBranch || null,
    is_sidechain: Boolean(rec.isSidechain),
    input_tokens: u.input_tokens ?? 0,
    output_tokens: output,
    reasoning_tokens: thinking,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cache_write_5m_tokens: haveBreakdown ? cw5m : cwFlat,
    cache_write_1h_tokens: haveBreakdown ? cw1h : 0,
  };
  return { dedupeKey, model: msg.model, usage: u, event };
}

export function providerOf(model) {
  if (!model) return null;
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3"))
    return "openai";
  return "anthropic"; // Claude Code default
}

async function fileEndsWithNewline(path, size) {
  if (size === 0) return true;
  return new Promise((resolve, reject) => {
    const s = createReadStream(path, { start: size - 1, end: size - 1 });
    let byte = null;
    s.on("data", (c) => (byte = c[0]));
    s.on("end", () => resolve(byte === 0x0a));
    s.on("error", reject);
  });
}
