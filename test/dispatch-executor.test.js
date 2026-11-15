import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The executor axis (#682): which launcher a run picks — host or the profile's sandbox — chosen
// per run after the harness resolves. executorFor answers exactly what isSandboxed answered
// before this axis existed; the harness name never flips it (yet).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createExecutors, executorFor } from "../src/dispatch/executor.js";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store.js";
import { createSandbox } from "../src/sandbox/index.js";
import { mangle } from "../src/paths.js";

/** Pre-#682 golden values (captured from master @8d6e6e4, before this axis existed), normalized
 * the same way the fixtures below normalize their own actual values — `<ROOT>` for the fixture's
 * tmpdir, `<MANGLEDROOT>` for its `mangle()`d form (the claude transcript mount), `<DOCKERROOT>`
 * for the fake-docker HOME, and `REF` for the ref. Regenerate by running the equivalent fixture
 * against a `git worktree add` checkout of the pre-#682 commit if `src/prompts.js`/the agent's
 * argv/env building ever changes on purpose. */
const GOLDEN = JSON.parse(fs.readFileSync(new URL("./fixtures/dispatch-executor-golden.json", import.meta.url), "utf8"));

const spawnPaths = {
  verdictPathFor: (stepId, ref) => `/state/verdicts/${ref}-${stepId}.json`,
  sandboxVerdictPathFor: (stepId, ref) => `/state/verdicts/run-${ref}-${stepId}/verdict.json`,
};
const fakeSandbox = { wrap: async (o) => ({ ...o, id: "box-1", kill: async () => {}, done: async () => ({}) }), reap: async () => ({ containers: [], networks: [], runs: [] }) };

test("createExecutors: no sandbox configured -> only host", () => {
  const executors = createExecutors({ sandbox: null, spawnPaths });
  assert.deepEqual(Object.keys(executors), ["host"]);
  assert.equal(executors.host.name, "host");
});

test("createExecutors: a configured sandbox adds the sandbox executor, wrapping sandbox.wrap/reap verbatim", async () => {
  const executors = createExecutors({ sandbox: fakeSandbox, spawnPaths });
  assert.equal(executors.sandbox?.name, "sandbox");
  const run = await executors.sandbox.launch({ bin: "b", args: [], env: {} });
  assert.equal(run.id, "box-1");
  assert.deepEqual(await executors.sandbox.reap(), { containers: [], networks: [], runs: [] });
});

test("executorFor: sandbox exactly when a sandbox block is configured and the step did not opt out", () => {
  const executors = createExecutors({ sandbox: fakeSandbox, spawnPaths });
  assert.equal(executorFor({ sandbox: { type: "docker" } }, { id: "code" }, null, executors).name, "sandbox");
  assert.equal(executorFor({ sandbox: { type: "docker" } }, undefined, null, executors).name, "sandbox");
});

test("executorFor: host when no sandbox block is configured", () => {
  const executors = createExecutors({ sandbox: null, spawnPaths });
  assert.equal(executorFor({}, { id: "code" }, null, executors).name, "host");
  assert.equal(executorFor({ sandbox: { type: "docker" } }, { id: "code" }, null, { host: executors.host }).name, "host", "no sandbox executor built -> host even if cfg has a sandbox block");
});

test("executorFor: host when the step opts out with sandbox:false, even with a sandbox block configured", () => {
  const executors = createExecutors({ sandbox: fakeSandbox, spawnPaths });
  assert.equal(executorFor({ sandbox: { type: "docker" } }, { id: "code", sandbox: false }, null, executors).name, "host");
});

test("executorFor: a harnessed step under routing:first-free with two harnesses never flips the executor — the queue's harness pick rides along unused", () => {
  const executors = createExecutors({ sandbox: fakeSandbox, spawnPaths });
  const cfg = { sandbox: { type: "docker" }, harnesses: { a: {}, b: {} } };
  const step = { id: "code", harness: ["a", "b"], routing: /** @type {const} */ ("first-free") };
  for (const harnessName of ["a", "b", null, undefined]) {
    assert.equal(executorFor(cfg, step, harnessName, executors).name, "sandbox");
    assert.equal(executorFor(cfg, { ...step, sandbox: false }, harnessName, executors).name, "host");
  }
});

test("Executor.paths: host resolves the plain verdict path and the worktree/repo cwd; sandbox resolves the per-run verdict path", () => {
  const executors = createExecutors({ sandbox: fakeSandbox, spawnPaths });
  const withWorktree = { stepId: "code", ref: "42", worktree: "/wt/42", hasWorktree: true, repoPath: "/repo" };
  assert.deepEqual(executors.host.paths(withWorktree), { cwd: "/wt/42", worktree: "/wt/42", verdictFile: "/state/verdicts/42-code.json" });
  assert.deepEqual(executors.sandbox.paths(withWorktree), { cwd: "/wt/42", worktree: "/wt/42", verdictFile: "/state/verdicts/run-42-code/verdict.json" });
  const noWorktree = { stepId: "triage", ref: "7", worktree: "/wt/7", hasWorktree: false, repoPath: "/repo" };
  assert.deepEqual(executors.host.paths(noWorktree), { cwd: "/repo", worktree: undefined, verdictFile: "/state/verdicts/7-triage.json" });
});

// --- fixture: a real run, end to end, through the real dispatcher (#682 AC2) ---
// runStep now resolves the harness, then the executor, then derives cwd/verdictFile from
// `executor.paths()` — three steps that used to be one (`isSandboxed`) and two independent
// helpers (`verdictPathFor`/`sandboxVerdictPathFor`). This proves the reordering wired them
// back together correctly: the actual spawned argv (host) / `wrap()` mounts + egress rules
// (sandbox), and the prompt sidecar's embedded verdict path, come out exactly as the
// pre-#682 code built them — and are byte-identical (modulo the ref each run happens to use)
// whichever of a `routing: "first-free"` step's two harnesses the queue picked (AC1).

/** 12 zero bytes -> a fixed nonce, so the prompt sidecar is deterministic across runs. */
function pinNonce() {
  const orig = crypto.randomBytes;
  crypto.randomBytes = /** @type {any} */ ((n) => Buffer.alloc(n, 0));
  return () => {
    crypto.randomBytes = orig;
  };
}

function gitRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-dexec-")));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (/** @type {string[]} */ args) => execFileSync("git", args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  g(["init", "-q", "-b", "master"]);
  fs.writeFileSync(path.join(repo, "a"), "1");
  g(["add", "."]);
  g(["commit", "-qm", "one"]);
  return { root, repo };
}

/** The "claude" bin for both fixtures: records its own argv + AGENTHOOK_VERDICT_FILE + the step
 * env's CLAUDE_CODE_OAUTH_TOKEN + its own cwd under $CAPTURE_DIR, keyed by the ref (the worktree
 * dirname), then writes the verdict. */
const CAPTURE_CLAUDE = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const ref = path.basename(process.cwd());
const dir = process.env.CAPTURE_DIR;
fs.writeFileSync(path.join(dir, ref + ".argv.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(dir, ref + ".verdictfile.txt"), process.env.AGENTHOOK_VERDICT_FILE ?? "");
fs.writeFileSync(path.join(dir, ref + ".oauth.txt"), process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "");
fs.writeFileSync(path.join(dir, ref + ".cwd.txt"), process.cwd());
fs.writeFileSync(process.env.AGENTHOOK_VERDICT_FILE, JSON.stringify({ outcome: "advance", reason: "ok" }));
`;

const FAKE_DOCKER = `#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_FAKE_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "run") process.exit(0);
if (args[1] === "-d") {
  const m = args.find((a) => a.endsWith(",dst=/egress"));
  const dir = m && m.slice("type=bind,src=".length, -",dst=/egress".length);
  if (dir) fs.writeFileSync(dir + "/ready", "3128");
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

/** Both fixtures below share this: a two-harness, routing:first-free "code" step, run twice
 * (once per harness, each on its own ref so the worktrees don't collide), capturing argv/env
 * for the host fixture and docker argv for the sandbox one.
 * @param {{sandbox?: any}} [sandboxCfg]
 * @param {(sandbox: ReturnType<typeof createSandbox>) => any} [wrapSandbox]  wraps the real
 *   sandbox so a test can intercept `wrap()`'s own input (AC2's golden) without changing what
 *   it does. */
function harnessFixture(sandboxCfg, wrapSandbox = (s) => s) {
  const { root, repo } = gitRepo();
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  const captureDir = path.join(root, "capture");
  fs.mkdirSync(captureDir);
  const claude = path.join(root, "claude.mjs");
  fs.writeFileSync(claude, CAPTURE_CLAUDE, { mode: 0o755 });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", createsWorktree: true, harness: ["a", "b"], routing: "first-free", env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-fixture-token" } }, { id: "done", manual: true }],
    harnesses: { a: {}, b: {} },
    claudeBin: claude,
    repoPath: repo,
    worktreePrefix: path.join(root, "wts"),
    stateKey: "p",
    stateDir: state,
    dataDir: state,
    logDir: state,
    instructionsFile: path.join(root, "none.md"),
    agentEnvPassthrough: ["CAPTURE_DIR"],
    ...(sandboxCfg ? { sandbox: sandboxCfg } : {}),
  });
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment", egressHosts: ["api.tracker.test"] }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "a fixture ticket", description: "d", url: "https://example.test/issues/1", completed: false, assignedToUs: true }),
    advance: async () => {},
  });
  const store = createStore(state);
  const run = createDispatcher(cfg, adapter, undefined, store, () => {}, null, undefined, { killGraceMs: 200, sandbox: sandboxCfg ? wrapSandbox(createSandbox(cfg)) : null });
  /** @param {string} ref @param {string} harness */
  const go = async (ref, harness) => {
    process.env.CAPTURE_DIR = captureDir;
    const l = console.log;
    console.log = () => {};
    try {
      return await run({ kind: "pipeline", ref, stepId: "code", dedupKey: `k:${ref}`, harness });
    } finally {
      console.log = l;
      delete process.env.CAPTURE_DIR;
    }
  };
  return { root, repo, state, captureDir, cfg, go };
}

/** The per-run prompt sidecar: dispatch writes it next to this ref's log file under `<logDir>`. */
function readPromptSidecar(state, ref) {
  const logFile = fs.readdirSync(state).find((f) => f.endsWith(`-${ref}.log`));
  return fs.readFileSync(path.join(state, logFile.replace(/\.log$/, ".prompt.md")), "utf8");
}

test("executor fixture (host, no sandbox configured): two harnesses on a routing:first-free step spawn byte-identical argv and prompt sidecar (modulo the ref) — the harness pick never changes the host executor's wiring", async () => {
  const unpin = pinNonce();
  const h = harnessFixture();
  try {
    await h.go("execa", "a");
    const promptA = readPromptSidecar(h.state, "execa").replaceAll("execa", "REF");
    const argvA = JSON.parse(fs.readFileSync(path.join(h.captureDir, "execa.argv.json"), "utf8")).map((/** @type {string} */ s) => s.replaceAll("execa", "REF"));
    const vfA = fs.readFileSync(path.join(h.captureDir, "execa.verdictfile.txt"), "utf8");
    assert.match(vfA, /\/verdicts\/execa-code\.json$/, "the plain per-ref verdict path, not the sandbox's per-run dir");

    await h.go("execb", "b");
    const promptB = readPromptSidecar(h.state, "execb").replaceAll("execb", "REF");
    const argvB = JSON.parse(fs.readFileSync(path.join(h.captureDir, "execb.argv.json"), "utf8")).map((/** @type {string} */ s) => s.replaceAll("execb", "REF"));
    const vfB = fs.readFileSync(path.join(h.captureDir, "execb.verdictfile.txt"), "utf8");
    assert.match(vfB, /\/verdicts\/execb-code\.json$/);

    assert.deepEqual(argvA, argvB, "the host argv (prompt, model/effort flags, permission tail) doesn't depend on which harness the queue picked");
    assert.equal(promptA, promptB, "the prompt sidecar text doesn't depend on which harness the queue picked");

    // AC2: not just A vs. B — pin against the pre-#682 code's own output (test/fixtures/
    // dispatch-executor-golden.json), so a refactor bug that affects both harnesses alike
    // (dropped env, changed cwd, a different prompt) still fails.
    const oauthA = fs.readFileSync(path.join(h.captureDir, "execa.oauth.txt"), "utf8");
    const cwdA = fs.readFileSync(path.join(h.captureDir, "execa.cwd.txt"), "utf8").replaceAll("execa", "REF").replaceAll(h.root, "<ROOT>");
    const vfNormA = vfA.replaceAll("execa", "REF").replaceAll(h.root, "<ROOT>");
    const promptNormA = promptA.replaceAll(h.root, "<ROOT>");
    const argvNormA = argvA.map((/** @type {string} */ s) => s.replaceAll(h.root, "<ROOT>"));
    assert.deepEqual(argvNormA, GOLDEN.host.argv, "spawned argv must match the pre-#682 host launch byte-for-byte");
    assert.equal(vfNormA, GOLDEN.host.vf, "the plain verdict path must match pre-#682");
    assert.equal(oauthA, GOLDEN.host.oauth, "the step's own env (CLAUDE_CODE_OAUTH_TOKEN) must still reach the agent");
    assert.equal(cwdA, GOLDEN.host.cwd, "the host run's cwd must match pre-#682 (the worktree)");
    assert.equal(promptNormA, GOLDEN.host.prompt, "the prompt sidecar text must match pre-#682 byte-for-byte");
  } finally {
    unpin();
  }
});

test("executor fixture (sandboxed): two harnesses on a routing:first-free step wrap() with byte-identical mounts + egress, and the prompt sidecar's verdict path is the per-run sandbox path — the harness pick never changes the sandbox executor's wiring", async () => {
  const unpin = pinNonce();
  // DOCKER is read once, at sandbox-factory creation time (createSandbox, inside harnessFixture) —
  // it has to be set before that call, not after.
  const dockerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ah-dexec-docker-"));
  const docker = path.join(dockerRoot, "fake-docker.mjs");
  fs.writeFileSync(docker, FAKE_DOCKER, { mode: 0o755 });
  const dockerLog = path.join(dockerRoot, "docker.log");
  const saved = { DOCKER: process.env.DOCKER, DOCKER_FAKE_LOG: process.env.DOCKER_FAKE_LOG, HOME: process.env.HOME };
  process.env.DOCKER = docker;
  process.env.DOCKER_FAKE_LOG = dockerLog;
  process.env.HOME = path.join(dockerRoot, "home");
  // Captured per go() call: the exact object the executor hands to sandbox.wrap() — mounts,
  // env (post-merge, post-containerEnv) and egress, before container.js turns them into argv.
  /** @type {any[]} */
  const wrapCalls = [];
  const h = harnessFixture({ type: "docker", image: "img:1" }, (real) => ({
    ...real,
    wrap: async (/** @type {any} */ o) => {
      wrapCalls.push(o);
      return real.wrap(o);
    },
  }));
  const mountsOf = (/** @type {string} */ ref) => {
    const calls = fs.readFileSync(dockerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const run = calls.find((/** @type {string[]} */ c) => c[0] === "run" && c[1] !== "-d" && c.some((/** @type {string} */ a) => a.includes(`agenthook.ref=${ref}`)));
    return run.flatMap((/** @type {string} */ x, /** @type {number} */ i) => (x === "--mount" ? [run[i + 1].replaceAll(ref, "REF")] : []));
  };
  try {
    await h.go("execa", "a");
    const promptA = readPromptSidecar(h.state, "execa").replaceAll("execa", "REF");
    const vfA = fs.readFileSync(path.join(h.captureDir, "execa.verdictfile.txt"), "utf8");
    assert.match(vfA, /\/verdicts\/run-execa-code\/verdict\.json$/, "the sandbox's own per-run verdict dir, not the plain host path");
    const mountsA = mountsOf("execa");

    await h.go("execb", "b");
    const promptB = readPromptSidecar(h.state, "execb").replaceAll("execb", "REF");
    const vfB = fs.readFileSync(path.join(h.captureDir, "execb.verdictfile.txt"), "utf8");
    assert.match(vfB, /\/verdicts\/run-execb-code\/verdict\.json$/);
    const mountsB = mountsOf("execb");

    assert.deepEqual(mountsA, mountsB, "wrap()'s mounts (worktree, git common dir, verdict dir, transcript dir) don't depend on which harness the queue picked");
    assert.ok(mountsA.some((m) => m.endsWith(",dst=" + path.join(h.state, "verdicts", "run-REF-code"))), mountsA.join("\n"));
    assert.equal(promptA, promptB, "the prompt sidecar text doesn't depend on which harness the queue picked");

    // AC2: pin wrap()'s own input — mounts, egress, cwd and the env sandboxedRun actually
    // contributes — against the pre-#682 golden, not just A vs. B (same reasoning as the host
    // fixture above). wrapCalls[0] is harness "a"'s run (go("execa", "a") ran first).
    const call = wrapCalls[0];
    const mangledRoot = mangle(h.root);
    const norm = (/** @type {string} */ s) => s.replaceAll(mangledRoot, "<MANGLEDROOT>").replaceAll("execa", "REF").replaceAll(h.root, "<ROOT>").replaceAll(dockerRoot, "<DOCKERROOT>");
    const mountsNorm = call.mounts.map((/** @type {any} */ m) => ({ path: norm(m.path), ...(m.dst ? { dst: norm(m.dst) } : {}), ...(m.ro ? { ro: true } : {}), ...(m.mask ? { mask: m.mask } : {}) }));
    const cwdNorm = norm(call.cwd);
    const envSubset = /** @type {Record<string, string>} */ ({});
    for (const k of Object.keys(GOLDEN.sandbox.envSubset)) if (k in call.env) envSubset[k] = norm(String(call.env[k]));
    assert.deepEqual(mountsNorm, GOLDEN.sandbox.mounts, "wrap()'s mounts must match the pre-#682 sandboxed launch byte-for-byte");
    assert.equal(cwdNorm, GOLDEN.sandbox.cwd, "wrap()'s cwd must match pre-#682");
    assert.deepEqual(call.egress, GOLDEN.sandbox.egress, "wrap()'s egress {mode, rules} must match pre-#682 — this is dropped by step.js if the policy build moves or breaks");
    assert.deepEqual(envSubset, GOLDEN.sandbox.envSubset, "wrap()'s env must still carry AGENTHOOK_VERDICT_FILE, the step's own env and the git-config env sandboxedRun.env contributes");
    assert.equal(promptA.replaceAll(h.root, "<ROOT>"), GOLDEN.sandbox.prompt, "the sandboxed prompt sidecar text must match pre-#682 byte-for-byte");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    unpin();
  }
});
