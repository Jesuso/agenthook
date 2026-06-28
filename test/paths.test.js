import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mangle, claudeProjectDir, worktreeDir } from "../src/paths.js";

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
