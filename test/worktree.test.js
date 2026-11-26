import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureWorktree, worktreePath, branchName, branchHead, commitsSince, listWorktrees, remoteMergeBase } from "../src/worktree.js";

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

test("HOST_GIT_SAFE: with a sandbox, every host git argv starts with it; without, the argv is unchanged", async () => {
  const { gitArgv, HOST_GIT_SAFE } = await import("../src/worktree.js");
  assert.deepEqual(HOST_GIT_SAFE, ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]);
  assert.deepEqual(gitArgv({ sandbox: { type: "docker" } }, "/r", ["worktree", "add", "/w", "b"]), [...HOST_GIT_SAFE, "-C", "/r", "worktree", "add", "/w", "b"]);
  assert.deepEqual(gitArgv({}, "/r", ["worktree", "add", "/w", "b"]), ["-C", "/r", "worktree", "add", "/w", "b"]);
});

test("hostGitSafe/gitArgv: a remote harness hardens exactly like a sandbox; a profile with neither is unchanged", async () => {
  const { gitArgv, hostGitSafe, HOST_GIT_SAFE } = await import("../src/worktree.js");
  assert.equal(hostGitSafe({}), false);
  assert.equal(hostGitSafe({ harnesses: { worker: {} } }), false, "a harness with no remote block doesn't harden");
  assert.equal(hostGitSafe({ harnesses: { worker: { remote: { host: "h", workDir: "/w" } } } }), true);
  assert.equal(hostGitSafe({ sandbox: { type: "docker" } }), true);
  const remoteCfg = { harnesses: { worker: { remote: { host: "h", workDir: "/w" } } } };
  assert.deepEqual(gitArgv(remoteCfg, "/r", ["push"]), [...HOST_GIT_SAFE, "-C", "/r", "push"]);
  assert.deepEqual(gitArgv({ harnesses: { worker: {} } }, "/r", ["push"]), ["-C", "/r", "push"]);
});

test("branchName: default prefix agent/, else the passed one", () => {
  assert.equal(branchName("7"), "agent/7");
  assert.equal(branchName("7", "local/"), "local/7");
});

test("ensureWorktree with cfg.branchPrefix creates a branch under that prefix (#674)", async () => {
  const s = setup();
  try {
    const cfg = { ...s.cfg, branchPrefix: "local/" };
    const r = await ensureWorktree(wtCfg(cfg), "11");
    assert.equal(r.branch, "local/11");
    assert.equal(g(r.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]), "local/11");
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("HOST_GIT_SAFE: an agent-written hooksPath never runs on the host when a sandboxed worktree is re-added", async () => {
  const s = setup();
  try {
    // The operator's repo points core.hooksPath at a dir the agent's branch controls (husky-style).
    const hooks = path.join(s.root, "agent-hooks");
    fs.mkdirSync(hooks);
    const marker = path.join(s.root, "pwned");
    fs.writeFileSync(path.join(hooks, "post-checkout"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    g(s.repoPath, ["config", "core.hooksPath", hooks]);
    const cfg = { ...s.cfg, sandbox: { type: "docker" } };
    await ensureWorktree(wtCfg(cfg), "9");
    assert.equal(fs.existsSync(marker), false, "post-checkout did not run");
    const { drainWorktree } = await import("../src/worktree.js");
    drainWorktree(wtCfg(cfg), "9");
    await ensureWorktree(wtCfg(cfg), "9"); // existing branch: `git worktree add <wt> <branch>`
    assert.equal(fs.existsSync(marker), false);
    // Control: without the sandbox the same re-add runs the hook.
    drainWorktree(wtCfg(s.cfg), "9");
    await ensureWorktree(wtCfg(s.cfg), "9");
    assert.equal(fs.existsSync(marker), true);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

/** A fake `git` on PATH that records its full argv (one JSON line per call) then execs the
 * real one — for asserting the exact argv a caller built, not just its observable effect.
 * @param {string} realGit */
function withArgvRecordingGit(realGit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-git-bin-"));
  const bin = path.join(dir, "git");
  const record = path.join(dir, "record.jsonl");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nimport fs from "node:fs";\nimport { spawnSync } from "node:child_process";\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + "\\n");\nconst r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n`,
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  return {
    calls: () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    restore: () => {
      process.env.PATH = savedPath;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("listWorktrees: a remote-harness cfg is HOST_GIT_SAFE-hardened on the actual argv; a profile with neither sandbox nor remote harness is unchanged", async () => {
  const s = setup();
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const rec = withArgvRecordingGit(realGit);
  try {
    const remoteCfg = { ...s.cfg, harnesses: { worker: { remote: { host: "h", workDir: "/w" } } } };
    const records = listWorktrees(remoteCfg, s.repoPath);
    assert.ok(records.length > 0);
    const listCall = rec.calls().find((a) => a.includes("worktree") && a.includes("list"));
    assert.ok(listCall, JSON.stringify(rec.calls()));
    assert.deepEqual(listCall.slice(0, 4), ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"], `expected HOST_GIT_SAFE first, got ${JSON.stringify(listCall)}`);

    listWorktrees(s.cfg, s.repoPath); // unhardened: neither sandbox nor remote harness
    const plainCall = rec.calls().filter((a) => a.includes("worktree") && a.includes("list")).at(-1);
    assert.deepEqual(plainCall.slice(0, 2), ["-C", s.repoPath], "no -c flags when the profile needs no hardening");
  } finally {
    rec.restore();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

// --- branchHead / commitsSince (#680): the deduced-verdict ladder's git reads, fail-closed ---

test("branchHead: the branch's current HEAD sha; null on any git error", async () => {
  const s = setup();
  try {
    const r = await ensureWorktree(wtCfg(s.cfg), "20");
    assert.equal(branchHead(wtCfg(s.cfg), r.worktree), g(r.worktree, ["rev-parse", "HEAD"]));
    assert.equal(branchHead(wtCfg(s.cfg), path.join(s.root, "does-not-exist")), null);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("commitsSince: counts commits past a sha; 0 when the tree is only dirty, or on any git error", async () => {
  const s = setup();
  try {
    const r = await ensureWorktree(wtCfg(s.cfg), "21");
    const before = branchHead(wtCfg(s.cfg), r.worktree);
    assert.equal(commitsSince(wtCfg(s.cfg), r.worktree, before), 0, "no new commits yet");
    fs.writeFileSync(path.join(r.worktree, "dirty.txt"), "uncommitted");
    assert.equal(commitsSince(wtCfg(s.cfg), r.worktree, before), 0, "a dirty tree with no commit does not count");
    g(r.worktree, ["commit", "--allow-empty", "-m", "c1"]);
    g(r.worktree, ["commit", "--allow-empty", "-m", "c2"]);
    assert.equal(commitsSince(wtCfg(s.cfg), r.worktree, before), 2);
    assert.equal(commitsSince(wtCfg(s.cfg), r.worktree, "not-a-sha"), 0, "an invalid start point fails closed to 0");
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

// --- remoteMergeBase (#826): the hub-side base sha for a REMOTE (ssh) run's review diff —
// the worker's clone is fresh (no origin default ref), so the hub computes it in its own worktree.
test("remoteMergeBase: resolves origin/<default> via refs/remotes/origin/HEAD and merges it against HEAD", () => {
  const s = setup();
  try {
    const r = remoteMergeBase(s.cfg, { path: s.repoPath }, s.repoPath);
    assert.ok(r, "a base is found in a normal clone");
    assert.equal(r.ref, "origin/master");
    assert.equal(r.sha, g(s.repoPath, ["merge-base", "origin/master", "HEAD"]));
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("remoteMergeBase: without refs/remotes/origin/HEAD it falls back to the local default branch name (same origin ref)", () => {
  const s = setup();
  try {
    g(s.repoPath, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]); // clone without the remote symbolic ref
    const r = remoteMergeBase(s.cfg, { path: s.repoPath }, s.repoPath);
    assert.ok(r, "the local branch name still resolves");
    assert.equal(r.ref, "origin/master");
    assert.equal(r.sha, g(s.repoPath, ["rev-parse", "origin/master"]));
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("remoteMergeBase: in a worktree on the agent branch (no origin/HEAD) the default name comes from the REPO, not the worktree's HEAD", async () => {
  const s = setup();
  try {
    const { worktree } = await ensureWorktree(s.cfg, "7"); // branch agent/7, checked out in its own worktree
    fs.writeFileSync(path.join(worktree, "a.txt"), "agent work");
    g(worktree, ["add", "."]);
    g(worktree, ["commit", "-q", "-m", "agent commit"]);
    g(s.repoPath, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]); // a clone without the remote symbolic ref
    const r = remoteMergeBase(s.cfg, { path: s.repoPath }, worktree);
    assert.ok(r, "the main checkout is on master — a default exists");
    assert.equal(r.ref, "origin/master", "named from the repo's main checkout, not the worktree's agent branch");
    assert.equal(r.sha, g(s.repoPath, ["rev-parse", "origin/master"]));
    assert.notEqual(r.sha, g(worktree, ["rev-parse", "HEAD"]), "never the agent branch's own HEAD (that would diff empty)");
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("remoteMergeBase: a detached main checkout (no local branch name, no origin/HEAD) is null, not an error", () => {
  const s = setup();
  try {
    g(s.repoPath, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    g(s.repoPath, ["checkout", "--quiet", "--detach", "HEAD"]);
    assert.equal(remoteMergeBase(s.cfg, { path: s.repoPath }, s.repoPath), null, "nothing to name a default — fail closed");
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
