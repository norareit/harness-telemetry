// project.test.js — projectRootOf, the repository-root resolver (plans/008).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRootOf, SPLIT_MARKER } from "../src/project.js";

// Every temp dir is tracked and swept once at the end (these helpers get no test
// context). The memo is keyed on the input path alone, so it is cleared per case
// to stop temp paths leaking a stale result across cases.
const TMP = [];
const mkTmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  TMP.push(d);
  return d;
};
after(() => TMP.forEach((d) => { try { rmSync(d, { recursive: true, force: true }); } catch {} }));

function tree() {
  const dir = mkTmp("proj-");
  projectRootOf.cache.clear();
  return {
    dir,
    home: mkTmp("home-"), // unrelated to `dir`, so the $HOME stop never fires
    mk: (...p) => {
      const full = join(dir, ...p);
      mkdirSync(full, { recursive: true });
      return full;
    },
    gitDir: (...p) => mkdirSync(join(dir, ...p, ".git"), { recursive: true }),
    gitFile: (...p) => writeFileSync(join(dir, ...p, ".git"), "gitdir: /elsewhere\n"),
    split: (...p) => writeFileSync(join(dir, ...p, SPLIT_MARKER), "# split\n"),
  };
}

test("a .git directory: an inner working dir resolves to the repo root", () => {
  const t = tree();
  const inner = t.mk("repo", "a", "b");
  t.gitDir("repo");
  assert.equal(projectRootOf(inner, { home: t.home }), join(t.dir, "repo"));
});

test("a .git FILE (worktree/submodule shape) counts as a root", () => {
  const t = tree();
  const inner = t.mk("wt", "src");
  t.gitFile("wt");
  assert.equal(projectRootOf(inner, { home: t.home }), join(t.dir, "wt"));
});

test("nested repositories: the nearest .git wins", () => {
  const t = tree();
  const inner = t.mk("outer", "inner", "x");
  t.gitDir("outer");
  t.gitDir("outer", "inner");
  assert.equal(projectRootOf(inner, { home: t.home }), join(t.dir, "outer", "inner"));
});

test("no .git anywhere above: the path is returned unchanged", () => {
  const t = tree();
  const inner = t.mk("plain", "deep");
  assert.equal(projectRootOf(inner, { home: t.home }), inner);
});

test("a path that does not exist is returned unchanged, even under a repo", () => {
  const t = tree();
  t.mk("repo");
  t.gitDir("repo");
  const gone = join(t.dir, "repo", "was", "here");
  assert.equal(projectRootOf(gone, { home: t.home }), gone);
});

test("a .git at or above $HOME is ignored (a dotfiles repo must not swallow ~)", () => {
  const home = mkTmp("home-");
  mkdirSync(join(home, ".git"), { recursive: true });
  const inner = join(home, "projects", "thing");
  mkdirSync(inner, { recursive: true });
  projectRootOf.cache.clear();
  assert.equal(projectRootOf(inner, { home }), inner);
});

test("split container: an immediate child of a .harness-split dir is its own project", () => {
  const t = tree();
  // repo/ is one git repo; repo/janestreet holds several sub-projects.
  const inner = t.mk("repo", "janestreet", "archmadness", "puzzles");
  t.gitDir("repo");
  t.split("repo", "janestreet");
  // Deeper split boundary wins over the repo's own .git.
  assert.equal(
    projectRootOf(inner, { home: t.home }),
    join(t.dir, "repo", "janestreet", "archmadness"),
  );
});

test("split container: work at the container's own root still resolves to the repo", () => {
  const t = tree();
  const top = t.mk("repo", "janestreet");
  t.gitDir("repo");
  t.split("repo", "janestreet");
  // A path directly in janestreet (not in a child) belongs to the repo root.
  assert.equal(projectRootOf(top, { home: t.home }), join(t.dir, "repo"));
});

test("split container works even without a repo above it", () => {
  const t = tree();
  const inner = t.mk("bucket", "projA", "x");
  t.split("bucket");
  assert.equal(projectRootOf(inner, { home: t.home }), join(t.dir, "bucket", "projA"));
});

test("a split marker at/above $HOME is ignored, like .git", () => {
  const home = mkTmp("home-");
  writeFileSync(join(home, SPLIT_MARKER), "# split\n");
  const inner = join(home, "thing");
  mkdirSync(inner, { recursive: true });
  projectRootOf.cache.clear();
  assert.equal(projectRootOf(inner, { home }), inner);
});

test("null / falsy input is returned unchanged", () => {
  assert.equal(projectRootOf(null), null);
  assert.equal(projectRootOf(""), "");
});

test("memoisation: a second call with the same input does not touch the fs", () => {
  const t = tree();
  const inner = t.mk("repo", "a");
  t.gitDir("repo");
  const root = projectRootOf(inner, { home: t.home }); // primes the cache (real fs)

  let calls = 0;
  const spy = { statSync: (p) => { calls++; return statSync(p); } };
  const again = projectRootOf(inner, { home: t.home, fs: spy });
  assert.equal(again, root);
  assert.equal(calls, 0, "cached call must not hit the filesystem");
});
