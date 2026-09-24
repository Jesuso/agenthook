import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mangle, claudeProjectDir, worktreeDir } from "../src/paths.js";
import { worktreePath } from "../src/worktree.js";

test("mangle replaces every non-alphanumeric char with a dash", () => {
  assert.equal(mangle("/home/me/repo"), "-home-me-repo");
  assert.equal(mangle("a.b_c/d"), "a-b-c-d");
  assert.equal(mangle("Abc123"), "Abc123"); // alphanumerics untouched
});

test("claudeProjectDir lives under ~/.claude/projects with the mangled repo path", () => {
  assert.equal(claudeProjectDir("/x/y"), path.join(os.homedir(), ".claude", "projects", "-x-y"));
});

test("worktreeDir defaults to a sibling of the repo", () => {
  assert.equal(worktreeDir(/** @type {any} */ ({ repoPath: "/a/b/repo" })), path.resolve("/a/b/repo", "../agenthook-worktrees"));
});

test("worktreeDir honors an absolute worktreePrefix (sandbox container path)", () => {
  assert.equal(worktreeDir(/** @type {any} */ ({ repoPath: "/work/repo", worktreePrefix: "/work/worktrees" })), "/work/worktrees");
});

// --- multi-repo worktree layout ---

test("worktreePath: single-repo (no repos block) keeps the legacy <base>/<ref> layout", () => {
  const cfg = /** @type {any} */ ({ repoPath: "/a/b/repo" });
  assert.equal(worktreePath(cfg, "80"), path.resolve("/a/b/agenthook-worktrees", "80"));
  const synth = /** @type {any} */ ({ repoPath: "/a/b/repo", multiRepo: false, repos: [{ id: "default", path: "/a/b/repo", match: [], default: true }] });
  assert.equal(worktreePath(synth, "80"), worktreePath(cfg, "80"));
});

test("worktreePath: multi-repo nests <base>/<repo.id>/<ref>; sibling repos never collide", () => {
  const mono = { id: "mono", path: "/w/alephbeta", match: [], default: true };
  const ios = { id: "ios", path: "/w/alephbeta-ios", match: ["ios"] };
  const cfg = /** @type {any} */ ({ repoPath: mono.path, multiRepo: true, repos: [mono, ios] });
  // both repos resolve the default prefix to the SAME base dir…
  assert.equal(worktreeDir(cfg, mono), worktreeDir(cfg, ios));
  // …but the per-repo subdir keeps their worktrees apart
  assert.equal(worktreePath(cfg, "80", mono), "/w/agenthook-worktrees/mono/80");
  assert.equal(worktreePath(cfg, "80", ios), "/w/agenthook-worktrees/ios/80");
  assert.equal(worktreePath(cfg, "80"), worktreePath(cfg, "80", mono), "repo defaults to the default repo");
});

test("worktreeDir: a per-repo worktreePrefix overrides the global one", () => {
  const android = { id: "android", path: "/w/android", match: [], worktreePrefix: "../android-agents" };
  const cfg = /** @type {any} */ ({ repoPath: "/w/android", worktreePrefix: "/global/wt", multiRepo: true, repos: [android] });
  assert.equal(worktreeDir(cfg, android), "/w/android-agents");
  assert.equal(worktreePath(cfg, "7", android), "/w/android-agents/android/7");
  assert.equal(worktreeDir(cfg, { id: "x", path: "/w/x", match: [] }), "/global/wt");
});
