import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The github forge's outbox-publishing methods (#825, #681 phase 5a): `publishBranch`
// (hub-side push under the forge's own token — never in argv, workflow-guarded, no force)
// and `openPr` (draft PR against the default branch; an already-open PR on the head is
// reused, never edited). fetch-mocked where there is HTTP; a fake `git` on PATH where there
// is git.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createGithubForge } from "../src/forges/github.js";
import { makeStore, stubFetch } from "./_forge-helpers.js";

const TOKEN = "tok-secret-825-never-in-argv";
/** A github forge with a recognisable token. */
const forge = () => createGithubForge(/** @type {any} */ ({ pipeline: [], forge: { type: "github", token: TOKEN, repository: "o/r" } }), /** @type {any} */ (makeStore()));

// --- openPr (fetch-mocked) ---

test("openPr reuses an already-open PR on the same head — no POST, the first PR is never edited", async () => {
  const f = forge();
  const stub = stubFetch({
    "GET /repos/o/r/pulls?state=open&head=o%3Aagent%2F42": { json: [{ number: 31, state: "open", head: { ref: "agent/42" } }] },
  });
  try {
    const pr = await f.openPr({ branch: "agent/42", title: "second pass", body: "rework" });
    assert.deepEqual(pr, { number: 31, created: false });
    assert.equal(stub.calls.filter((c) => c.method === "POST").length, 0, "no POST — the first PR is never edited");
  } finally {
    stub.restore();
  }
});

test("openPr opens a DRAFT PR against the repo's default branch when none is open", async () => {
  const f = forge();
  const stub = stubFetch({
    "GET /repos/o/r/pulls?state=open&head=o%3Aagent%2F42": { json: [] },
    "GET /repos/o/r": { json: { default_branch: "trunk" } },
    "POST /repos/o/r/pulls": { json: { number: 32 } },
  });
  try {
    const pr = await f.openPr({ branch: "agent/42", title: "Fix the flaky test", body: "what I did" });
    assert.deepEqual(pr, { number: 32, created: true });
    const post = stub.calls.find((c) => c.method === "POST" && c.url.endsWith("/repos/o/r/pulls"));
    assert.ok(post, "a POST to /pulls was made");
    assert.deepEqual(post.body, { title: "Fix the flaky test", body: "what I did", head: "o:agent/42", base: "trunk", draft: true });
  } finally {
    stub.restore();
  }
});

test("openPr throws on a non-2xx with the status and the API's message", async () => {
  const f = forge();
  const stub = stubFetch({
    "GET /repos/o/r/pulls?state=open&head=o%3Aagent%2F42": { json: [] },
    "GET /repos/o/r": { json: { default_branch: "main" } },
    "POST /repos/o/r/pulls": { status: 422, json: { message: "Validation Failed" } },
  });
  try {
    await assert.rejects(f.openPr({ branch: "agent/42", title: "t", body: "b" }), /422.*Validation Failed/);
  } finally {
    stub.restore();
  }
});

// --- publishBranch (fake git on PATH) ---

/** A fake `git` on PATH: records each call's argv + the GIT_CONFIG_* env it ran with, then
 * answers the subcommands publishBranch uses. Behaviour is steered by FAKE_GIT_MODE (inherited
 * through publishGitEnv): "remote-exists" → ls-remote shows the branch; "ci" → the workflow
 * log shows a touched path; "empty" → the range has 0 commits; "reject" → the push fails. */
function withFakeGit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-fake-git-"));
  const record = path.join(dir, "record.jsonl");
  fs.writeFileSync(
    path.join(dir, "git"),
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: args, config: { count: process.env.GIT_CONFIG_COUNT, k1: process.env.GIT_CONFIG_KEY_1, v1: process.env.GIT_CONFIG_VALUE_1, prompt: process.env.GIT_TERMINAL_PROMPT } }) + "\\n");
const SUBS = ["ls-remote", "fetch", "log", "rev-list", "push"]; // args may start with -C <dir> or -c k=v pairs
const sub = args.find((a) => SUBS.includes(a)) || "";
const mode = process.env.FAKE_GIT_MODE || "";
let out = "", err = "", code = 0;
if (sub === "ls-remote") { if (mode === "remote-exists") out = "abc123\\trefs/heads/agent/42\\n"; }
else if (sub === "log") { if (mode === "ci") out = ".github/workflows/x.yml\\n.github/workflows/x.yml\\n"; }
else if (sub === "rev-list") { out = mode === "empty" ? "0" : "2"; }
else if (sub === "push") { if (mode === "reject") { err = "remote: pre-receive hook declined (fatal)\\nfatal: remote rejected"; code = 1; } }
process.stdout.write(out);
process.stderr.write(err);
process.exit(code);
`,
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
const runMode = async (mode, fn) => {
  const saved = process.env.FAKE_GIT_MODE;
  if (mode) process.env.FAKE_GIT_MODE = mode;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.FAKE_GIT_MODE;
    else process.env.FAKE_GIT_MODE = saved;
  }
};

test("publishBranch pushes the branch --no-force, the token only in env (never in argv)", async () => {
  const git = withFakeGit();
  const stub = stubFetch({ "GET /repos/o/r": { json: { default_branch: "main" } } });
  try {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ah-fake-wt-"));
    try {
      const r = await runMode(undefined, () => forge().publishBranch({ worktree: wt, branch: "agent/42" }));
      assert.deepEqual(r, { pushed: ["origin/agent/42"] });
      const calls = git.calls();
      for (const c of calls) assert.ok(!c.argv.join("\x00").includes(TOKEN), `the token must never appear in argv: ${JSON.stringify(c.argv)}`);
      const push = calls.find((c) => c.argv.includes("push"));
      assert.ok(push, "a push was made");
      assert.ok(push.argv.includes("--no-force"));
      assert.ok(push.argv.includes("HEAD:agent/42"));
      // The token IS in the env: GIT_CONFIG_VALUE_1 carries the basic-auth header.
      const expected = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
      assert.equal(calls[0].config.v1, expected);
      assert.equal(calls[0].config.k1, "http.https://github.com/.extraheader");
      assert.equal(calls[0].config.prompt, "0", "no terminal prompts");
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  } finally {
    stub.restore();
    git.restore();
  }
});

test("publishBranch: a commit touching .github/workflows/ refuses the push — {workflow}, nothing pushed", async () => {
  const git = withFakeGit();
  const stub = stubFetch({ "GET /repos/o/r": { json: { default_branch: "main" } } });
  try {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ah-fake-wt-"));
    try {
      const r = await runMode("ci", () => forge().publishBranch({ worktree: wt, branch: "agent/42" }));
      assert.deepEqual(r, { workflow: ".github/workflows/x.yml" });
      assert.equal(git.calls().find((c) => c.argv.includes("push")), undefined, "the guard runs BEFORE any push");
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  } finally {
    stub.restore();
    git.restore();
  }
});

test("publishBranch: an empty range (nothing new) returns {pushed: []} without pushing", async () => {
  const git = withFakeGit();
  const stub = stubFetch({ "GET /repos/o/r": { json: { default_branch: "main" } } });
  try {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ah-fake-wt-"));
    try {
      const r = await runMode("empty", () => forge().publishBranch({ worktree: wt, branch: "agent/42" }));
      assert.deepEqual(r, { pushed: [] });
      assert.equal(git.calls().find((c) => c.argv.includes("push")), undefined);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  } finally {
    stub.restore();
    git.restore();
  }
});

test("publishBranch: a push rejection throws with the remote's first error line", async () => {
  const git = withFakeGit();
  const stub = stubFetch({ "GET /repos/o/r": { json: { default_branch: "main" } } });
  try {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ah-fake-wt-"));
    try {
      // NODE_NO_WARNINGS: an inherited proxy env makes Node print an undici experimental
      // warning to the shared stderr, which would otherwise become the FIRST line of the
      // rejection message (publishBranch reports that first line).
      const saved = process.env.NODE_NO_WARNINGS;
      process.env.NODE_NO_WARNINGS = "1";
      try {
        await assert.rejects(
          runMode("reject", () => forge().publishBranch({ worktree: wt, branch: "agent/42" })),
          (e) => e.message.includes("pre-receive hook declined"),
        );
      } finally {
        if (saved === undefined) delete process.env.NODE_NO_WARNINGS;
        else process.env.NODE_NO_WARNINGS = saved;
      }
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  } finally {
    stub.restore();
    git.restore();
  }
});

test("publishBranch: a rework run (the branch already exists on the remote) measures from it", async () => {
  const git = withFakeGit();
  const stub = stubFetch({ "GET /repos/o/r": { json: { default_branch: "main" } } });
  try {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ah-fake-wt-"));
    try {
      const r = await runMode("remote-exists", () => forge().publishBranch({ worktree: wt, branch: "agent/42" }));
      assert.deepEqual(r, { pushed: ["origin/agent/42"] });
      const fetch = git.calls().find((c) => c.argv.includes("fetch"));
      assert.ok(fetch, "the existing remote branch was fetched");
      assert.deepEqual(fetch.argv.slice(-2), ["origin", "agent/42"], "…the branch itself, not the default");
      assert.ok(git.calls().some((c) => c.argv.includes("ls-remote")), "ls-remote decided the branch exists");
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  } finally {
    stub.restore();
    git.restore();
  }
});

// --- the workflow guard against REAL git — the fake above answers canned strings, so it can
// neither exercise the range nor the merge case (a plain `git log` prints no files for a merge
// commit, and only `-m`/the net diff see a workflow file added in a merge resolution) ---

/** A real bare `origin` with one commit on `main`, plus a clone with git identity configured
 * and a working `agent/42` branch. */
function realGit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-real-git-"));
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const wt = path.join(dir, "clone");
  const g = (cwd, args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  g(dir, ["init", "--quiet", "--bare", "-b", "main", origin]);
  g(dir, ["clone", "--quiet", origin, seed]);
  g(seed, ["config", "user.email", "a@example.test"]);
  g(seed, ["config", "user.name", "a"]);
  fs.writeFileSync(path.join(seed, "README.md"), "base\n");
  g(seed, ["add", "README.md"]);
  g(seed, ["commit", "--quiet", "-m", "base"]);
  g(seed, ["push", "--quiet", "origin", "main"]);
  g(dir, ["clone", "--quiet", origin, wt]);
  g(wt, ["config", "user.email", "a@example.test"]);
  g(wt, ["config", "user.name", "a"]);
  g(wt, ["checkout", "--quiet", "-b", "agent/42"]);
  return {
    dir,
    wt,
    g,
    /** The sha of origin/main as the clone sees it (what the guard may NOT contain after). */
    remoteAgent42: () => execFileSync("git", ["ls-remote", "--heads", "origin", "agent/42"], { cwd: wt }).toString().trim(),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("publishBranch (real git): a plain commit touching .github/workflows/ refuses the push — {workflow}, nothing on the remote", async () => {
  const rg = realGit();
  try {
    fs.mkdirSync(path.join(rg.wt, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(rg.wt, ".github", "workflows", "x.yml"), "on: [push]\n");
    rg.g(rg.wt, ["add", ".github"]);
    rg.g(rg.wt, ["commit", "--quiet", "-m", "a ci change"]);
    const stub = stubFetch({ "GET /repos/o/r": { json: { default_branch: "main" } } });
    try {
      const r = await forge().publishBranch({ worktree: rg.wt, branch: "agent/42" });
      assert.deepEqual(r, { workflow: ".github/workflows/x.yml" });
      assert.equal(rg.remoteAgent42(), "", "the guard runs BEFORE any push");
    } finally {
      stub.restore();
    }
  } finally {
    rg.cleanup();
  }
});

test("publishBranch (real git): a merge whose resolution ADDS a workflow file also refuses — {workflow}, nothing on the remote", async () => {
  const rg = realGit();
  try {
    // Two divergent edits to README (a conflict), then a merge whose resolution ALSO adds a
    // workflow file — so no plain commit in the range touches .github/workflows/ and only a
    // merge-aware diff (-m / the net FETCH_HEAD...HEAD diff) can see it.
    rg.g(rg.wt, ["checkout", "--quiet", "-b", "side"]);
    fs.writeFileSync(path.join(rg.wt, "README.md"), "base\nside\n");
    rg.g(rg.wt, ["commit", "--quiet", "-am", "side edit"]);
    rg.g(rg.wt, ["checkout", "--quiet", "agent/42"]);
    fs.writeFileSync(path.join(rg.wt, "README.md"), "base\nmain\n");
    rg.g(rg.wt, ["commit", "--quiet", "-am", "main edit"]);
    try {
      rg.g(rg.wt, ["merge", "--no-ff", "--no-commit", "side"]); // the README conflict
    } catch {
      /* expected: the conflict is resolved below */
    }
    fs.writeFileSync(path.join(rg.wt, "README.md"), "base\nmain\nside\n");
    fs.mkdirSync(path.join(rg.wt, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(rg.wt, ".github", "workflows", "x.yml"), "on: [push]\n");
    rg.g(rg.wt, ["add", "-A"]);
    rg.g(rg.wt, ["commit", "--quiet", "-m", "merge: resolution adds a workflow file"]);
    const stub = stubFetch({ "GET /repos/o/r": { json: { default_branch: "main" } } });
    try {
      const r = await forge().publishBranch({ worktree: rg.wt, branch: "agent/42" });
      assert.deepEqual(r, { workflow: ".github/workflows/x.yml" });
      assert.equal(rg.remoteAgent42(), "", "the guard runs BEFORE any push");
    } finally {
      stub.restore();
    }
  } finally {
    rg.cleanup();
  }
});
