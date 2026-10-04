// project.test.js — projectRootOf, the repository-root resolver (plans/008, 017), and isProjectRoot (plans/014).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProjectRoot, projectRootOf, SPLIT_MARKER } from "../src/project.js";

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
    // A linked worktree of `main` at `wt` (both arrays of path parts), as
    // `git worktree add` lays it out. `gitdir` overrides the pointer's spelling.
    worktree: (main, wt, { name = "wt", gitdir } = {}) => {
      const own = join(dir, ...main, ".git", "worktrees", name);
      mkdirSync(own, { recursive: true });
      writeFileSync(join(own, "commondir"), "../..\n");
      mkdirSync(join(dir, ...wt), { recursive: true });
      writeFileSync(join(dir, ...wt, ".git"), `gitdir: ${gitdir ?? own}\n`);
    },
    split: (...p) => writeFileSync(join(dir, ...p, SPLIT_MARKER), "# split\n"),
  };
}

test("a .git directory: an inner working dir resolves to the repo root", () => {
  const t = tree();
  const inner = t.mk("repo", "a", "b");
  t.gitDir("repo");
  assert.equal(projectRootOf(inner, { home: t.home }), join(t.dir, "repo"));
});

test("a .git FILE whose git dir is gone counts as a root", () => {
  const t = tree();
  const inner = t.mk("wt", "src");
  t.gitFile("wt");
  assert.equal(projectRootOf(inner, { home: t.home }), join(t.dir, "wt"));
});

// plans/017: a linked worktree is a second checkout of the same repository.
test("a linked worktree resolves to its main checkout, from its root and from a subdirectory", () => {
  const t = tree();
  t.worktree(["repo"], ["repo-hotfix"]);
  const inner = t.mk("repo-hotfix", "src", "deep");
  assert.equal(projectRootOf(join(t.dir, "repo-hotfix"), { home: t.home }), join(t.dir, "repo"));
  assert.equal(projectRootOf(inner, { home: t.home }), join(t.dir, "repo"));
});

test("a linked worktree nested inside its main checkout resolves to the main checkout", () => {
  const t = tree();
  const wt = ["repo", ".claude", "worktrees", "agent-a9ad065d34463ec7c"];
  t.worktree(["repo"], wt, { name: "agent-a9ad065d34463ec7c" });
  assert.equal(projectRootOf(t.mk(...wt, "changes"), { home: t.home }), join(t.dir, "repo"));
});

test("a linked worktree's relative gitdir is resolved against the worktree root", () => {
  const t = tree();
  t.worktree(["repo"], ["side", "wt"], { gitdir: "../../repo/.git/worktrees/wt" });
  assert.equal(projectRootOf(t.mk("side", "wt", "src"), { home: t.home }), join(t.dir, "repo"));
});

test("a linked worktree of a split container: a child resolves to the main checkout's child", () => {
  const t = tree();
  t.worktree(["repo"], ["wt"]);
  // The marker is committed, so both checkouts have it.
  t.mk("repo", "janestreet");
  t.split("repo", "janestreet");
  const inner = t.mk("wt", "janestreet", "archmadness", "src");
  t.split("wt", "janestreet");
  assert.equal(projectRootOf(inner, { home: t.home }), join(t.dir, "repo", "janestreet", "archmadness"));
});

test("a submodule (a git dir without commondir) stays its own project", () => {
  const t = tree();
  t.gitDir("super");
  const own = t.mk("super", ".git", "modules", "sub");
  const inner = t.mk("super", "sub", "src");
  writeFileSync(join(t.dir, "super", "sub", ".git"), `gitdir: ${own}\n`);
  assert.equal(projectRootOf(inner, { home: t.home }), join(t.dir, "super", "sub"));
});

test("a linked worktree of a bare repository stays its own project", () => {
  const t = tree();
  const own = t.mk("repo.git", "worktrees", "wt");
  writeFileSync(join(own, "commondir"), "../..\n");
  const inner = t.mk("wt", "src");
  writeFileSync(join(t.dir, "wt", ".git"), `gitdir: ${own}\n`);
  assert.equal(projectRootOf(inner, { home: t.home }), join(t.dir, "wt"));
});

test("a linked worktree whose main checkout is $HOME stays its own project", () => {
  const t = tree();
  const own = join(t.home, ".git", "worktrees", "wt");
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "commondir"), "../..\n");
  const inner = t.mk("wt", "src");
  writeFileSync(join(t.dir, "wt", ".git"), `gitdir: ${own}\n`);
  assert.equal(projectRootOf(inner, { home: t.home }), join(t.dir, "wt"));
});

test("isProjectRoot: a linked worktree is not a root, its main checkout is", () => {
  const t = tree();
  t.worktree(["repo"], ["wt"]);
  assert.equal(isProjectRoot(join(t.dir, "wt"), { home: t.home }), false);
  assert.equal(isProjectRoot(join(t.dir, "repo"), { home: t.home }), true);
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

// plans/015: a cwd that exists only on another branch is gone while that branch
// is not checked out, and must still be filed under its repo.
test("a path that does not exist resolves to the existing repo above it", () => {
  const t = tree();
  t.mk("repo");
  t.gitDir("repo");
  const gone = join(t.dir, "repo", "changes", "0010-init-command");
  assert.equal(projectRootOf(gone, { home: t.home }), join(t.dir, "repo"));
});

test("a path that does not exist, with no .git above it, is returned unchanged", () => {
  const t = tree();
  t.mk("plain");
  const gone = join(t.dir, "plain", "was", "here");
  assert.equal(projectRootOf(gone, { home: t.home }), gone);
});

test("a path that does not exist inside a split child resolves to that child", () => {
  const t = tree();
  t.mk("repo", "janestreet");
  t.gitDir("repo");
  t.split("repo", "janestreet");
  const gone = join(t.dir, "repo", "janestreet", "archmadness", "src");
  assert.equal(projectRootOf(gone, { home: t.home }), join(t.dir, "repo", "janestreet", "archmadness"));
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

test("isProjectRoot: a repo root or a split sub-project is a root", () => {
  const t = tree();
  t.mk("repo", "src");
  t.gitDir("repo");
  t.mk("js", "puzzle");
  t.split("js");
  assert.equal(isProjectRoot(join(t.dir, "repo"), { home: t.home }), true);
  assert.equal(isProjectRoot(join(t.dir, "js", "puzzle"), { home: t.home }), true);
});

test("isProjectRoot: a typo, a plain dir, a repo subdir and $HOME are not", () => {
  const t = tree();
  t.mk("repo", "src");
  t.gitDir("repo");
  const plain = t.mk("plain");
  // A typo and a plain dir both resolve to themselves; that alone must not pass.
  assert.equal(projectRootOf(join(t.dir, "repp"), { home: t.home }), join(t.dir, "repp"));
  assert.equal(isProjectRoot(join(t.dir, "repp"), { home: t.home }), false);
  assert.equal(isProjectRoot(plain, { home: t.home }), false);
  assert.equal(isProjectRoot(join(t.dir, "repo", "src"), { home: t.home }), false);
  mkdirSync(join(t.home, ".git"));
  assert.equal(isProjectRoot(t.home, { home: t.home }), false, "a dotfiles repo in ~ is not a project");
});
