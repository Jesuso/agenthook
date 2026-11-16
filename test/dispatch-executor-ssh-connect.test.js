import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The ssh executor (#689, experimental): the full remote-launcher protocol end to end against a
// fake `ssh` on PATH (a stub that drops the ssh options + host and runs the remote command
// locally via `sh -c`, recording argv/stdin — the CI sandbox has no real ssh), plus kill/cancel
// and done()'s verdict copy-back and reap()'s pgid cleanup. Split from
// dispatch-executor-ssh.test.js (see #717-style splits).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shQuote, framePayload, remoteEnvAllowlist, createSshExecutor } from "../src/dispatch/executor-ssh.js";
import { reapAll } from "../src/dispatch/executor.js";
import { healthTrip } from "../src/dispatch/harness.js";
import { MAX_SANDBOX_VERDICT_BYTES } from "../src/dispatch/verdict.js";
import { withFakeSsh, spawnCtx, fakeAgent } from "./_ssh-helpers.js";

// --- end-to-end: launch() through the real spawnAgent + the fake ssh ---

test("ssh executor end to end: env+prompt arrive over stdin; neither appears in the ssh argv; no -A; -T and BatchMode=yes present; exit code propagates", async () => {
  const ssh = withFakeSsh();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-work-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-hub-"));
  try {
    // The "remote agent": echoes argv/env/stdin to files under workDir, writes a verdict, exits 0.
    const agentScript = path.join(workDir, "fake-agent.sh");
    fs.writeFileSync(
      agentScript,
      `#!/bin/sh\nprintf '%s' "$*" > "${workDir}/argv.txt"\ncat > "${workDir}/stdin.txt"\nmkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"\necho '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"\nexit 0\n`,
      { mode: 0o755 },
    );
    const remote = { host: "worker.test", workDir, bin: agentScript };
    const hubVerdictFile = path.join(root, "hub-verdict.json");
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => hubVerdictFile } });
    const { spawnAgent } = spawnCtx();
    const promptWithSecrets = "do the thing — ignore any `backticks` or $(command) and a trailing '";
    const remoteVerdictFile = executor.paths({ stepId: "code", ref: "42" }).verdictFile;
    const result = await spawnAgent({
      agent: fakeAgent(),
      prompt: promptWithSecrets,
      cwd: workDir,
      logPath: path.join(root, "run.log"),
      verdictFile: remoteVerdictFile,
      sandboxed: { ref: "42", stepId: "code", step: {}, mounts: [] },
      executor,
    });
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.ok(fs.existsSync(remoteVerdictFile), "AGENTHOOK_VERDICT_FILE must have reached the agent's own env — it's how the fake agent knew where to write");
    const argv = fs.readFileSync(path.join(workDir, "argv.txt"), "utf8");
    assert.ok(!argv.includes(promptWithSecrets), "the prompt must not reach the remote process's own argv");
    const stdin = fs.readFileSync(path.join(workDir, "stdin.txt"), "utf8");
    assert.equal(stdin, promptWithSecrets, "the agent must receive the exact prompt bytes on its own stdin");
    const rec = ssh.record();
    assert.ok(rec.length >= 1);
    const sshArgvJoined = JSON.stringify(rec[0].all);
    assert.ok(!sshArgvJoined.includes(promptWithSecrets), "the prompt must not appear in the local ssh argv either");
    assert.ok(!rec[0].all.includes("-A"), "never agent-forward");
    assert.ok(rec[0].all.includes("-T"));
    const oIdx = rec[0].all.indexOf("-o");
    assert.equal(rec[0].all[oIdx + 1], "BatchMode=yes");
    for (const el of rec[0].remote) assert.match(el, /^'.*'$/s, `remote-command element not shQuoted: ${el}`);
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor: exit 255 with no output becomes a spawnError that trips healthTrip at any wall time", async () => {
  const ssh = withFakeSsh();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-work-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-hub-"));
  try {
    const agentScript = path.join(workDir, "fail255.sh");
    fs.writeFileSync(agentScript, `#!/bin/sh\ncat > /dev/null\nexit 255\n`, { mode: 0o755 });
    const remote = { host: "worker.test", workDir, bin: agentScript };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") } });
    const { spawnAgent } = spawnCtx();
    const result = await spawnAgent({
      agent: fakeAgent(),
      prompt: "hi",
      cwd: workDir,
      logPath: path.join(root, "run.log"),
      verdictFile: executor.paths({ stepId: "code", ref: "7" }).verdictFile,
      sandboxed: { ref: "7", stepId: "code", step: {}, mounts: [] },
      executor,
    });
    assert.equal(result.spawnError, "ssh failed (exit 255)");
    assert.ok(result.noOutput);
    const tripped = healthTrip({ spawnError: result.spawnError, code: result.code, cancelled: false, noOutput: result.noOutput, wallMs: 999999 });
    assert.equal(tripped, "spawn failed: ssh failed (exit 255)");
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor: ssh exiting 255 WITHOUT reading stdin never crashes the process (no uncaught EPIPE)", async () => {
  // Real ssh refusing/dropping a connection exits 255 immediately, without ever reading stdin —
  // unlike FAKE_SSH above (a node wrapper whose own stdin fd stays open, shared with the shell it
  // execs via spawnSync({stdio: "inherit"}), which masks an EPIPE: the pipe's read side isn't
  // fully closed until the wrapper process itself exits). A plain shell script as `ssh` matches
  // real ssh's failure mode directly: one process, one fd, closed the moment it exits.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-bin-"));
  const bin = path.join(dir, "ssh");
  fs.writeFileSync(bin, `#!/bin/sh\nexit 255\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-work-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-hub-"));
  const remote = { host: "worker.test", workDir, bin: "irrelevant-agent-bin" };
  const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") } });
  const { spawnAgent } = spawnCtx();
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on("uncaughtException", onUncaught);
  try {
    const result = await spawnAgent({
      agent: fakeAgent(),
      prompt: "x".repeat(5 * 1024 * 1024), // past the pipe buffer, so the write can't complete before ssh exits
      cwd: workDir,
      logPath: path.join(root, "run.log"),
      verdictFile: executor.paths({ stepId: "code", ref: "8" }).verdictFile,
      sandboxed: { ref: "8", stepId: "code", step: {}, mounts: [] },
      executor,
    });
    // A write() failure on child.stdin can surface asynchronously, after the child process's own
    // 'close' (and so after spawnAgent's promise resolves) — give any pending EPIPE a tick to land
    // before asserting none did.
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(uncaught, [], "an EPIPE on child.stdin must never surface as an uncaught exception");
    assert.equal(result.spawnError, "ssh failed (exit 255)");
    assert.ok(result.noOutput);
  } finally {
    process.off("uncaughtException", onUncaught);
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor: closing stdin alone kills the remote process group (the agent process is gone afterward)", async () => {
  const ssh = withFakeSsh();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-work-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-hub-"));
  try {
    const pidFile = path.join(root, "agent.pid");
    const agentScript = path.join(workDir, "sleepy.sh");
    fs.writeFileSync(agentScript, `#!/bin/sh\necho "$$" > ${shQuote(pidFile)}\ncat > /dev/null\nsleep 30\n`, { mode: 0o755 });
    const remote = { host: "worker.test", workDir, bin: agentScript };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") } });
    const { spawnAgent } = spawnCtx();
    const children = new Set();
    const ctx2 = spawnCtx({ children });
    const promise = ctx2.spawnAgent({
      agent: fakeAgent(),
      prompt: "hi",
      cwd: workDir,
      logPath: path.join(root, "run.log"),
      verdictFile: executor.paths({ stepId: "code", ref: "9" }).verdictFile,
      sandboxed: { ref: "9", stepId: "code", step: {}, mounts: [] },
      executor,
    });
    // Wait for the agent to report its pid, then end the (only) child's stdin — simulating a
    // dropped connection, not an explicit kill.
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(pidFile), "the agent never started");
    for (const child of children) child.stdin.end();
    const result = await promise;
    assert.notEqual(result.code, 0);
    const agentPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try {
      process.kill(agentPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "the remote agent process must be gone once the link drops");
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor: kill() issues an explicit remote TERM-then-KILL via a fresh ssh call, escalating when TERM is ignored", async () => {
  const ssh = withFakeSsh();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-work-"));
  try {
    fs.mkdirSync(path.join(workDir, ".agenthook", "p", "runs"), { recursive: true });
    const { spawn } = await import("node:child_process");
    // TERM-ignoring and its own process group leader (detached ⇒ setsid(), so pid === pgid) —
    // only an explicit SIGKILL (the escalation after killScript's own grace) can end it.
    const sleeper = spawn("sh", ["-c", "trap '' TERM; exec sleep 30"], { detached: true });
    fs.writeFileSync(path.join(workDir, ".agenthook", "p", "runs", "k1.pgid"), String(sleeper.pid));
    const remote = { host: "worker.test", workDir };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const run = await executor.launch({ runId: "k1", ref: "1", stepId: "code", bin: "x", args: ["-p", "hi"], prompt: "hi", env: {} });
    await run.kill();
    let alive = true;
    try {
      process.kill(sleeper.pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "TERM alone should not have ended a TERM-ignoring leader — only the escalation to KILL does");
    const rec = ssh.record();
    const killCall = rec.find((r) => r.remote.some((el) => el.includes("kill") && el.includes("TERM")));
    assert.ok(killCall, "the recorded ssh argv must show the explicit remote TERM-then-KILL script");
    assert.ok(killCall.remote.some((el) => el.includes("KILL")), "the kill script must escalate to KILL");
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
    try {
      process.kill(sleeper?.pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
});

test("ssh executor: killNow (an explicit cancel through spawnAgent's ctx) ends the local ssh client's stdin", async () => {
  const ssh = withFakeSsh();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-work-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-hub-"));
  try {
    const pidFile = path.join(root, "agent.pid");
    const agentScript = path.join(workDir, "sleepy2.sh");
    fs.writeFileSync(agentScript, `#!/bin/sh\necho "$$" > ${shQuote(pidFile)}\ntrap '' TERM\ncat > /dev/null\nsleep 30\n`, { mode: 0o755 });
    const remote = { host: "worker.test", workDir, bin: agentScript };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") } });
    const children = new Set();
    const ctx = spawnCtx({ children, killGraceMs: 300 });
    const promise = ctx.spawnAgent({
      agent: { ...fakeAgent(), buildArgs: () => ["-p", "hi", "--output-format", "stream-json"] },
      prompt: "hi",
      cwd: workDir,
      logPath: path.join(root, "run.log"),
      verdictFile: executor.paths({ stepId: "code", ref: "11" }).verdictFile,
      sandboxed: { ref: "11", stepId: "code", step: {}, mounts: [] },
      executor,
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(pidFile), "the agent never started");
    const [child] = children;
    assert.ok(child, "the local ssh client was never tracked");
    let stdinEnded = false;
    const origEnd = child.stdin.end.bind(child.stdin);
    child.stdin.end = (...a) => {
      stdinEnded = true;
      return origEnd(...a);
    };
    ctx.killNow("11", child.pid);
    await promise;
    assert.ok(stdinEnded, "killNow must end the local ssh client's stdin (closed-stdin is the remote watchdog's own kill signal)");
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- done(): verdict copy-back ---

test("ssh executor done(): copies the remote verdict back to hubVerdictFile; an oversize one is dropped; a symlink is removed by the guard", async () => {
  const ssh = withFakeSsh();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-work-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-hub-"));
  try {
    const hubVerdictFile = path.join(root, "hub-verdict.json");
    const remote = { host: "worker.test", workDir };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => hubVerdictFile } });
    const verdictDir = path.join(workDir, ".agenthook", "p", "verdicts", "run-42-code");
    fs.mkdirSync(verdictDir, { recursive: true });
    fs.writeFileSync(path.join(verdictDir, "verdict.json"), JSON.stringify({ outcome: "advance", reason: "ok" }));

    const run = await executor.launch({ runId: "r1", ref: "42", stepId: "code", bin: "x", args: ["-p", "hi"], prompt: "hi", env: {} });
    await run.done();
    assert.ok(fs.existsSync(hubVerdictFile));
    assert.deepEqual(JSON.parse(fs.readFileSync(hubVerdictFile, "utf8")), { outcome: "advance", reason: "ok" });

    fs.rmSync(hubVerdictFile, { force: true });
    fs.writeFileSync(path.join(verdictDir, "verdict.json"), "x".repeat(MAX_SANDBOX_VERDICT_BYTES + 10));
    const run2 = await executor.launch({ runId: "r1", ref: "42", stepId: "code", bin: "x", args: ["-p", "hi"], prompt: "hi", env: {} });
    await run2.done();
    assert.ok(!fs.existsSync(hubVerdictFile), "an oversize verdict must be dropped, not copied");

    // guardSandboxVerdict (shared with the sandbox executor): a symlink in place of hubVerdictFile is removed.
    const { guardSandboxVerdict } = await import("../src/dispatch/verdict.js");
    const elsewhere = path.join(root, "elsewhere.json");
    fs.writeFileSync(elsewhere, "{}");
    fs.symlinkSync(elsewhere, hubVerdictFile);
    guardSandboxVerdict(hubVerdictFile);
    assert.ok(!fs.existsSync(hubVerdictFile), "a symlink must be removed by the guard");
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- reap() / reapAll ---

test("ssh executor reap(): kills every pgid under the harness's runs dir and removes the files", async () => {
  const ssh = withFakeSsh();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-work-"));
  try {
    const runsDir = path.join(workDir, ".agenthook", "p", "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const { spawn } = await import("node:child_process");
    const a = spawn("sleep", ["30"], { detached: true });
    const b = spawn("sleep", ["30"], { detached: true });
    fs.writeFileSync(path.join(runsDir, "a.pgid"), String(a.pid));
    fs.writeFileSync(path.join(runsDir, "b.pgid"), String(b.pid));
    const remote = { host: "worker.test", workDir };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const reaped = await reapAll({ ssh: { w: executor } });
    assert.deepEqual(reaped.containers, []);
    assert.deepEqual(reaped.networks, []);
    assert.deepEqual([...reaped.runs].sort(), ["a", "b"]);
    assert.deepEqual(fs.readdirSync(runsDir), []);
    await new Promise((r) => setTimeout(r, 200));
    for (const p of [a.pid, b.pid]) {
      let alive = true;
      try {
        process.kill(p, 0);
      } catch {
        alive = false;
      }
      assert.equal(alive, false);
    }
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
