import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// What dispatch hands a sandboxed run (src/dispatch/sandbox.js): git dirs, mounts, the env
// split, the container's git config. Pure, plus one real `git worktree add` fixture.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { trustedGitDirs, sandboxMounts, containerEnv, runtimeEnv, gitSandboxEnv, mergeGitConfigEnv, hostOf, hostGitFacts, inferredForgeEgressHosts, checkoutMasks } from "../src/dispatch/sandbox.js";
import { runGitEnv } from "../src/github-run-token.js";
import { HOST_GIT_TIMEOUT_MS, listWorktrees } from "../src/worktree.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
/** @param {string} cwd @param {string[]} args */
const g = (cwd, args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-dsbx-")));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  g(repo, ["init", "-q", "-b", "master"]);
  fs.writeFileSync(path.join(repo, "a"), "1");
  g(repo, ["add", "."]);
  g(repo, ["commit", "-qm", "one"]);
  const wt = path.join(root, "wts", "42");
  g(repo, ["worktree", "add", "-q", "-b", "agent/42", wt]);
  return { root, repo, wt };
}

test("trustedGitDirs: a git-worktree checkout resolves its admin dir and the main checkout's common dir", () => {
  const { repo, wt } = fixture();
  assert.deepEqual(trustedGitDirs(repo, wt), { gitDir: path.join(repo, ".git", "worktrees", "42"), commonDir: path.join(repo, ".git") });
  assert.deepEqual(trustedGitDirs(repo, repo), { gitDir: path.join(repo, ".git"), commonDir: path.join(repo, ".git") }, "a main checkout's .git is both");
  assert.throws(() => trustedGitDirs(path.join(repo, "nope"), wt), /is not a directory/);
});

// Review #481: the worktree's `.git` and the admin dir's `commondir` are agent-writable (both
// sit in rw mounts). Neither may ever choose a mount source — a tampered one refuses the run.
test("trustedGitDirs: a rewritten worktree .git (gitdir → operator home) is refused, never resolved", () => {
  const { root, repo, wt } = fixture();
  const home = path.join(root, "operator-home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${home}\n`);
  assert.throws(() => trustedGitDirs(repo, wt), /worktree git metadata does not point into/);
  // A look-alike admin dir elsewhere that names the real common dir is refused too.
  fs.writeFileSync(path.join(home, "commondir"), path.join(repo, ".git"));
  assert.throws(() => trustedGitDirs(repo, wt), /does not point into/);
});

test("trustedGitDirs: a rewritten commondir (→ operator home) is refused", () => {
  const { root, repo, wt } = fixture();
  const home = path.join(root, "operator-home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(repo, ".git", "worktrees", "42", "commondir"), home);
  assert.throws(() => trustedGitDirs(repo, wt), /does not point into/);
});

test("trustedGitDirs: a symlinked admin dir or a FIFO .git is refused without blocking", () => {
  const { root, repo, wt } = fixture();
  const admin = path.join(repo, ".git", "worktrees", "42");
  const moved = path.join(root, "moved-admin");
  fs.renameSync(admin, moved);
  fs.symlinkSync(moved, admin);
  assert.throws(() => trustedGitDirs(repo, wt), /does not point into/);
  fs.rmSync(path.join(wt, ".git"));
  execFileSync("mkfifo", [path.join(wt, ".git")]);
  assert.throws(() => trustedGitDirs(repo, wt), /does not point into/);
});

test("sandboxMounts (worktree): worktree + common rw, config + hooks ro (hooks created), verdict rw, then the agent's", () => {
  const { repo, wt } = fixture();
  const common = path.join(repo, ".git");
  fs.rmSync(path.join(common, "hooks"), { recursive: true, force: true });
  const m = sandboxMounts({ cwd: wt, hasWorktree: true, verdictDir: "/state/verdicts/run-42-code", gitCommonDir: common, agentMounts: [{ path: "/h/.claude/projects/x", dst: "/home/agent/.claude/projects/x" }] });
  assert.deepEqual(m, [
    { path: wt, ro: false },
    { path: common, ro: false },
    { path: path.join(common, "config"), ro: true },
    { path: path.join(common, "hooks"), ro: true },
    { path: "/state/verdicts/run-42-code" },
    { path: "/h/.claude/projects/x", dst: "/home/agent/.claude/projects/x" },
  ]);
  assert.ok(fs.statSync(path.join(common, "hooks")).isDirectory(), "hooks exists before the run, so the agent can't create it");
});

test("sandboxMounts (no worktree, e.g. triage): the main checkout and its git dir read-only, no overlays", () => {
  const { repo } = fixture();
  const common = path.join(repo, ".git");
  const m = sandboxMounts({ cwd: repo, hasWorktree: false, verdictDir: "/v", gitCommonDir: common });
  assert.deepEqual(m, [{ path: repo, ro: true }, { path: common, ro: true }, { path: "/v" }]);
});

test("sandboxMounts: a symlinked hooks or config (planted by an earlier run) is refused, not bind-mounted", () => {
  const { root, repo, wt } = fixture();
  const common = path.join(repo, ".git");
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.rmSync(path.join(common, "hooks"), { recursive: true, force: true });
  fs.symlinkSync(elsewhere, path.join(common, "hooks"));
  assert.throws(() => sandboxMounts({ cwd: wt, hasWorktree: true, verdictDir: "/v", gitCommonDir: common }), /hooks is not a directory/);
  fs.rmSync(path.join(common, "hooks"));
  fs.renameSync(path.join(common, "config"), path.join(elsewhere, "config"));
  fs.symlinkSync(path.join(elsewhere, "config"), path.join(common, "config"));
  assert.throws(() => sandboxMounts({ cwd: wt, hasWorktree: true, verdictDir: "/v", gitCommonDir: common }), /config is not a regular file/);
});

test("containerEnv drops host-only keys, keeps tokens and the verdict file; runtimeEnv keeps only the client's", () => {
  const env = {
    PATH: "/usr/bin", HOME: "/home/me", USER: "me", SSH_AUTH_SOCK: "/run/ssh", XDG_RUNTIME_DIR: "/run/user/1", TERM: "xterm", TERM_PROGRAM: "x",
    DOCKER_HOST: "unix:///x", NODE_OPTIONS: "--inspect", npm_config_cache: "/c", DBUS_SESSION_BUS_ADDRESS: "d",
    GH_TOKEN: "ghp", AGENTHOOK_VERDICT_FILE: "/v/verdict.json", CLAUDE_CODE_OAUTH_TOKEN: "o", UNDEF: undefined,
  };
  assert.deepEqual(containerEnv(env), { GH_TOKEN: "ghp", AGENTHOOK_VERDICT_FILE: "/v/verdict.json", CLAUDE_CODE_OAUTH_TOKEN: "o" });
  assert.deepEqual(runtimeEnv(env), { PATH: "/usr/bin", HOME: "/home/me", USER: "me", XDG_RUNTIME_DIR: "/run/user/1", DOCKER_HOST: "unix:///x" });
});

test("hostOf: scp-style, ssh:// and https remotes", () => {
  assert.equal(hostOf("git@github.com:o/r.git"), "github.com");
  assert.equal(hostOf("ssh://git@gitlab.example.com:2222/g/p.git"), "gitlab.example.com");
  assert.equal(hostOf("https://github.com/o/r"), "github.com");
  assert.equal(hostOf(undefined), undefined);
  assert.equal(hostOf("not a url"), undefined);
});

/** GIT_CONFIG_* env → [key, value] pairs. @param {Record<string, string>} env */
const pairsOf = (env) => Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);

test("gitSandboxEnv: an SSH github origin pushes over HTTPS with gh's helper, safe.directory, and the host author", () => {
  const env = gitSandboxEnv({ originUrl: "git@github.com:o/r.git", author: { name: "Op", email: "op@x" } });
  assert.deepEqual(pairsOf(env), [
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
    ["credential.https://github.com.helper", "!gh auth git-credential"],
    ["safe.directory", "*"],
    ["push.default", "current"],
  ]);
  assert.equal(env.GIT_AUTHOR_NAME, "Op");
  assert.equal(env.GIT_COMMITTER_NAME, "Op");
  assert.equal(env.GIT_AUTHOR_EMAIL, "op@x");
  assert.equal(env.GIT_COMMITTER_EMAIL, "op@x");
});

test("gitSandboxEnv: gitlab takes the host from forge.baseUrl and a GITLAB_TOKEN helper; no origin → safe.directory only", () => {
  const env = gitSandboxEnv({ originUrl: "git@other:g/p.git", forgeType: "gitlab", forgeBaseUrl: "https://gitlab.acme.io", author: {} });
  const pairs = pairsOf(env);
  assert.deepEqual(pairs[0], ["url.https://gitlab.acme.io/.insteadOf", "git@gitlab.acme.io:"]);
  assert.equal(pairs[2][0], "credential.https://gitlab.acme.io.helper");
  assert.match(pairs[2][1], /GITLAB_TOKEN/);
  assert.equal(env.GIT_AUTHOR_NAME, undefined);
  assert.deepEqual(pairsOf(gitSandboxEnv({})), [["safe.directory", "*"], ["push.default", "current"]]);
});

test("gitSandboxEnv skipHostAuth: a run-token sandboxed run drops the insteadOf/credential pairs, keeps safe.directory + author", () => {
  const env = gitSandboxEnv({ originUrl: "git@github.com:o/r.git", author: { name: "Op", email: "op@x" }, skipHostAuth: true });
  assert.deepEqual(pairsOf(env), [["safe.directory", "*"], ["push.default", "current"]]);
  assert.equal(env.GIT_AUTHOR_NAME, "Op");
});

// Review pass on #484's sandbox rework: skipHostAuth must only drop the insteadOf/credential
// pairs when the *resolved* host is github.com. A run token (#474) never covers another forge's
// host, so skipping there would strip that host's push credentials with nothing to replace them
// — a sandboxed run that could push before this merge would be unable to push after it.
test("gitSandboxEnv skipHostAuth: a non-github host keeps its own insteadOf/credential pairs (a github run token never covers it)", () => {
  const env = gitSandboxEnv({ originUrl: "git@gitlab.acme.io:o/r.git", forgeType: "gitlab", forgeBaseUrl: "https://gitlab.acme.io", skipHostAuth: true });
  const pairs = pairsOf(env);
  assert.deepEqual(pairs[0], ["url.https://gitlab.acme.io/.insteadOf", "git@gitlab.acme.io:"]);
  assert.equal(pairs[2][0], "credential.https://gitlab.acme.io.helper");
  assert.match(pairs[2][1], /GITLAB_TOKEN/);
});

test("mergeGitConfigEnv re-indexes a run token's git env (#474) and the sandbox's own, with no duplicate GIT_CONFIG_COUNT indices", () => {
  const creds = runGitEnv(); // GIT_CONFIG_COUNT=4 (reset, gh helper, two insteadOf), plus GIT_TERMINAL_PROMPT
  const sbx = gitSandboxEnv({ originUrl: "git@github.com:o/r.git", author: { name: "Op", email: "op@x" }, skipHostAuth: true }); // just safe.directory + author
  const merged = mergeGitConfigEnv(creds, sbx);
  assert.equal(Number(merged.GIT_CONFIG_COUNT), 6);
  assert.deepEqual(pairsOf(merged), [
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", "!gh auth git-credential"],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
    ["safe.directory", "*"],
    ["push.default", "current"],
  ]);
  assert.equal(merged.GIT_TERMINAL_PROMPT, "0");
  assert.equal(merged.GIT_AUTHOR_NAME, "Op");
  // Only a single, re-indexed GIT_CONFIG_COUNT — never two conflicting sets of KEY_n/VALUE_n.
  assert.equal(Object.keys(merged).filter((k) => k === "GIT_CONFIG_COUNT").length, 1);
});

test("sandboxMounts: the per-run GH_CONFIG_DIR (#474) mounts read-only as the directory, not a file, so a refresh's atomic rename is visible inside", () => {
  const { repo, wt } = fixture();
  const common = path.join(repo, ".git");
  const credsDir = path.join(path.dirname(repo), "run-creds-dir");
  fs.mkdirSync(credsDir);
  const m = sandboxMounts({ cwd: wt, hasWorktree: true, verdictDir: "/v", gitCommonDir: common, credsMount: credsDir });
  const mount = m.find((x) => x.path === credsDir);
  assert.ok(mount, "GH_CONFIG_DIR mount present");
  assert.equal(mount.ro, true);
  assert.ok(fs.statSync(mount.path).isDirectory(), "mount source is the dir, not hosts.yml itself");
});

// --- end to end through the real dispatcher, with $DOCKER pointing at a fake client ---
// The fake records its argv, and for `run` execs the inner `<bin> <args>` on the host in
// --workdir with only the `-e` names it was given (values from its own env) — like a runtime.

import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store.js";
import { createSandbox } from "../src/sandbox/index.js";

const FAKE_DOCKER = `#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_FAKE_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "run") process.exit(0);
if (args[1] === "-d") {
  // The egress proxy: come up at once (ready), with any denials the test asked for.
  const m = args.find((a) => a.endsWith(",dst=/egress"));
  const dir = m && m.slice("type=bind,src=".length, -",dst=/egress".length);
  if (dir) {
    fs.writeFileSync(dir + "/ready", "3128");
    if (process.env.DOCKER_FAKE_DENY) fs.writeFileSync(dir + "/denied.jsonl", process.env.DOCKER_FAKE_DENY);
  }
  process.exit(0);
}
const valued = new Set(["--pull", "--name", "--label", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus", "--user", "--mount", "--network"]);
const names = [];
let workdir;
let i = 1;
for (; i < args.length; i++) {
  const a = args[i];
  if (a === "-e") names.push(args[++i]);
  else if (a === "--workdir") workdir = args[++i];
  else if (valued.has(a)) i++;
  else if (!a.startsWith("-")) break;
}
const [, bin, ...rest] = args.slice(i);
const env = { PATH: process.env.PATH };
for (const n of names) {
  const eq = n.indexOf("=");
  if (eq > 0) env[n.slice(0, eq)] = n.slice(eq + 1);
  else if (process.env[n] !== undefined) env[n] = process.env[n];
}
const child = spawn(bin, rest, { cwd: workdir, env, stdio: "inherit" });
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 1));
`;

/** The agent's `run` (not the egress proxy's `run -d`). @param {string[]} c */
const isAgentRun = (c) => c[0] === "run" && c[1] !== "-d";

/** @param {any[]} steps @param {{inner?: string, forge?: any, sandbox?: any, runCredentials?: (o: any) => Promise<any>, agentEnvPassthrough?: string[]}} [o] */
function sandboxHarness(steps, { inner, forge = null, sandbox = { type: "docker", image: "img:1" }, runCredentials, agentEnvPassthrough } = {}) {
  const { root, repo } = fixture();
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  const docker = path.join(root, "fake-docker.mjs");
  fs.writeFileSync(docker, FAKE_DOCKER, { mode: 0o755 });
  const claude = path.join(root, "fake-claude.sh");
  const out = path.join(root, "inner.out");
  fs.writeFileSync(
    claude,
    inner ??
      `#!/bin/sh\nprintf 'VF=%s\\nSSH=%s\\nTOKEN=%s\\nPWD=%s\\nNOAUTO=%s\\nGITCOUNT=%s\\nGHCFG=%s\\nGHTOK=%s\\n' "$AGENTHOOK_VERDICT_FILE" "\${SSH_AUTH_SOCK-unset}" "\${CLAUDE_CODE_OAUTH_TOKEN-unset}" "$(pwd)" "\${DISABLE_AUTOUPDATER-unset}" "\${GIT_CONFIG_COUNT-unset}" "\${GH_CONFIG_DIR-unset}" "\${GITHUB_TOKEN-unset}" > "${out}"\nprintf '%s' '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"\n`,
    { mode: 0o755 },
  );
  const log = path.join(root, "docker.log");
  const cfg = /** @type {any} */ ({
    pipeline: steps, claudeBin: claude, repoPath: repo, worktreePrefix: path.join(root, "wts"),
    stateKey: "p", stateDir: state, dataDir: state, logDir: state, instructionsFile: path.join(root, "none.md"),
    sandbox,
    ...(agentEnvPassthrough ? { agentEnvPassthrough } : {}),
  });
  /** @type {any[]} */
  const advanced = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment", egressHosts: ["api.tracker.test"] }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ v) => void advanced.push({ ref, step, ...v }),
    ...(runCredentials ? { runCredentials } : {}),
  });
  const saved = { DOCKER: process.env.DOCKER, DOCKER_FAKE_LOG: process.env.DOCKER_FAKE_LOG, DOCKER_FAKE_DENY: process.env.DOCKER_FAKE_DENY, HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };
  process.env.DOCKER = docker;
  process.env.DOCKER_FAKE_LOG = log;
  process.env.HOME = path.join(root, "home"); // claude's transcript dir is created under it
  process.env.SSH_AUTH_SOCK = "/tmp/host-agent.sock";
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const store = createStore(state);
  /** @type {{event: string, ref: string, stepId: string, data: any}[]} */
  const events = [];
  const emit = (/** @type {string} */ event, /** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ data) => void events.push({ event, ref, stepId, data });
  const run = createDispatcher(cfg, adapter, undefined, store, emit, forge, undefined, { killGraceMs: 200, sandbox: createSandbox(cfg) });
  /** @param {string} stepId */
  const go = async (stepId) => {
    const l = console.log;
    console.log = () => {};
    try {
      await run({ kind: "pipeline", ref: "42", stepId, dedupKey: `k:${stepId}` });
    } finally {
      console.log = l;
    }
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const innerOut = () => (fs.existsSync(out) ? Object.fromEntries(fs.readFileSync(out, "utf8").trim().split("\n").map((l) => /** @type {[string, string]} */ (l.split(/=(.*)/s).slice(0, 2)))) : null);
  return { root, repo, state, cfg, run, go, store, advanced, calls, innerOut, restore, events };
}

test("sandbox e2e: a claude step runs through the runtime, routes on its per-run verdict, mounts its worktree", async () => {
  const h = sandboxHarness([{ id: "code", createsWorktree: true, env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-secret-9f3a" } }, { id: "done", manual: true }]);
  try {
    await h.go("code");
    assert.deepEqual(h.advanced.map((a) => [a.step, a.outcome, a.reason]), [["code", "advance", "ok"]]);
    const run = h.calls().find(isAgentRun);
    assert.ok(run, "the runtime client was spawned");
    const wt = path.join(h.root, "wts", "42");
    const mounts = run.flatMap((/** @type {string} */ x, /** @type {number} */ i) => (x === "--mount" ? [run[i + 1]] : []));
    assert.ok(mounts.includes(`type=bind,src=${wt},dst=${wt}`), mounts.join("\n"));
    assert.ok(mounts.includes(`type=bind,src=${path.join(h.repo, ".git", "config")},dst=${path.join(h.repo, ".git", "config")},readonly`));
    assert.ok(mounts.some((m) => m.startsWith(`type=bind,src=${path.join(h.root, "home", ".claude", "projects")}`)), "the transcript dir");
    assert.ok(!run.some((/** @type {string} */ x) => x.includes("sk-secret-9f3a")), "no env value in argv");
    const got = h.innerOut();
    assert.match(got?.VF ?? "", /\/verdicts\/run-42-code\/verdict\.json$/);
    assert.equal(got?.SSH, "unset", "host-only keys never reach the container");
    assert.equal(got?.TOKEN, "sk-secret-9f3a");
    assert.equal(got?.PWD, wt);
    assert.equal(got?.NOAUTO, "1");
    assert.notEqual(got?.GITCOUNT, "unset");
    assert.equal(fs.existsSync(path.join(h.state, "verdicts", "run-42-code")), false, "per-run verdict dir removed");
    assert.deepEqual(fs.readdirSync(path.join(h.state, "sandbox-home")), [], "per-run HOME removed");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a run-token adapter (#474) mounts GH_CONFIG_DIR read-only, passes its env, strips GITHUB_TOKEN from the container, and disposes once", async () => {
  const credsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-run-creds-"));
  fs.mkdirSync(path.join(credsDir, "gh"));
  fs.writeFileSync(path.join(credsDir, "gh", "hosts.yml"), "github.com:\n  oauth_token: ghs_x\n");
  let disposeCalls = 0;
  const runCredentials = async () => ({
    env: { GH_CONFIG_DIR: path.join(credsDir, "gh"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.https://github.com.helper", GIT_CONFIG_VALUE_0: "!gh auth git-credential" },
    strip: ["GH_TOKEN", "GITHUB_TOKEN"],
    label: "GitHub App token: o/r, expires soon",
    dispose: async () => void disposeCalls++,
  });
  const h = sandboxHarness([{ id: "code", createsWorktree: true, env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }], { runCredentials, agentEnvPassthrough: ["GITHUB_TOKEN"] });
  const savedToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "ghp_operator_secret";
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "advance");
    const run = h.calls().find(isAgentRun);
    assert.ok(run, "the runtime client was spawned");
    const mounts = run.flatMap((/** @type {string} */ x, /** @type {number} */ i) => (x === "--mount" ? [run[i + 1]] : []));
    assert.ok(mounts.includes(`type=bind,src=${path.join(credsDir, "gh")},dst=${path.join(credsDir, "gh")},readonly`), mounts.join("\n"));
    assert.ok(run.includes("GH_CONFIG_DIR"), "GH_CONFIG_DIR passed by name");
    assert.ok(run.includes("GIT_CONFIG_COUNT"), "a single, merged GIT_CONFIG_COUNT passed by name");
    assert.ok(!run.includes("GITHUB_TOKEN"), "stripped even though allowlisted and set in the receiver env");
    const got = h.innerOut();
    assert.equal(got?.GHCFG, path.join(credsDir, "gh"));
    assert.equal(got?.GHTOK, "unset", "the container never sees the receiver's GITHUB_TOKEN");
    assert.notEqual(got?.GITCOUNT, "unset");
    assert.equal(disposeCalls, 1, "dispose runs once after a normal exit");
  } finally {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
    fs.rmSync(credsDir, { recursive: true, force: true });
    h.restore();
  }
});

test("sandbox e2e: a no-worktree claude step (triage) mounts nothing under the host ~/.claude — its transcript goes to a receiver-owned dir", async () => {
  const h = sandboxHarness([{ id: "triage", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }]);
  g(h.repo, ["worktree", "remove", "--force", path.join(h.root, "wts", "42")]); // no worktree yet: cwd = the main checkout
  try {
    await h.go("triage");
    assert.equal(h.advanced[0]?.outcome, "advance");
    const run = h.calls().find(isAgentRun);
    assert.ok(run, "the runtime client was spawned");
    const srcs = run.flatMap((/** @type {string} */ x, /** @type {number} */ i) => (x === "--mount" ? [run[i + 1].split(",")[1].slice("src=".length)] : []));
    const hostClaude = path.join(h.root, "home", ".claude");
    assert.ok(!srcs.some((/** @type {string} */ s) => s === hostClaude || s.startsWith(hostClaude + path.sep)), srcs.join("\n"));
    assert.ok(srcs.includes(path.join(h.state, "sandbox-transcripts", h.repo.replace(/[^A-Za-z0-9]/g, "-"))), "the receiver-owned transcript dir");
    assert.ok(run.some((/** @type {string} */ x) => x === `type=bind,src=${h.repo},dst=${h.repo},readonly`), "the main checkout, read-only");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a sandboxed cursor step is refused and the runtime is never spawned", async () => {
  const h = sandboxHarness([{ id: "code", agent: "cursor" }, { id: "done", manual: true }]);
  try {
    await h.go("code");
    assert.equal(h.advanced[0].outcome, "fail");
    assert.match(h.advanced[0].reason, /cursor does not support the sandbox yet — the run is refused rather than run on the host \(set "sandbox": false on step "code"/);
    assert.deepEqual(h.calls(), []);
  } finally {
    h.restore();
  }
});

test("sandbox e2e: sandbox:false spawns the agent directly on the host (shared verdict path)", async () => {
  const h = sandboxHarness([{ id: "code", sandbox: false }, { id: "done", manual: true }]);
  try {
    await h.go("code");
    assert.equal(h.advanced[0].outcome, "advance");
    assert.deepEqual(h.calls(), []);
    assert.match(h.innerOut()?.VF ?? "", /\/verdicts\/42-code\.json$/);
    assert.equal(h.innerOut()?.SSH, "/tmp/host-agent.sock", "an unsandboxed run keeps the receiver's env");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a claude step with no credential var is refused with the setup-token reason", async () => {
  const h = sandboxHarness([{ id: "code" }, { id: "done", manual: true }]);
  const keys = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];
  const saved = keys.map((k) => [k, process.env[k]]);
  for (const k of keys) delete process.env[k];
  try {
    await h.go("code");
    assert.equal(h.advanced[0].outcome, "fail");
    assert.match(h.advanced[0].reason, /sandboxed claude has no credentials — run `claude setup-token`/);
    assert.deepEqual(h.calls(), []);
  } finally {
    for (const [k, v] of saved) if (v !== undefined) process.env[/** @type {string} */ (k)] = v;
    h.restore();
  }
});

test("sandbox e2e: a cancel mid-run force-stops the container (`kill <id>`) and fails the run", async () => {
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }], { inner: "#!/bin/sh\nexec sleep 30\n" });
  try {
    const done = h.go("code");
    // Wait for the fake client to be up (it logs first), not just spawned.
    for (let i = 0; i < 200 && !h.calls().some(isAgentRun); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(h.store.listRunning()["42"]?.pid, "running");
    assert.equal(h.run.cancel("42"), true);
    await done;
    const run = h.calls().find(isAgentRun);
    const name = run[run.indexOf("--name") + 1];
    assert.ok(h.calls().some((c) => c[0] === "kill" && c[1] === name), JSON.stringify(h.calls().map((c) => c.slice(0, 2))));
    assert.equal(h.advanced[0].outcome, "fail");
    assert.equal(h.advanced[0].reason, "cancelled by operator");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a cancel landing before the spawn (wrap pending) never starts the container", async () => {
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }], { inner: "#!/bin/sh\nexec sleep 30\n" });
  try {
    const done = h.go("code");
    assert.equal(h.run.cancel("42"), true, "flagged in the pre-spawn window");
    await done;
    assert.equal(h.calls().some(isAgentRun), false);
    assert.equal(h.advanced[0].outcome, "fail");
    assert.equal(h.advanced[0].reason, "cancelled by operator");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a worktree whose .git was rewritten by an earlier run is refused; nothing outside is mounted", async () => {
  const h = sandboxHarness([{ id: "review", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }]);
  const home = path.join(h.root, "operator-home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(h.root, "wts", "42", ".git"), `gitdir: ${home}\n`);
  try {
    await h.go("review");
    assert.equal(h.advanced[0].outcome, "fail");
    assert.match(h.advanced[0].reason, /^sandbox setup failed: worktree git metadata does not point into /);
    assert.deepEqual(h.calls(), [], "the runtime is never spawned");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: a FIFO verdict file is dropped (no verdict), never opened — the receiver doesn't hang", { timeout: 20000 }, async () => {
  const h = sandboxHarness([{ id: "code", requireVerdict: false, env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }], { inner: '#!/bin/sh\nmkfifo "$AGENTHOOK_VERDICT_FILE"\n' });
  try {
    await h.go("code");
    assert.equal(h.advanced[0].outcome, "advance", "a clean exit with no (readable) verdict");
    assert.equal(fs.existsSync(path.join(h.state, "verdicts", "run-42-code")), false);
  } finally {
    h.restore();
  }
});

test("sandbox e2e: an oversize verdict file is dropped unread", async () => {
  const big = `{"outcome":"hold","reason":"big"}` + " ".repeat(1024 * 1024 + 1);
  const h = sandboxHarness([{ id: "code", requireVerdict: false, env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }], { inner: `#!/bin/sh\nhead -c ${big.length} /dev/zero | tr '\\0' ' ' > "$AGENTHOOK_VERDICT_FILE"\nprintf '%s' '{"outcome":"hold","reason":"big"}' | dd of="$AGENTHOOK_VERDICT_FILE" conv=notrunc status=none\n` });
  try {
    await h.go("code");
    assert.equal(h.advanced[0].outcome, "advance", "the hold verdict was never read");
  } finally {
    h.restore();
  }
});

// Review #481 pass 3: the common git dir is rw in the container, so an agent can plant a FIFO at
// `.git/HEAD` (or `packed-refs`). git then blocks on open forever; every synchronous host git call
// is time-capped so a wedged repo fails the read instead of freezing the receiver's event loop.
test("hostGitFacts: a FIFO at the common dir's HEAD fails the reads within the cap, never hangs", { timeout: 20000 }, () => {
  const { repo } = fixture();
  g(repo, ["config", "user.name", "op"]);
  assert.equal(hostGitFacts(repo).author.name, "op", "sanity: reads work on a healthy repo");
  const head = path.join(repo, ".git", "HEAD");
  fs.rmSync(head);
  execFileSync("mkfifo", [head]);
  const t0 = Date.now();
  const facts = hostGitFacts(repo, { timeoutMs: 500 });
  assert.ok(Date.now() - t0 < 10000, "returned within the cap, not blocked on the FIFO");
  assert.deepEqual(facts, { originUrl: undefined, author: { name: undefined, email: undefined } });
});

test("worktree host git calls are time-capped (a FIFO HEAD can't wedge listWorktrees forever)", () => {
  assert.ok(HOST_GIT_TIMEOUT_MS > 0 && HOST_GIT_TIMEOUT_MS <= 120_000);
  const { repo } = fixture();
  assert.ok(listWorktrees(repo).length >= 2, "sanity: the capped helper still works");
});

// --- egress (#473), through the real container sandbox and dispatcher ---

test("sandbox e2e: the default allowlist puts the run on its internal network behind the proxy, with the tracker, forge and origin hosts", async () => {
  const forge = { describe: () => ({ name: "github", egressHosts: ["github.com", "api.github.com"] }) };
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }], { forge });
  g(h.repo, ["remote", "add", "origin", "https://git.origin.test:4443/o/r.git"]);
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "advance");
    const calls = h.calls();
    const net = calls.find((c) => c[0] === "network" && c[1] === "create");
    assert.ok(net?.includes("--internal"), JSON.stringify(calls.map((c) => c.slice(0, 2))));
    const agentRun = calls.find((c) => c[0] === "run" && c[1] !== "-d");
    assert.equal(agentRun[agentRun.indexOf("--network") + 1], net.at(-1));
    // allow.json is gone with the run's egress dir; the proxy's argv names the dir, the rules went in first.
    const proxy = calls.find((c) => c[0] === "run" && c[1] === "-d");
    assert.ok(proxy, "the proxy was started");
    assert.ok(calls.some((c) => c[0] === "rm" && c[1] === "-f" && c[2] === `${agentRun[agentRun.indexOf("--name") + 1]}-proxy`), "done() removed the proxy");
    assert.ok(calls.some((c) => c[0] === "network" && c[1] === "rm"), "done() removed the network");
    assert.deepEqual(fs.readdirSync(path.join(h.state, "egress")), [], "per-run egress dir removed");
    const end = h.events.find((e) => e.event === "run_end");
    assert.equal(end?.data.outcome, "advance");
    assert.equal(end?.data.egressDenied, undefined, "no denials, no field");
  } finally {
    h.restore();
  }
});

test("sandbox e2e: wrap() receives egress.rules with the model API, tracker, forge and origin hosts", async () => {
  const forge = { describe: () => ({ name: "github", egressHosts: ["github.com", "api.github.com"] }) };
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" }, egress: { allow: ["@npm"] } }, { id: "done", manual: true }], { forge, sandbox: { type: "docker", image: "img:1", egress: { deny: ["api.github.com"] } } });
  g(h.repo, ["remote", "add", "origin", "https://git.origin.test:4443/o/r.git"]);
  /** @type {any[]} */
  const wraps = [];
  const sb = /** @type {any} */ (createSandbox(h.cfg));
  const wrap = sb.wrap.bind(sb);
  sb.wrap = (/** @type {any} */ o) => (wraps.push(o), wrap(o));
  const run = createDispatcher(h.cfg, /** @type {any} */ ({ describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "c", egressHosts: ["api.tracker.test"] }), fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", assignedToUs: true }), advance: async () => {} }), undefined, h.store, () => {}, /** @type {any} */ (forge), undefined, { killGraceMs: 200, sandbox: sb });
  const l = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k" });
  } finally {
    console.log = l;
    h.restore();
  }
  assert.equal(wraps.length, 1);
  assert.deepEqual(wraps[0].egress, { mode: "allowlist", rules: ["api.anthropic.com", "api.tracker.test", "github.com", "git.origin.test:4443", "registry.npmjs.org"] }, "profile deny drops api.github.com; the step's allow adds @npm");
});

test("inferredForgeEgressHosts: a profile with no forge block gets the forge hosts its origin implies", () => {
  assert.deepEqual(inferredForgeEgressHosts("git@github.com:o/r.git"), ["github.com", "api.github.com", "uploads.github.com", "*.githubusercontent.com"]);
  assert.deepEqual(inferredForgeEgressHosts("https://github.com/o/r"), inferredForgeEgressHosts("git@github.com:o/r.git"));
  assert.deepEqual(inferredForgeEgressHosts("git@gitlab.acme.io:g/p.git"), ["gitlab.acme.io"]);
  assert.deepEqual(inferredForgeEgressHosts("https://git.acme.io/o/r.git"), [], "an unknown forge contributes nothing (the origin rule still covers the push)");
  assert.deepEqual(inferredForgeEgressHosts(undefined), []);
});

test("sandbox e2e: no forge block + a github origin → wrap() still allows api.github.com, so gh pr … works", async () => {
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }]);
  g(h.repo, ["remote", "add", "origin", "git@github.com:o/r.git"]);
  /** @type {any[]} */
  const wraps = [];
  const sb = /** @type {any} */ (createSandbox(h.cfg));
  const wrap = sb.wrap.bind(sb);
  sb.wrap = (/** @type {any} */ o) => (wraps.push(o), wrap(o));
  const asana = /** @type {any} */ ({ describe: () => ({ platform: "Asana", taskNoun: "task", trigger: "@agent", commentHowTo: "c", egressHosts: ["app.asana.com"] }), fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", assignedToUs: true }), advance: async () => {} });
  const run = createDispatcher(h.cfg, asana, undefined, h.store, () => {}, null, undefined, { killGraceMs: 200, sandbox: sb });
  const l = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k" });
  } finally {
    console.log = l;
    h.restore();
  }
  assert.equal(wraps.length, 1);
  assert.deepEqual(wraps[0].egress.rules, ["api.anthropic.com", "app.asana.com", "github.com", "api.github.com", "uploads.github.com", "*.githubusercontent.com"]);
});

test("sandbox e2e: a denial reported by done() lands in the run log and on run_end; the outcome is unchanged", async () => {
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }]);
  process.env.DOCKER_FAKE_DENY = [{ host: "example.com", port: 443 }, { host: "example.com", port: 443 }, { host: "169.254.169.254", port: 80 }].map((d) => JSON.stringify(d)).join("\n") + "\n";
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "advance", "denials never change the outcome");
    const end = h.events.find((e) => e.event === "run_end");
    assert.equal(end?.data.outcome, "advance");
    assert.deepEqual(end?.data.egressDenied, ["example.com:443", "169.254.169.254:80"]);
    const log = fs.readdirSync(h.state).filter((f) => f.endsWith(".log")).map((f) => fs.readFileSync(path.join(h.state, f), "utf8")).join("\n");
    assert.match(log, /\[agenthook\] egress denied: example\.com:443 \(2×\) — add it to sandbox\.egress\.allow/);
    assert.match(log, /\[agenthook\] egress denied: 169\.254\.169\.254:80 \(1×\)/);
  } finally {
    h.restore();
  }
});

test("sandbox e2e: egress mode none runs with --network none and starts no proxy", async () => {
  const h = sandboxHarness([{ id: "code", env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" }, egress: { mode: "none" } }, { id: "done", manual: true }]);
  try {
    await h.go("code");
    assert.equal(h.advanced[0]?.outcome, "advance");
    const calls = h.calls();
    assert.deepEqual(calls.map((c) => c[0]), ["run"], "no network, no proxy");
    assert.equal(calls[0][calls[0].indexOf("--network") + 1], "none");
  } finally {
    h.restore();
  }
});

test("checkoutMasks: gitignored files and dirs plus the config/.env extras are masked; tracked files, symlinks and outside paths are not", () => {
  const { root, repo } = fixture();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\nagenthook.config.json\nlogs/\nnode_modules/\n");
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=x");
  fs.writeFileSync(path.join(repo, "agenthook.config.json"), "{}");
  fs.mkdirSync(path.join(repo, "logs"));
  fs.writeFileSync(path.join(repo, "logs", "r.log"), "x");
  fs.writeFileSync(path.join(repo, "notes.local"), "untracked, not ignored");
  fs.symlinkSync(path.join(repo, ".env"), path.join(repo, "envlink"));
  fs.appendFileSync(path.join(repo, ".gitignore"), "envlink\n");
  const m = checkoutMasks(repo, { extra: [path.join(repo, "cfg.json"), path.join(root, "outside.env"), undefined] });
  fs.writeFileSync(path.join(repo, "cfg.json"), "{}"); // created after: a missing extra is skipped
  assert.deepEqual(m, [
    { path: path.join(repo, ".env"), mask: "file" },
    { path: path.join(repo, "agenthook.config.json"), mask: "file" },
    { path: path.join(repo, "logs"), mask: "dir" },
  ]);
  assert.deepEqual(checkoutMasks(repo, { extra: [path.join(repo, "cfg.json")] }).map((x) => path.basename(x.path)), [".env", "agenthook.config.json", "cfg.json", "logs"]);
});

test("checkoutMasks: a dir git can't list throws (the run is refused, never started with secrets visible)", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-nogit-")));
  assert.throws(() => checkoutMasks(dir), /could not list .*gitignored files/);
});

test("sandboxMounts: masks follow the read-only checkout of a no-worktree run, and are ignored for a worktree run", () => {
  const { repo, wt } = fixture();
  const common = path.join(repo, ".git");
  const masks = [{ path: path.join(repo, ".env"), mask: /** @type {const} */ ("file") }];
  const m = sandboxMounts({ cwd: repo, hasWorktree: false, verdictDir: "/v", gitCommonDir: common, masks });
  assert.deepEqual(m.slice(0, 2), [{ path: repo, ro: true }, masks[0]]);
  const w = sandboxMounts({ cwd: wt, hasWorktree: true, verdictDir: "/v", gitCommonDir: common, masks });
  assert.ok(!w.some((x) => x.mask));
});
