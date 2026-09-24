import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureWorktree, worktreePath } from "../src/worktree.js";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
/** @param {string} cwd @param {string[]} args */
const g = (cwd, args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-wt-"));
  const origin = path.join(root, "origin.git");
  const repoPath = path.join(root, "repo");
  const other = path.join(root, "other");
  g(root, ["init", "--bare", "-b", "master", origin]);
  g(root, ["clone", origin, other]);
  fs.writeFileSync(path.join(other, "a.txt"), "1");
  g(other, ["add", "."]);
  g(other, ["commit", "-m", "one"]);
  g(other, ["push", "origin", "HEAD:master"]);
  g(root, ["clone", origin, repoPath]);
  const cfg = /** @type {any} */ ({
    repoPath, worktreePrefix: path.join(root, "wts"), multiRepo: false,
    repos: [{ id: "default", path: repoPath, default: true }], name: "t",
  });
  return { root, origin, repoPath, other, cfg };
}
/** @param {any} cfg */
const wtCfg = (cfg) => cfg;

test("new branch is based on fresh origin/master, checkout untouched, no upstream", async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.other, "b.txt"), "2");
    g(s.other, ["add", "."]);
    g(s.other, ["commit", "-m", "two"]);
    g(s.other, ["push", "origin", "HEAD:master"]);
    const pushed = g(s.other, ["rev-parse", "HEAD"]);
    const localBefore = g(s.repoPath, ["rev-parse", "master"]);
    fs.writeFileSync(path.join(s.repoPath, "a.txt"), "dirty");
    assert.notEqual(localBefore, pushed);

    const r = await ensureWorktree(wtCfg(s.cfg), "7");
    assert.equal(g(s.repoPath, ["rev-parse", "agent/7"]), pushed);
    assert.equal(r.base?.ref, "origin/master");
    assert.equal(r.base?.sha, pushed.slice(0, r.base.sha.length));
    assert.equal(g(s.repoPath, ["rev-parse", "master"]), localBefore);
    assert.equal(fs.readFileSync(path.join(s.repoPath, "a.txt"), "utf8"), "dirty");
    assert.throws(() => g(s.repoPath, ["rev-parse", "--abbrev-ref", "agent/7@{upstream}"]));
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("fetch failure falls back to local master with a warning", async () => {
  const s = setup();
  const warn = console.warn;
  /** @type {string[]} */
  const warns = [];
  console.warn = (m) => warns.push(String(m));
  try {
    g(s.repoPath, ["remote", "set-url", "origin", path.join(s.root, "nope.git")]);
    const local = g(s.repoPath, ["rev-parse", "master"]);
    const r = await ensureWorktree(wtCfg(s.cfg), "8");
    assert.equal(g(s.repoPath, ["rev-parse", "agent/8"]), local);
    assert.equal(r.base?.ref, "master");
    assert.ok(warns.some((w) => w.startsWith("[worktree] fetch origin master failed")));
  } finally {
    console.warn = warn;
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("no origin remote: branch from current HEAD, no throw", async () => {
  const s = setup();
  try {
    g(s.repoPath, ["remote", "remove", "origin"]);
    const head = g(s.repoPath, ["rev-parse", "HEAD"]);
    const r = await ensureWorktree(wtCfg(s.cfg), "9");
    assert.equal(g(s.repoPath, ["rev-parse", "agent/9"]), head);
    assert.equal(r.created, true);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("existing branch is reused with no fetch/base", async () => {
  const s = setup();
  try {
    g(s.repoPath, ["branch", "agent/10"]);
    // a broken origin would warn if a fetch were attempted
    g(s.repoPath, ["remote", "set-url", "origin", path.join(s.root, "nope.git")]);
    const r = await ensureWorktree(wtCfg(s.cfg), "10");
    assert.equal(r.created, true);
    assert.equal(r.base, undefined);
    assert.ok(fs.existsSync(worktreePath(s.cfg, "10")));
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
