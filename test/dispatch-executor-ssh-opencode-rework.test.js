import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Remote harness phase 3 rework (#739): test/dispatch-executor-ssh-opencode.test.js covers the
// argv/stdin/env/file-lifetime contract, doctor and a happy-path dispatch run; it's already near
// the ~25 KB file-size convention, so this file holds the rework-review's four missing pieces —
// the #731 standing dedupe and the `remote setup failed` refusal (both dispatch-level, since
// they're only observable through step.js), plus teardown (kill/timeout, reap()) and an explicit
// check that no file content or the OPENCODE_CONFIG value ever reaches the recorded ssh argv.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { withFakeSsh, spawnCtx } from "./_ssh-helpers.js";
import { shQuote, createSshExecutor } from "../src/dispatch/executor-ssh.js";
import { opencode, buildOpencodeArgs } from "../src/agents/opencode.js";
import { createDispatcher } from "../src/dispatch/index.js";
import { createStore } from "../src/store/index.js";
import { promptPathFor } from "../src/dispatch/prompt.js";

/** A tiny git repo with one commit — a worktree-step dispatch run needs a real hub repo (#690
 * syncs HEAD to the worker before every run). @param {string} dir */
function initGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  g(["init", "--quiet", "-b", "main"]);
  g(["config", "user.email", "a@example.test"]);
  g(["config", "user.name", "a"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  g(["add", "README.md"]);
  g(["commit", "--quiet", "-m", "init"]);
}

// --- #731 dedupe + refusal, both only observable through step.js's remote branch ---

test("dispatch: a remote opencode run with standing instructions dedupes the worker's stdin to the TICKET marker + ticket, same as the sandboxed path (#731)", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-oc-standing-"));
  const workDir = path.join(root, "work");
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoPath);
  try {
    const agentScript = path.join(workDir, "opencode.sh");
    fs.writeFileSync(
      agentScript,
      [
        `#!/bin/sh`,
        `cat > "${workDir}/stdin.txt"`,
        `echo '{"type":"step_finish","sessionID":"s1","part":{"tokens":{"input":1,"output":1,"cache":{"read":0,"write":0}},"cost":0}}'`,
        `mkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"`,
        `echo '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"`,
        `exit 0`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const instructionsFile = path.join(root, "standing.md");
    fs.writeFileSync(instructionsFile, "STANDING-MARKER: do the minimal change.\n");
    const cfg = /** @type {any} */ ({
      pipeline: [{ id: "code", harness: "worker" }],
      harnesses: { worker: { agent: "opencode", remote: { host: "worker.test", workDir, bin: agentScript } } },
      repoPath,
      stateKey: "p",
      stateDir: root,
      dataDir: root,
      logDir: root,
      instructionsFile,
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
    try {
      const result = await run({ kind: "pipeline", ref: "78", stepId: "code", dedupKey: "k:78", harness: "worker" });
      assert.equal(result.code, 0, JSON.stringify(result));
    } finally {
      console.log = l;
    }
    const logFile = fs.readdirSync(root).find((f) => f.endsWith("-78.log"));
    assert.ok(logFile, "no log file for the run");
    const sidecar = fs.readFileSync(promptPathFor(path.join(root, logFile)), "utf8");
    const ticket = sidecar.split("=== TICKET ===\n\n")[1];
    assert.ok(ticket, "the sidecar must keep the undeduped standing + marker + ticket form");
    const stdin = fs.readFileSync(path.join(workDir, "stdin.txt"), "utf8");
    assert.equal(stdin, `=== TICKET ===\n\n${ticket}`, "the worker agent's stdin must be deduped to the marker + ticket only");
    assert.ok(!stdin.includes("STANDING-MARKER"), "the standing text itself must not be sent twice");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch: an invalid opencodeConfig on a remote opencode harness refuses the run before ssh ever spawns the worker", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-oc-refuse-"));
  const workDir = path.join(root, "work");
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoPath);
  try {
    const badConfig = path.join(root, "bad-opencode-config.json");
    fs.writeFileSync(badConfig, "not json");
    const cfg = /** @type {any} */ ({
      pipeline: [{ id: "code", harness: "worker", opencodeConfig: badConfig }],
      harnesses: { worker: { agent: "opencode", remote: { host: "worker.test", workDir, bin: "must-never-run" } } },
      repoPath,
      stateKey: "p",
      stateDir: root,
      dataDir: root,
      logDir: root,
      instructionsFile: path.join(root, "none.md"),
    });
    const store = createStore(root);
    const advanceCalls = [];
    const adapter = /** @type {any} */ ({
      describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
      fetchTask: async (ref) => ({ ref, name: "t", description: "d", url: "https://example.test/1", completed: false, assignedToUs: true }),
      advance: async (...a) => advanceCalls.push(a),
    });
    const run = createDispatcher(cfg, adapter, undefined, store, () => {}, null, undefined, { killGraceMs: 300 });
    const l = console.log;
    console.log = () => {};
    let result;
    try {
      result = await run({ kind: "pipeline", ref: "79", stepId: "code", dedupKey: "k:79", harness: "worker" });
    } finally {
      console.log = l;
    }
    assert.notEqual(result.code, 0, JSON.stringify(result));
    assert.equal(ssh.record().length, 0, "a refused run must never spawn the ssh client — nothing to clean up on the worker");
    assert.equal(advanceCalls.length, 1);
    assert.equal(advanceCalls[0][2].outcome, "fail");
    assert.match(advanceCalls[0][2].reason, new RegExp(`^remote setup failed: opencodeConfig ${badConfig}: `));
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- teardown: kill/timeout, reap(), and nothing from the files/env ever lands in ssh argv ---

test("ssh executor reap(): removes a leftover per-run opencode config dir and does not report it in `runs`", async () => {
  const ssh = withFakeSsh();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-reap-oc-"));
  try {
    const remote = { host: "worker.test", workDir };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const configDir = path.join(workDir, ".agenthook", "p", "runs", "9-code.opencode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "opencode.json"), "{}");
    const reaped = await executor.reap();
    assert.deepEqual(reaped.runs, [], "a leftover config dir is never echoed into reap()'s `runs` list — that's the pgid names only");
    assert.ok(!fs.existsSync(configDir), "the leftover per-run config dir must be removed by reap()");
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("ssh executor + opencode.remote: an explicit kill still removes the per-run config dir", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-oc-kill-"));
  const workDir = path.join(root, "work");
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const pidFile = path.join(root, "agent.pid");
    const agentScript = path.join(workDir, "sleepy-oc.sh");
    fs.writeFileSync(
      agentScript,
      [`#!/bin/sh`, `echo "$$" > ${shQuote(pidFile)}`, `trap '' TERM`, `cat > /dev/null`, `sleep 30`].join("\n"),
      { mode: 0o755 },
    );
    const remote = { host: "worker.test", workDir, bin: agentScript };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") } });
    const { verdictFile, configDir } = executor.paths({ stepId: "code", ref: "9" });
    const own = opencode.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code" }), dir: /** @type {string} */ (configDir), verdictFile });
    const children = new Set();
    const ctx = spawnCtx({ children, killGraceMs: 300 });
    const prompt = "do the opencode thing";
    const args = buildOpencodeArgs({ prompt, fullAuto: true });
    const promise = ctx.spawnAgent({
      agent: { defaults: { bin: "opencode" }, buildArgs: () => args, createParser: opencode.createParser },
      prompt,
      cwd: workDir,
      logPath: path.join(root, "run.log"),
      verdictFile,
      sandboxed: { ref: "9", stepId: "code", step: {}, mounts: [], files: own.files, env: own.env },
      executor,
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(pidFile), "the agent never started");
    assert.ok(fs.existsSync(/** @type {string} */ (configDir)), "the config dir must exist while the agent runs");
    const [child] = children;
    assert.ok(child, "the local ssh client was never tracked");
    ctx.killNow("9", child.pid);
    await promise;
    assert.ok(!fs.existsSync(/** @type {string} */ (configDir)), "the per-run config dir must be removed after an explicit kill, same as a clean exit");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor + opencode.remote: opencodeConfig content and the OPENCODE_CONFIG value never appear in the recorded ssh argv — only on stdin", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-oc-leak-"));
  const workDir = path.join(root, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ocr-secret-"));
  try {
    const goFile = path.join(workDir, "go");
    const agentScript = path.join(workDir, "opencode.sh");
    fs.writeFileSync(
      agentScript,
      [
        `#!/bin/sh`,
        `cat > /dev/null`,
        `touch "${workDir}/started"`,
        `while [ ! -f ${goFile} ]; do sleep 0.02; done`,
        `mkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"`,
        `echo '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"`,
        `exit 0`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const remote = { host: "worker.test", workDir, bin: agentScript };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") } });
    const { verdictFile, configDir } = executor.paths({ stepId: "code", ref: "9" });
    const cfgPath = path.join(cfgDir, "opencode.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ apiKey: "SECRET-MARKER-DO-NOT-LEAK" }));
    const own = opencode.remote({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code", opencodeConfig: cfgPath }), dir: /** @type {string} */ (configDir), verdictFile });

    const { spawnAgent } = spawnCtx();
    const prompt = "secret prompt text";
    const args = buildOpencodeArgs({ prompt, fullAuto: true });
    const launchPromise = spawnAgent({
      agent: { defaults: { bin: "opencode" }, buildArgs: () => args, createParser: opencode.createParser },
      prompt,
      cwd: workDir,
      logPath: path.join(root, "run.log"),
      verdictFile,
      sandboxed: { ref: "9", stepId: "code", step: {}, mounts: [], files: own.files, env: own.env },
      executor,
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(workDir, "started")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(goFile, "");
    await launchPromise;

    const allArgv = JSON.stringify(ssh.record());
    assert.ok(!allArgv.includes("SECRET-MARKER-DO-NOT-LEAK"), "opencodeConfig content must never reach the worker's own argv");
    assert.ok(!allArgv.includes(own.env.OPENCODE_CONFIG), "the OPENCODE_CONFIG path value is never baked as a literal into the launcher script — only the generic config dir is");
    assert.ok(!allArgv.includes(prompt), "the prompt must never reach argv either");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});
