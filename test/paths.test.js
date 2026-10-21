import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mangle, claudeProjectDir, worktreeDir, legacyWorktreeDir, controlSockPath } from "../src/paths.js";
import { worktreePath } from "../src/worktree.js";

test("mangle replaces every non-alphanumeric char with a dash", () => {
  assert.equal(mangle("/home/me/repo"), "-home-me-repo");
  assert.equal(mangle("a.b_c/d"), "a-b-c-d");
  assert.equal(mangle("Abc123"), "Abc123"); // alphanumerics untouched
});

test("claudeProjectDir lives under ~/.claude/projects with the mangled repo path", () => {
  assert.equal(claudeProjectDir("/x/y"), path.join(os.homedir(), ".claude", "projects", "-x-y"));
});

test("worktreeDir defaults to a sibling of the repo named after its own dir", () => {
  assert.equal(worktreeDir(/** @type {any} */ ({ repoPath: "/a/b/repo" })), path.resolve("/a/b/repo", "../repo-worktrees"));
});

test("worktreeDir: two repos sharing a parent dir resolve to different bases", () => {
  const foo = { id: "default", path: "/p/foo", match: [], default: true };
  const bar = { id: "default", path: "/p/bar", match: [], default: true };
  const cfgFoo = /** @type {any} */ ({ repoPath: foo.path, repos: [foo] });
  const cfgBar = /** @type {any} */ ({ repoPath: bar.path, repos: [bar] });
  assert.equal(worktreeDir(cfgFoo, foo), "/p/foo-worktrees");
  assert.equal(worktreeDir(cfgBar, bar), "/p/bar-worktrees");
  assert.notEqual(worktreePath(cfgFoo, "80", foo), worktreePath(cfgBar, "80", bar));
});

test("worktreeDir honors an absolute worktreePrefix (sandbox container path)", () => {
  assert.equal(worktreeDir(/** @type {any} */ ({ repoPath: "/work/repo", worktreePrefix: "/work/worktrees" })), "/work/worktrees");
});

test("controlSockPath: posix is a socket file under stateDir", () => {
  assert.equal(controlSockPath("/home/me/.agenthook/foo", "foo", "linux"), path.join("/home/me/.agenthook/foo", "control.sock"));
});

test("controlSockPath: win32 is a named pipe keyed by profile name", () => {
  assert.equal(controlSockPath("/home/me/.agenthook/foo", "foo", "win32"), "\\\\.\\pipe\\agenthook-foo");
});

// --- multi-repo worktree layout ---

test("worktreePath: single-repo (no repos block) keeps the <base>/<ref> layout", () => {
  const cfg = /** @type {any} */ ({ repoPath: "/a/b/repo" });
  assert.equal(worktreePath(cfg, "80"), path.resolve("/a/b/repo-worktrees", "80"));
  const synth = /** @type {any} */ ({ repoPath: "/a/b/repo", multiRepo: false, repos: [{ id: "default", path: "/a/b/repo", match: [], default: true }] });
  assert.equal(worktreePath(synth, "80"), worktreePath(cfg, "80"));
});

test("worktreePath: multi-repo nests <base>/<repo.id>/<ref>; sibling repos never collide", () => {
  const mono = { id: "mono", path: "/w/acme", match: [], default: true };
  const ios = { id: "ios", path: "/w/acme-ios", match: ["ios"] };
  const cfg = /** @type {any} */ ({ repoPath: mono.path, multiRepo: true, repos: [mono, ios] });
  // each repo's own dir name gives it a distinct base…
  assert.notEqual(worktreeDir(cfg, mono), worktreeDir(cfg, ios));
  // …and the per-repo subdir also keeps their worktrees apart
  assert.equal(worktreePath(cfg, "80", mono), "/w/acme-worktrees/mono/80");
  assert.equal(worktreePath(cfg, "80", ios), "/w/acme-ios-worktrees/ios/80");
  assert.equal(worktreePath(cfg, "80"), worktreePath(cfg, "80", mono), "repo defaults to the default repo");
});

test("legacyWorktreeDir: null when an explicit prefix is set (global or per-repo), else the old shared base", () => {
  const repo = { id: "default", path: "/a/b/repo", match: [], default: true };
  assert.equal(legacyWorktreeDir(/** @type {any} */ ({ repoPath: repo.path, repos: [repo] })), path.resolve("/a/b/agenthook-worktrees"));
  assert.equal(legacyWorktreeDir(/** @type {any} */ ({ repoPath: repo.path, worktreePrefix: "/global/wt", repos: [repo] })), null);
  const prefixed = { ...repo, worktreePrefix: "../other" };
  assert.equal(legacyWorktreeDir(/** @type {any} */ ({ repoPath: repo.path, repos: [prefixed] }), prefixed), null);
  // a repo dir literally named "agenthook" makes the old and new default bases equal
  const named = { id: "default", path: "/a/b/agenthook", match: [], default: true };
  assert.equal(legacyWorktreeDir(/** @type {any} */ ({ repoPath: named.path, repos: [named] }), named), null);
});

test("worktreePath: an in-flight ref already checked out under the legacy base keeps using it; a fresh ref uses the new base", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-legacy-wt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  const legacyRefDir = path.join(root, "agenthook-worktrees", "A");
  fs.mkdirSync(legacyRefDir, { recursive: true });
  const repo = { id: "default", path: repoPath, match: [], default: true };
  const cfg = /** @type {any} */ ({ repoPath, repos: [repo] });
  assert.equal(worktreePath(cfg, "A", repo), legacyRefDir);
  assert.equal(worktreePath(cfg, "B", repo), path.join(root, "repo-worktrees", "B"));
});

test("worktreePath: an explicit worktreePrefix ignores an existing legacy agenthook-worktrees/<ref> dir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-legacy-wt-prefix-"));
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  fs.mkdirSync(path.join(root, "agenthook-worktrees", "A"), { recursive: true });
  const repo = { id: "default", path: repoPath, match: [], default: true, worktreePrefix: "../explicit-worktrees" };
  const cfg = /** @type {any} */ ({ repoPath, repos: [repo] });
  assert.equal(legacyWorktreeDir(cfg, repo), null);
  assert.equal(worktreePath(cfg, "A", repo), path.join(root, "explicit-worktrees", "A"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("worktreeDir: a per-repo worktreePrefix overrides the global one", () => {
  const android = { id: "android", path: "/w/android", match: [], worktreePrefix: "../android-agents" };
  const cfg = /** @type {any} */ ({ repoPath: "/w/android", worktreePrefix: "/global/wt", multiRepo: true, repos: [android] });
  assert.equal(worktreeDir(cfg, android), "/w/android-agents");
  assert.equal(worktreePath(cfg, "7", android), "/w/android-agents/android/7");
  assert.equal(worktreeDir(cfg, { id: "x", path: "/w/x", match: [] }), "/global/wt");
});
