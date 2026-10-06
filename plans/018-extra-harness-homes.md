# Plan 018 — Extra harness homes

Type: **task**
Status: **planned** (2026-10-06). Not implemented, nothing verified.
Builds on 001–017.

## Feature

The agent reads one Claude Code projects directory and one OpenCode database: those of the user who runs it. A
harness that runs with another home is invisible. The case that prompted this: harnesses run in a container whose
home is a Docker volume (the AgentRite sandbox, one volume per project). On 2026-10-06 the desktop had five such
volumes holding six Claude Code transcripts and two OpenCode databases, none of them in Postgres.

Two things are in the way, and this plan removes both:

1. **One path per harness.** `sources["claude-code"].root` and `sources.opencode.db` each name a single location.
2. **The project is a path that does not exist here.** Every session in such a container runs in `/work`, so
   `project` would be `/work` for all of them, whatever project they belong to.

Add a list of **extra homes** to the config. A home is a directory laid out like a user's home. The agent reads both
harnesses' files under it, and files every event from it under one project name.

How the files get to a readable place is not this project's concern. AgentRite's side is its change unit
`0035-harness-logs-on-the-host`: each project's sandbox writes its logs to `~/.local/share/agentrite/<name>/`, where
`<name>` is the project root's directory name. Nothing in this repository names AgentRite outside the example config
and one README sentence. The feature serves any second home: a devcontainer, a second `CLAUDE_CONFIG_DIR`, a
directory synced from another machine.

### Config

```json
"homes": [
  { "home": "~/.local/share/agentrite/*" },
  { "home": "~/backup/laptop-home", "project": "~/projects/finrite" }
]
```

- `homes` defaults to `[]`. A config without it behaves exactly as before.
- `home`: a path. `~` is expanded. A path segment that is exactly `*` matches every directory at that level
  (symlinks to directories are not followed). No other wildcard syntax.
- Under each resulting directory the agent looks for `.claude/projects` and `.local/share/opencode/opencode.db`. A
  missing one is skipped without an error, like a missing `sources` path today.
- `project`, optional: what every event from this entry is filed under. `~` is expanded, so it can be the real path
  of the project on this device, which makes the rows identical to host rows. Default: the home directory's own
  name, so `~/.local/share/agentrite/norareit` gives `norareit`.
- `sources.<harness>.enabled` and `.billing` apply to the homes as well. There is no per-home billing.

`sources` itself does not change. It stays the device's own home and keeps the project rule of plans 008, 015 and
017.

### Project identity

For an event from a home, `project` is the entry's project name and `projectRootOf` is not called: the recorded
working directory is a path inside a container and means nothing on this device. `git_branch` is kept as recorded.

A name is not a path. The dashboard already shows `regexp_replace(project, '^.*/', '')`, so `norareit` and
`/home/stef/projects/norareit` appear under one name in every panel that groups by that expression. The scenario
table (the `DISTINCT ON (project)` query) groups by the raw value and will show the name twice. It already does that
for one project seen from two devices with different home paths (plan 013 noted it), and it is left as it is. Setting
`project` to the real path avoids it.

No schema change, no archive format change, no new column. `device` is the device that runs the agent.

### Untrusted input

A home may be written by a sandboxed agent, so its content is data from a party that may be hostile. The parsers
already ignore what they do not understand, and Postgres only receives parameters. What such a home can do is
invent usage for its own project. Two rules keep it to that:

- A file is read from a home only when it really is in that home: its real path (`realpath`, which follows every
  symlink) must lie under the home's real path. Anything else is skipped. The sandbox can write only inside its own
  home, so a symlink is its one way to make the agent read a file it cannot touch itself: your own transcripts,
  another home's database, an old copy elsewhere on disk. Those hold real session and message ids, and reading
  them through the link would re-file the real events under this home's name. The rule applies to each transcript
  and to the OpenCode database with its `-wal` and `-shm` files, and it catches a link at any level (the file, the
  project directory, `.claude/projects`, `.claude`).
- The OpenCode database is opened read-only, as today.

Known limit: the check and the read are two steps. A sandbox that runs during a sync could replace a file by a
symlink in between. Closing that would mean copying every file out of the home before reading it, which is not
done.

Accepted risk: the event key is `(harness, session_id, message_id)`, without project or device. A home that
presents a session id and message id of an existing event overwrites that event. The ids are not guessable, and
with the rule above a sandbox cannot make the agent read those of other projects, so nothing more is done about it.

## Changes

- `agent/src/config.js`: add `homes: []` to `DEFAULTS`. Arrays are replaced, not merged, by `deepMerge`, which is
  what is wanted.
- `agent/src/homes.js` (new): the one place that turns config into things to read.
  - `expandHomes(entries, { fs })` resolves the `*` segments and returns `[{ home, project }]`, sorted by path so
    runs are repeatable. `project` is the expanded override or `basename(home)`.
  - `inputsFor(harness, config)` returns the list of inputs for one harness: first the device's own
    (`{ path, project: null, home: null }` from `sources`), then one per home (`{ path, project, home }`).
  - `insideHome(home, path, { fs })` is true when `realpath(path)` equals or starts with `realpath(home) + "/"`.
    It is false when either path cannot be resolved.
  - `inputsFor` drops duplicates: an input whose real path (`realpath`) equals that of an earlier one in the list is
    left out. The device's own input therefore wins over a home that resolves to it, and the first entry wins
    among homes. A path that does not exist is compared as written. Without this, an OpenCode database reached
    twice would be read again under a second watermark key and its events re-filed under the home's name.
- `agent/src/sources/claude-code.js`: `extractClaudeCode` loops over `inputsFor("claude-code", config)`. With
  `project: null` it behaves as now. With a project it sets `ev.project` to it, skips `projectRootOf`, and skips
  every transcript for which `insideHome` is false. Cursors are keyed by file path already, so nothing changes
  there.
- `agent/src/sources/opencode.js`: `extractOpenCode` loops over `inputsFor("opencode", config)`. The watermark is
  per database: the device's own keeps the key `watermark:opencode:time_updated`, so nothing is re-read after the
  upgrade, and a home's database uses `watermark:opencode:time_updated:<db path>`. `resetCursors()` deletes
  `watermark:%`, which covers both. A database that cannot be opened is skipped, as now, and the others are still
  read. A home's database is skipped without being opened when `insideHome` is false for it, or for a `-wal` or
  `-shm` file that exists beside it.
- `agent/src/project.js`: `projectRootOf` returns a non-absolute value unchanged, before the cache and the walk.
  Today it would test `<name>/.git` against the process's working directory. This one guard covers `doctor`'s
  "projects are repo roots" check and `scripts/reroot-project.mjs`, which both call it on stored values.
- `agent/src/doctor.js`: a new check, "extra homes", absent when `homes` is empty. It lists each resolved home with
  its transcript count and whether its database opens. It fails when an entry without `*` does not exist, when a
  database is there and cannot be read, or when a transcript or database was skipped because it is not inside its
  home (it names the file). An entry with `*` that matches nothing passes with "0 homes". The existing
  checks (transcripts, dedupe, OpenCode reconciliation, models priced) keep reading the device's own home only. A
  model used only in a home is still reported as unpriced by `sync` itself.
- `agent/config.example.json`: a commented `homes` example.
- `README.md`: the diagram's source list, the config section, the "Data model" paragraph on `project` (a name where
  the event came from an extra home), and the doctor check list.

### Tests

- `agent/test/homes.test.js` (new): `*` expansion (one level, several matches, no match, a file where a directory
  is expected, a symlinked directory), the default project name, an override with `~`, `inputsFor` order,
  duplicates (a home that is the device's own home yields no second input; two entries matching one directory
  yield one input with the first entry's project), and `insideHome` (a plain file, a symlinked file, a file under
  a symlinked directory, a symlink that stays inside the home, a missing path).
- `agent/test/sources.test.js`: a home fixture with a transcript whose `cwd` is `/work/sub` yields events with the
  home's project; the device's own source still resolves through `projectRootOf`; in a home, a transcript that is
  a symlink to one outside it is skipped, and so are all transcripts when `.claude` is such a symlink; a home whose
  `opencode.db` is a symlink to a database outside it yields nothing; two OpenCode databases keep separate
  watermarks, and a second run yields only the boundary rows of each.
- `agent/test/project.test.js`: a non-absolute value is returned unchanged and touches no file system.
- `agent/test/doctor.test.js`: the "extra homes" check in its outcomes: ok, a missing entry, an unreadable
  database, a file that is not inside its home.

## Verification

1. `npm test` in `agent/`.
2. On desktop, before AgentRite's unit is released, fill one home by hand from an existing volume (see below), add
   the `homes` entry, then `harness-usage sync --no-ship` and `harness-usage show`: the sandbox sessions appear
   under `norareit`, with the model and token counts of the transcripts. A second `sync --no-ship` extracts 0 from
   the home.
3. `harness-usage sync`, then the dashboard: "Tokens by project" shows one `norareit` bar that grew by the sandbox
   sessions, not a second project and not `/work`.
4. `harness-usage doctor`: all checks pass, "extra homes" lists the home, and "projects are repo roots" is ok with
   the name in the store.
5. Not verified by this plan: reading an OpenCode database on the Mac while a container writes it through Docker
   Desktop's file sharing. A read-only SQLite reader needs the database's shared memory file, and that layer is
   where it may fail. Check it on the Mac before relying on it there.

## The backlog in existing volumes

Sessions already in a sandbox's home volume are collected by copying them once into the directory a `homes` entry
reads. This needs Docker, because the volume is not readable from the host. Per volume, with the project's own
image (any image with `cp` will do):

```sh
name=norareit; volume=norareit-agent_agent-home; image=norareit-agent
dest="$HOME/.local/share/agentrite/$name"
mkdir -p "$dest/.claude/projects" "$dest/.local/share/opencode"
docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint sh \
  -v "$volume":/from:ro -v "$dest":/to "$image" -c '
    [ -d /from/.claude/projects ] && cp -a /from/.claude/projects/. /to/.claude/projects/
    [ -d /from/.local/share/opencode ] && cp -a /from/.local/share/opencode/. /to/.local/share/opencode/
    true'
```

Run it while no container of the project is running, so the database is copied whole. It copies OpenCode's login
too, which is what the sandbox will expect to find there once AgentRite's unit is in use. Claude Code prunes
transcripts after about 30 days, in a volume as anywhere: the oldest volume on desktop is from 2026-09-09, so do
this soon.
