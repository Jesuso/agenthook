import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// What dispatch hands a sandboxed run (src/dispatch/sandbox.js): git dirs, mounts, the env
// split, the container's git config. Pure, plus one real `git worktree add` fixture.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitDirsFor, sandboxMounts, containerEnv, runtimeEnv, gitSandboxEnv, hostOf } from "../src/dispatch/sandbox.js";

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

test("gitDirsFor: a git-worktree checkout resolves its admin dir and the common dir", () => {
  const { repo, wt } = fixture();
  const dirs = gitDirsFor(wt);
  assert.equal(dirs?.commonDir, path.join(repo, ".git"));
  assert.equal(dirs?.gitDir, path.join(repo, ".git", "worktrees", "42"));
  assert.deepEqual(gitDirsFor(repo), { gitDir: path.join(repo, ".git"), commonDir: path.join(repo, ".git") }, "a main checkout's .git is both");
  assert.equal(gitDirsFor(path.join(repo, "nope")), undefined);
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
  assert.deepEqual(pairsOf(gitSandboxEnv({})), [["safe.directory", "*"]]);
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
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "run") process.exit(0);
const valued = new Set(["--pull", "--name", "--label", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus", "--user", "--mount"]);
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

/** @param {any[]} steps @param {{inner?: string}} [o] */
function sandboxHarness(steps, { inner } = {}) {
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
      `#!/bin/sh\nprintf 'VF=%s\\nSSH=%s\\nTOKEN=%s\\nPWD=%s\\nNOAUTO=%s\\nGITCOUNT=%s\\n' "$AGENTHOOK_VERDICT_FILE" "\${SSH_AUTH_SOCK-unset}" "\${CLAUDE_CODE_OAUTH_TOKEN-unset}" "$(pwd)" "\${DISABLE_AUTOUPDATER-unset}" "\${GIT_CONFIG_COUNT-unset}" > "${out}"\nprintf '%s' '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"\n`,
    { mode: 0o755 },
  );
  const log = path.join(root, "docker.log");
  const cfg = /** @type {any} */ ({
    pipeline: steps, claudeBin: claude, repoPath: repo, worktreePrefix: path.join(root, "wts"),
    stateKey: "p", stateDir: state, dataDir: state, logDir: state, instructionsFile: path.join(root, "none.md"),
    sandbox: { type: "docker", image: "img:1" },
  });
  /** @type {any[]} */
  const advanced = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ v) => void advanced.push({ ref, step, ...v }),
  });
  const saved = { DOCKER: process.env.DOCKER, FAKE_DOCKER_LOG: process.env.FAKE_DOCKER_LOG, HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };
  process.env.DOCKER = docker;
  process.env.FAKE_DOCKER_LOG = log;
  process.env.HOME = path.join(root, "home"); // claude's transcript dir is created under it
  process.env.SSH_AUTH_SOCK = "/tmp/host-agent.sock";
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const store = createStore(state);
  const run = createDispatcher(cfg, adapter, undefined, store, () => {}, null, undefined, { killGraceMs: 200, sandbox: createSandbox(cfg) });
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
  return { root, repo, state, cfg, run, go, store, advanced, calls, innerOut, restore };
}

test("sandbox e2e: a claude step runs through the runtime, routes on its per-run verdict, mounts its worktree", async () => {
  const h = sandboxHarness([{ id: "code", createsWorktree: true, env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } }, { id: "done", manual: true }]);
  try {
    await h.go("code");
    assert.deepEqual(h.advanced.map((a) => [a.step, a.outcome, a.reason]), [["code", "advance", "ok"]]);
    const run = h.calls().find((c) => c[0] === "run");
    assert.ok(run, "the runtime client was spawned");
    const wt = path.join(h.root, "wts", "42");
    const mounts = run.flatMap((/** @type {string} */ x, /** @type {number} */ i) => (x === "--mount" ? [run[i + 1]] : []));
    assert.ok(mounts.includes(`type=bind,src=${wt},dst=${wt}`), mounts.join("\n"));
    assert.ok(mounts.includes(`type=bind,src=${path.join(h.repo, ".git", "config")},dst=${path.join(h.repo, ".git", "config")},readonly`));
    assert.ok(mounts.some((m) => m.startsWith(`type=bind,src=${path.join(h.root, "home", ".claude", "projects")}`)), "the transcript dir");
    assert.ok(!run.some((/** @type {string} */ x) => x.includes("tok")), "no env value in argv");
    const got = h.innerOut();
    assert.match(got?.VF ?? "", /\/verdicts\/run-42-code\/verdict\.json$/);
    assert.equal(got?.SSH, "unset", "host-only keys never reach the container");
    assert.equal(got?.TOKEN, "tok");
    assert.equal(got?.PWD, wt);
    assert.equal(got?.NOAUTO, "1");
    assert.notEqual(got?.GITCOUNT, "unset");
    assert.equal(fs.existsSync(path.join(h.state, "verdicts", "run-42-code")), false, "per-run verdict dir removed");
    assert.deepEqual(fs.readdirSync(path.join(h.state, "sandbox-home")), [], "per-run HOME removed");
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
    for (let i = 0; i < 200 && !h.calls().some((c) => c[0] === "run"); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(h.store.listRunning()["42"]?.pid, "running");
    assert.equal(h.run.cancel("42"), true);
    await done;
    const run = h.calls().find((c) => c[0] === "run");
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
    assert.equal(h.calls().some((c) => c[0] === "run"), false);
    assert.equal(h.advanced[0].outcome, "fail");
    assert.equal(h.advanced[0].reason, "cancelled by operator");
  } finally {
    h.restore();
  }
});
