import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The ssh executor (#689, experimental) through the real dispatcher: quota pacing/energy are
// skipped for a remote run, the hub-local verdict copy is guarded like a sandboxed run's, and a
// remote harness's leftover runs are reaped on boot recovery. Split from
// dispatch-executor-ssh.test.js (see #717-style splits).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shQuote } from "../src/dispatch/executor-ssh.js";
import { sandboxVerdictPathFor } from "../src/dispatch/spawn.js";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store/index.js";
import { initGitRepo, withFakeSsh } from "./_ssh-helpers.js";

// --- quota pacing / energy are skipped for a remote run (via the real dispatcher + claude agent) ---

/** One stream-json `rate_limit_event` line (parsed by agents/claude.js's parser), a result line,
 * then the verdict — emulates a real claude run closely enough to exercise quota/usage capture. */
const FAKE_REMOTE_CLAUDE = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const resetsAt = Math.floor(Date.now() / 1000) + 3600;
console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt } } } }));
console.log(JSON.stringify({ type: "result", result: "done", session_id: "s1", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 }));
fs.mkdirSync(path.dirname(process.env.AGENTHOOK_VERDICT_FILE), { recursive: true });
fs.writeFileSync(process.env.AGENTHOOK_VERDICT_FILE, JSON.stringify({ outcome: "advance", reason: "ok" }));
`;

test("a remote run never forwards its quota reading to onQuota, and never starts the energy sampler", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-quota-"));
  const workDir = path.join(root, "work");
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoPath);
  try {
    const agentScript = path.join(workDir, "fake-remote-claude.mjs");
    fs.writeFileSync(agentScript, FAKE_REMOTE_CLAUDE, { mode: 0o755 });
    const cfg = /** @type {any} */ ({
      pipeline: [{ id: "code", harness: "worker", energy: true }],
      harnesses: { worker: { remote: { host: "worker.test", workDir, bin: agentScript } } },
      energy: { usdPerKwh: 0.1, source: { type: "const", watts: 10 } },
      repoPath,
      stateKey: "p",
      stateDir: root,
      dataDir: root,
      logDir: root,
      instructionsFile: path.join(root, "none.md"),
    });
    const store = createStore(root);
    const adapter = /** @type {any} */ ({
      describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
      fetchTask: async (ref) => ({ ref, name: "t", description: "d", url: "https://example.test/1", completed: false, assignedToUs: true }),
      advance: async () => {},
    });
    let onQuotaCalls = 0;
    let energyStarted = 0;
    const energySampler = { start: () => energyStarted++, stop: async () => null };
    const run = createDispatcher(cfg, adapter, undefined, store, () => {}, null, undefined, {
      killGraceMs: 300,
      energySampler,
      onQuota: () => onQuotaCalls++,
    });
    const l = console.log;
    console.log = () => {};
    let result;
    try {
      result = await run({ kind: "pipeline", ref: "99", stepId: "code", dedupKey: "k:99", harness: "worker" });
    } finally {
      console.log = l;
    }
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(onQuotaCalls, 0, "a remote run's quota reading must not reach the pacer");
    assert.equal(energyStarted, 0, "a remote run must not start the energy sampler");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch: a remote run's running.json record carries `host` (the worker's) while in flight (#691)", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-host-"));
  const workDir = path.join(root, "work");
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoPath);
  try {
    const marker = path.join(workDir, "started");
    const goFile = path.join(workDir, "go");
    const agentScript = path.join(workDir, "slow-agent.sh");
    fs.writeFileSync(
      agentScript,
      `#!/bin/sh\ncat > /dev/null\ntouch ${shQuote(marker)}\nwhile [ ! -f ${shQuote(goFile)} ]; do sleep 0.05; done\nmkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"\necho '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"\nexit 0\n`,
      { mode: 0o755 },
    );
    const cfg = /** @type {any} */ ({
      pipeline: [{ id: "code", harness: "worker" }],
      harnesses: { worker: { remote: { host: "worker.test", workDir, bin: agentScript } } },
      repoPath,
      stateKey: "p",
      stateDir: root,
      dataDir: root,
      logDir: root,
      instructionsFile: path.join(root, "none.md"),
    });
    const store = createStore(root);
    const adapter = /** @type {any} */ ({
      describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
      fetchTask: async (ref) => ({ ref, name: "t", description: "d", url: "https://example.test/1", completed: false, assignedToUs: true }),
      advance: async () => {},
    });
    const run = createDispatcher(cfg, adapter, undefined, store, () => {}, null, undefined, { killGraceMs: 300 });
    const l = console.log;
    console.log = () => {};
    const promise = run({ kind: "pipeline", ref: "55", stepId: "code", dedupKey: "k:55", harness: "worker" });
    try {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.ok(fs.existsSync(marker), "the agent never started");
      const running = store.listRunning();
      assert.equal(running["55"]?.host, "worker.test", JSON.stringify(running));
      assert.equal(running["55"]?.harness, "worker");
      fs.writeFileSync(goFile, "");
      const result = await promise;
      assert.equal(result.code, 0, JSON.stringify(result));
    } finally {
      console.log = l;
    }
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- guard wiring at the full dispatch level: an ssh run's hub-local verdict copy is guarded ---

test("dispatch: an ssh run's hub-local verdict file is guarded like a sandboxed run's — a planted symlink is removed, not followed, leaving the run with no valid verdict", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-guard-"));
  const workDir = path.join(root, "work");
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoPath);
  try {
    const cfg = /** @type {any} */ ({
      // verdictRepairs: 0 so the only thing standing between the forged symlink and an "advance"
      // outcome is finish.js's own `if (sandboxed) guardSandboxVerdict(verdictFile)` — not a
      // separate, earlier guard call a repair/deduce turn would otherwise make in step.js first.
      pipeline: [{ id: "code", harness: "worker", verdictRepairs: 0, deduceVerdict: false }],
      harnesses: { worker: { remote: { host: "worker.test", workDir } } },
      repoPath,
      stateKey: "p",
      stateDir: root,
      dataDir: root,
      logDir: root,
      instructionsFile: path.join(root, "none.md"),
    });
    // The hub-local copy-back target for this exact run, computed the same way step.js does.
    const hubVerdictFile = sandboxVerdictPathFor(cfg, "code", "77");
    // A forged verdict, not junk: if the guard were skipped, readVerdict would follow the symlink
    // and happily parse this as the real run's own verdict, advancing the task — the guard's job
    // is to make an unguarded run and a guarded one behave differently, not just "look safe".
    const elsewhere = path.join(root, "elsewhere.json");
    fs.writeFileSync(elsewhere, JSON.stringify({ outcome: "advance", reason: "forged by a symlink, never written by the real agent" }));

    // A "remote" agent that, instead of writing a verdict, plants a symlink at the exact
    // hub-local path a compromised/racing worker could learn (e.g. by reading its own prior
    // run's copy-back target) — then exits clean with no verdict of its own.
    const agentScript = path.join(workDir, "plant-symlink.mjs");
    fs.writeFileSync(
      agentScript,
      `#!/usr/bin/env node\nimport fs from "node:fs";\ntry { fs.unlinkSync(${JSON.stringify(hubVerdictFile)}); } catch {}\nfs.symlinkSync(${JSON.stringify(elsewhere)}, ${JSON.stringify(hubVerdictFile)});\nconsole.log(JSON.stringify({ type: "result", result: "done", session_id: "s1", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 }));\n`,
      { mode: 0o755 },
    );
    cfg.harnesses.worker.remote.bin = agentScript;

    const store = createStore(root);
    let advanced;
    const adapter = /** @type {any} */ ({
      describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
      fetchTask: async (ref) => ({ ref, name: "t", description: "d", url: "https://example.test/1", completed: false, assignedToUs: true }),
      advance: async (ref, stepId, verdict) => {
        advanced = verdict;
      },
    });
    const run = createDispatcher(cfg, adapter, undefined, store, () => {}, null, undefined, { killGraceMs: 300 });
    const l = console.log;
    console.log = () => {};
    let result;
    try {
      result = await run({ kind: "pipeline", ref: "77", stepId: "code", dedupKey: "k:77", harness: "worker" });
    } finally {
      console.log = l;
    }
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.ok(fs.existsSync(elsewhere), "the symlink's target file must survive untouched");
    assert.equal(
      advanced?.outcome,
      "hold",
      `a run whose only "verdict" is a symlink to a forged one must hold, not advance on the attacker's say-so (got ${JSON.stringify(advanced)})`,
    );
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- boot wiring: a remote harness's leftover runs are reaped on boot recovery ---

test("boot: a remote harness's leftover runs are reaped and logged distinctly from the sandbox's", async () => {
  const { createServe } = await import("../src/engine/boot.js");
  const { createStore: makeStore } = await import("../src/store/index.js");
  const http = await import("node:http");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-boot-ssh-"));
  const cfg = /** @type {any} */ ({
    name: "p", stateKey: "p", provider: "local", stateDir: dir, dataDir: dir, logDir: path.join(dir, "logs"), port: 0,
    pipeline: [{ id: "code" }], publicUrlFile: path.join(dir, "public_url.txt"), pidFile: path.join(dir, "server.pid"), controlSock: path.join(dir, "c.sock"),
  });
  const store = makeStore(dir);
  const emitted = [];
  const sshExecutor = { name: "ssh", reap: async () => ({ containers: [], networks: [], runs: ["12/code"] }) };
  const state = /** @type {any} */ ({ server: http.createServer(), control: null });
  const serve = createServe(/** @type {any} */ ({
    cfg, state, store, sandbox: null, executors: { host: { name: "host" }, ssh: { worker: sshExecutor } },
    emit: (event, ref, step, extra) => emitted.push({ event, ref, step, ...extra }),
    startedAt: new Date().toISOString(), reconcileOnBoot: false,
    adapter: { registerWebhook: async () => {}, unregisterWebhooks: async () => {}, advance: async () => {} },
    forge: null,
    ingress: { describe: () => ({ name: "manual", ephemeral: false }), up: async () => ({ url: "https://x" }), down: async () => {} },
    heartbeat: { update: () => {} },
    queue: { enqueue: () => true },
    puller: { pull: async () => {} },
    quotaPacer: { reading: () => {} },
    restart: async () => ({}), decommission: async () => ({}), ops: {}, shutdown: () => {},
  }));
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  const { log, error } = console;
  const lines = [];
  console.log = console.error = (...a) => lines.push(a.join(" "));
  try {
    await serve();
  } finally {
    console.log = log;
    console.error = error;
    for (const sig of ["SIGINT", "SIGTERM"]) for (const l2 of process.listeners(sig)) if (!before[sig].includes(l2)) process.removeListener(sig, l2);
    state.control?.close();
    state.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(lines.some((l2) => l2.includes("[recover] reaped run(s) 12/code left on a remote worker")), lines.join("\n"));
  assert.ok(emitted.some((e) => e.event === "sandbox_reaped" && e.runs?.includes("12/code")));
});

// --- usage records: a remote run records where it lived (#830) ---

test("a remote run's usage.jsonl record carries `host` + `remoteCwd`; a local run's carries neither", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-usage-"));
  const workDir = path.join(root, "work");
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoPath);
  try {
    const agentScript = path.join(workDir, "usage-agent.mjs");
    fs.writeFileSync(agentScript, FAKE_REMOTE_CLAUDE, { mode: 0o755 });
    const base = /** @type {any} */ ({
      pipeline: [{ id: "code" }],
      repoPath,
      stateKey: "p",
      stateDir: root,
      dataDir: root,
      logDir: root,
      instructionsFile: path.join(root, "none.md"),
    });
    const adapter = /** @type {any} */ ({
      describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
      fetchTask: async (ref) => ({ ref, name: "t", description: "d", url: "https://example.test/1", completed: false, assignedToUs: true }),
      advance: async () => {},
    });
    const l = console.log;
    console.log = () => {};
    try {
      // Remote: the record must name the worker + the worker launch cwd (no-worktree step → exports dir).
      const store = createStore(root);
      let run = createDispatcher({ ...base, pipeline: [{ id: "code", harness: "worker" }], harnesses: { worker: { remote: { host: "worker.test", workDir, bin: agentScript } } } }, adapter, undefined, store, () => {}, null, undefined, { killGraceMs: 300 });
      let result = await run({ kind: "pipeline", ref: "99", stepId: "code", dedupKey: "k:99", harness: "worker" });
      assert.equal(result.code, 0, JSON.stringify(result));
      const remote = store.readUsage().at(-1);
      assert.equal(remote.host, "worker.test", JSON.stringify(remote));
      assert.equal(remote.remoteCwd, `${workDir}/.agenthook/p/exports/99-code`, JSON.stringify(remote));

      // Local: the same run shape must NOT gain the fields.
      const localBin = path.join(root, "local-agent.mjs");
      fs.writeFileSync(localBin, FAKE_REMOTE_CLAUDE, { mode: 0o755 });
      const store2 = createStore(root);
      run = createDispatcher({ ...base, claudeBin: localBin }, adapter, undefined, store2, () => {}, null, undefined, { killGraceMs: 300 });
      result = await run({ kind: "pipeline", ref: "100", stepId: "code", dedupKey: "k:100" });
      assert.equal(result.code, 0, JSON.stringify(result));
      const local = store2.readUsage().at(-1);
      assert.equal(local.host, undefined, JSON.stringify(local));
      assert.equal(local.remoteCwd, undefined, JSON.stringify(local));
    } finally {
      console.log = l;
    }
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
