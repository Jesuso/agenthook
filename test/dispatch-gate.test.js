import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// A step's gate (#710): runGate always goes through the run's own executor — host spawns the
// argv directly, sandbox/ssh wrap it through executor.launch first. No network, no real spawn
// of docker/ssh — fake executors stand in, same pattern as test/dispatch-executor.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGate } from "../src/dispatch/gate.js";

/** A log file + the logLine helper step.js passes to runGate. */
function fakeLog() {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-gate-")), "run.log");
  fs.writeFileSync(logPath, "");
  return { logPath, logLine: (p, line) => fs.appendFileSync(p, `[agenthook] ${line}\n`) };
}

const hostExecutor = { name: "host" };

test("runGate on host: spawns the argv directly in cwd, exit code and tail come back", async () => {
  const { logPath, logLine } = fakeLog();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-gate-cwd-"));
  const r = await runGate({
    executor: hostExecutor,
    argv: ["sh", "-c", "echo hello-gate"],
    cwd,
    env: { PATH: process.env.PATH },
    timeoutMs: 5000,
    ref: "ref-1",
    stepId: "code",
    runId: "run-1",
    logPath,
    pids: new Map(),
    executorRuns: new Map(),
    cancelled: new Set(),
    logLine,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.match(r.tail, /hello-gate/);
  assert.match(fs.readFileSync(logPath, "utf8"), /hello-gate/);
});

test("runGate on host: a non-zero exit is reported, not thrown", async () => {
  const { logPath, logLine } = fakeLog();
  const r = await runGate({
    executor: hostExecutor,
    argv: ["sh", "-c", "echo boom >&2; exit 1"],
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH },
    timeoutMs: 5000,
    ref: "ref-2",
    stepId: "code",
    runId: "run-2",
    logPath,
    pids: new Map(),
    executorRuns: new Map(),
    cancelled: new Set(),
    logLine,
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.tail, /boom/);
});

test("runGate on host: a gate exceeding its timeout is killed and reported timedOut, not a crash", async () => {
  const { logPath, logLine } = fakeLog();
  const r = await runGate({
    executor: hostExecutor,
    argv: ["sleep", "5"],
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH },
    timeoutMs: 100,
    ref: "ref-3",
    stepId: "code",
    runId: "run-3",
    logPath,
    pids: new Map(),
    executorRuns: new Map(),
    cancelled: new Set(),
    logLine,
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
});

test("runGate: redacts a secret-looking env value found in the gate's output", async () => {
  const { logPath, logLine } = fakeLog();
  const r = await runGate({
    executor: hostExecutor,
    argv: ["sh", "-c", "echo \"token=$SECRET_TOKEN\""],
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH, SECRET_TOKEN: "sk-abcdefghijklmnopqrstuvwxyz0123456789" },
    timeoutMs: 5000,
    ref: "ref-4",
    stepId: "code",
    runId: "run-4",
    logPath,
    pids: new Map(),
    executorRuns: new Map(),
    cancelled: new Set(),
    logLine,
  });
  assert.equal(r.exitCode, 0);
  assert.ok(!r.tail.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), `tail should not leak the secret: ${r.tail}`);
});

test("runGate: an executor it cannot run on vetoes with a reason, never a host fallback", async () => {
  const { logPath, logLine } = fakeLog();
  let hostSpawned = false;
  const weirdExecutor = { name: "something-else" };
  const r = await runGate({
    executor: weirdExecutor,
    argv: ["sh", "-c", "touch /tmp/agenthook-gate-should-not-run"],
    cwd: os.tmpdir(),
    env: {},
    timeoutMs: 5000,
    ref: "ref-5",
    stepId: "code",
    runId: "run-5",
    logPath,
    pids: new Map(),
    executorRuns: new Map(),
    cancelled: new Set(),
    logLine,
  });
  assert.match(r.refused, /cannot run on the something-else executor/);
  assert.equal(fs.existsSync("/tmp/agenthook-gate-should-not-run"), hostSpawned);
});

test("runGate on sandbox: the argv reaches executor.launch (wrap), never a direct host spawn of it", async () => {
  const { logPath, logLine } = fakeLog();
  let launchCall;
  const sandboxExecutor = {
    name: "sandbox",
    launch: async (o) => {
      launchCall = o;
      return { bin: "sh", args: ["-c", "echo from-sandbox"], env: {}, id: "box-1", kill: async () => {}, done: async () => ({}) };
    },
  };
  const mounts = [{ src: "/host/path", dst: "/container/path" }];
  const r = await runGate({
    executor: sandboxExecutor,
    sandboxedRun: { mounts, step: { id: "code" } },
    argv: ["npm", "test"],
    cwd: "/container/cwd",
    env: { PATH: process.env.PATH },
    timeoutMs: 5000,
    ref: "ref-6",
    stepId: "code",
    runId: "run-6",
    logPath,
    pids: new Map(),
    executorRuns: new Map(),
    cancelled: new Set(),
    logLine,
  });
  assert.equal(r.exitCode, 0);
  assert.match(r.tail, /from-sandbox/);
  assert.equal(launchCall.bin, "npm");
  assert.deepEqual(launchCall.args, ["test"]);
  assert.deepEqual(launchCall.mounts, mounts);
});

test("runGate on ssh: launches with raw:true, never pulling a prompt off argv", async () => {
  const { logPath, logLine } = fakeLog();
  let launchCall;
  const sshExecutor = {
    name: "ssh",
    launch: async (o) => {
      launchCall = o;
      return { bin: "echo", args: ["from-ssh"], env: {}, id: "box-1", kill: async () => {}, done: async () => ({}) };
    },
  };
  const r = await runGate({
    executor: sshExecutor,
    sandboxedRun: { mounts: [], step: { id: "code" }, hub: { repoId: "r1", repoPath: "/repo", worktree: "/wt", branch: "agent/1" } },
    argv: ["sh", "-c", "npm test"],
    cwd: "/worker/cwd",
    env: {},
    timeoutMs: 5000,
    ref: "ref-7",
    stepId: "code",
    runId: "run-7",
    logPath,
    pids: new Map(),
    executorRuns: new Map(),
    cancelled: new Set(),
    logLine,
  });
  assert.equal(r.exitCode, 0);
  assert.equal(launchCall.raw, true);
  assert.deepEqual(launchCall.hub, { repoId: "r1", repoPath: "/repo", worktree: "/wt", branch: "agent/1" });
});
