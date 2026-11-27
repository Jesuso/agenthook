import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The publish path's git hardening (src/forges/github.js, #829): every git call is bounded —
// a stalled fetch/push is killed after 60s and the fail reason says "timed out after 60s"
// (the step fails, the slot is released — nothing is held on a timeout) — and the profile's
// HOST_GIT_SAFE flags ride on the argv so a planted pre-push hook never runs; the forge token
// rides in the env (publishGitEnv) and must never surface in argv or in a quoted git failure.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createGithubForge, describeGitRunError, PUBLISH_GIT_RUN_OPTS } from "../src/forges/github.js";
import { HOST_GIT_TIMEOUT_MS, HOST_GIT_SAFE } from "../src/worktree.js";
import { makeStore, stubFetch } from "./_forge-helpers.js";

const TOKEN = "ghp_0123456789abcdef0123456789abcdef0123";

test("the publish git run options carry the hub-wide timeout and a kill signal", () => {
  assert.equal(PUBLISH_GIT_RUN_OPTS.timeout, HOST_GIT_TIMEOUT_MS, "a stalled fetch/push must fail the step, not hang the slot");
  assert.equal(HOST_GIT_TIMEOUT_MS, 60_000);
  assert.equal(PUBLISH_GIT_RUN_OPTS.killSignal, "SIGKILL");
});

test("a timeout kill (SIGKILL, nothing captured) names the timeout", () => {
  assert.equal(describeGitRunError({ killed: true, signal: "SIGKILL", stderr: "" }), "timed out after 60s");
  assert.equal(describeGitRunError({ killed: true, signal: "SIGKILL", stderr: undefined }), "timed out after 60s");
});

test("a real git failure keeps its stderr; stderr wins over a kill", () => {
  assert.equal(describeGitRunError({ stderr: "fatal: not a git repository\nmore" }), "fatal: not a git repository\nmore", "the full trimmed stderr — the caller takes the first line");
  assert.equal(describeGitRunError({ killed: true, signal: "SIGKILL", stderr: "remote ended connection" }), "remote ended connection");
  assert.equal(describeGitRunError({ message: "spawn git ENOENT" }), "spawn git ENOENT");
  assert.equal(describeGitRunError({ killed: false, signal: "SIGKILL", stderr: "" }), "", "a non-Node kill with no stderr has nothing to say");
});

// A recording fake `git` on PATH: every subcommand publishBranch uses answers empty/ok, so a
// publish run makes the full call sequence (ls-remote → fetch → log → log --no-merges → rev-list).
function withFakeGit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-fake-git-err-"));
  const record = path.join(dir, "record.jsonl");
  fs.writeFileSync(
    path.join(dir, "git"),
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: args }) + "\\n");
const SUBS = ["ls-remote", "fetch", "log", "rev-list", "push"];
const sub = args.find((a) => SUBS.includes(a)) || "";
let out = "";
if (sub === "rev-list") out = "0";
process.stdout.write(out);
process.exit(0);
`,
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  return {
    calls: () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).argv) : []),
    restore: () => {
      process.env.PATH = savedPath;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a profile with a remote harness: every publish git call rides the HOST_GIT_SAFE flags (a planted pre-push hook can't run)", async () => {
  const git = withFakeGit();
  const stub = stubFetch({ "GET /repos/o/r": { json: { default_branch: "main" } } });
  const f = createGithubForge(
    /** @type {any} */ ({
      pipeline: [],
      forge: { type: "github", token: TOKEN, repository: "o/r" },
      harnesses: { worker: { remote: { host: "w1", workDir: "/w" } } },
    }),
    /** @type {any} */ (makeStore()),
  );
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "ah-fake-wt-err-"));
  try {
    const r = await f.publishBranch({ worktree: wt, branch: "agent/42" });
    assert.deepEqual(r, { pushed: [] });
    const calls = git.calls();
    assert.ok(calls.length >= 4, `expected the full call sequence, saw ${calls.length}`);
    for (const argv of calls) {
      assert.deepEqual(argv.slice(0, HOST_GIT_SAFE.length), HOST_GIT_SAFE, `HOST_GIT_SAFE missing: ${JSON.stringify(argv)}`);
      assert.ok(!argv.join("\x00").includes(TOKEN), `the token must never appear in argv: ${JSON.stringify(argv)}`);
    }
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
    stub.restore();
    git.restore();
  }
});

test("a failed publish with quoted git stderr never surfaces the token (the env-only credential)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-bad-origin-"));
  const wt = path.join(dir, "clone");
  const notARepo = path.join(dir, "not-a-repo");
  const g = (cwd, args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  g(dir, ["init", "--quiet", "--bare", "-b", "main", path.join(dir, "origin.git")]);
  fs.mkdirSync(notARepo);
  g(dir, ["clone", "--quiet", path.join(dir, "origin.git"), wt]);
  g(wt, ["remote", "set-url", "origin", notARepo]); // existing dir that is not a git repo → a real fatal on fetch
  const f = createGithubForge(
    /** @type {any} */ ({ pipeline: [], forge: { type: "github", token: TOKEN, repository: "o/r" }, harnesses: { worker: { remote: { host: "w1", workDir: "/w" } } } }),
    /** @type {any} */ (makeStore()),
  );
  const stub = stubFetch({ "GET /repos/o/r": { json: { default_branch: "main" } } });
  try {
    const err = /** @type {Error} */ (
      await f
        .publishBranch({ worktree: wt, branch: "agent/42" })
        .then(() => null, (e) => e)
    );
    assert.ok(err instanceof Error, "the fetch failure threw");
    assert.match(err.message, /fetch main: fatal:/, "the reason quotes git's first stderr line (publishOutbox prefixes `publish:` above this)");
    assert.doesNotMatch(err.message, new RegExp(TOKEN, "i"), `the token leaked into the reason: ${err.message}`);
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
