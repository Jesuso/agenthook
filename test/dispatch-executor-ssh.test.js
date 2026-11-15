import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The ssh executor (#689, experimental): shQuote/framePayload/remoteEnvAllowlist unit coverage,
// the full remote-launcher protocol end to end against a fake `ssh` on PATH (a stub that drops
// the ssh options + host and runs the remote command locally via `sh -c`, recording argv/stdin —
// the CI sandbox has no real ssh), the config refusals, and executorFor/reapAll wiring.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { shQuote, framePayload, remoteEnvAllowlist, createSshExecutor, createSshExecutors } from "../src/dispatch/executor-ssh.js";
import { createExecutors, executorFor, reapAll } from "../src/dispatch/executor.js";
import { createSpawn, sandboxVerdictPathFor } from "../src/dispatch/spawn.js";
import { healthTrip } from "../src/dispatch/harness.js";
import { MAX_SANDBOX_VERDICT_BYTES } from "../src/dispatch/verdict.js";
import { validateRawConfig } from "../src/config.js";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store.js";

// --- shQuote ---

test("shQuote: round-trips spaces, quotes, $, backticks, newlines and empty strings through a real shell", () => {
  for (const s of ["", "a b", "it's", "$HOME", "`cmd`", "line1\nline2", "a'b'c", "  leading/trailing  "]) {
    const out = execFileSync("sh", ["-c", `printf %s ${shQuote(s)}`], { encoding: "utf8" });
    assert.equal(out, s, `roundtrip failed for ${JSON.stringify(s)}`);
  }
});

// --- remoteEnvAllowlist ---

test("remoteEnvAllowlist: keeps AGENTHOOK_* and drops every forbidden family", () => {
  const env = {
    AGENTHOOK_VERDICT_FILE: "/x/verdict.json",
    AGENTHOOK_RUN_ID: "42-code",
    GH_TOKEN: "tracker-token",
    GITHUB_TOKEN: "forge-token",
    // the per-run GitHub App token family (github-run-token.js runGitEnv()/GH_CONFIG_DIR) — real
    // key names, real values, so a prefix match against "AGENTHOOK_" can't accidentally pass.
    GH_CONFIG_DIR: "/tmp/run-gh-config",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "!gh auth git-credential",
    GIT_TERMINAL_PROMPT: "0",
    ANTHROPIC_API_KEY: "sk-leak",
    ANTHROPIC_BASE_URL: "https://leak.test",
    CLAUDE_CODE_OAUTH_TOKEN: "leak",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    SOME_HARNESS_ENV_KEY: "not-on-the-list",
  };
  const out = remoteEnvAllowlist(env);
  assert.equal(out.AGENTHOOK_VERDICT_FILE, "/x/verdict.json");
  assert.equal(out.AGENTHOOK_RUN_ID, "42-code");
  for (const forbidden of [
    "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
    "GIT_TERMINAL_PROMPT", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "SSH_AUTH_SOCK", "SOME_HARNESS_ENV_KEY",
  ]) {
    assert.ok(!(forbidden in out), `${forbidden} should have been dropped`);
  }
});

test("remoteEnvAllowlist: TERM/LANG/CI come from the receiver's own env, not the input", () => {
  const saved = { TERM: process.env.TERM, LANG: process.env.LANG, CI: process.env.CI };
  process.env.TERM = "xterm-ssh-test";
  process.env.LANG = "en_US.UTF-8";
  process.env.CI = "true";
  try {
    const out = remoteEnvAllowlist({ TERM: "ignored-input-value" });
    assert.equal(out.TERM, "xterm-ssh-test");
    assert.equal(out.LANG, "en_US.UTF-8");
    assert.equal(out.CI, "true");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// --- framePayload ---

test("framePayload: a byte-length-prefixed prompt round-trips arbitrary bytes (quotes, $, backticks, newlines, unicode)", () => {
  const prompt = "ticket: it's a $weird `prompt`\nwith a newline and emoji 🎉 and a trailing '";
  const payload = framePayload({ AGENTHOOK_VERDICT_FILE: "/x/v.json" }, prompt);
  const [header, rest] = [payload.split("\n")[0], payload.slice(payload.indexOf("\n") + 1)];
  assert.equal(header, "1");
  assert.ok(rest.startsWith("AGENTHOOK_VERDICT_FILE=/x/v.json\n"));
  const afterEnv = rest.slice("AGENTHOOK_VERDICT_FILE=/x/v.json\n".length);
  const plen = Number(afterEnv.split("\n")[0]);
  assert.equal(plen, Buffer.byteLength(prompt, "utf8"));
  const promptBytes = afterEnv.slice(afterEnv.indexOf("\n") + 1);
  assert.equal(promptBytes, prompt);
});

// --- helpers shared by the end-to-end fixtures below ---

/** A tiny git repo with one commit, for tests that exercise the full dispatcher (#690 syncs the
 * repo's HEAD to the worker before every remote run, so `cfg.repoPath` must be a real repo).
 * @param {string} dir */
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

/** A fake `ssh`: drops -T/-o/-p/-i/-l (+ value) and the host, then runs the remaining
 * (already shQuoted by the executor) argv joined with spaces through a real shell — exactly
 * how real ssh hands its trailing argv to the remote shell. Records the post-strip argv (one
 * JSON line per invocation) so a test can assert nothing sensitive reached it. */
const FAKE_SSH = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
const args = process.argv.slice(2);
const valued = new Set(["-o", "-p", "-i", "-l"]);
let i = 0;
while (i < args.length) {
  const a = args[i];
  if (a === "-T") { i++; continue; }
  if (valued.has(a)) { i += 2; continue; }
  break;
}
i++; // the host
const remoteArgv = args.slice(i);
if (process.env.SSH_RECORD) fs.appendFileSync(process.env.SSH_RECORD, JSON.stringify({ all: args, remote: remoteArgv }) + "\\n");
const cmdLine = remoteArgv.join(" ");
const r = spawnSync("sh", ["-c", cmdLine], { stdio: "inherit" });
process.exit(r.status ?? 1);
`;

function withFakeSsh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-bin-"));
  const bin = path.join(dir, "ssh");
  fs.writeFileSync(bin, FAKE_SSH, { mode: 0o755 });
  const record = path.join(dir, "record.jsonl");
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  process.env.SSH_RECORD = record;
  return {
    record: () => (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    restore: () => {
      process.env.PATH = savedPath;
      delete process.env.SSH_RECORD;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A minimal spawnAgent ctx (see src/dispatch/spawn.js createSpawn's destructure). */
function spawnCtx(extra = {}) {
  return createSpawn(/** @type {any} */ ({
    cfg: {}, children: new Set(), killGraceMs: 300, killTimers: new Map(), meta: {}, forge: null, sandbox: null,
    executorRuns: new Map(), cancelled: new Set(), ...extra,
  }));
}

/** A fake agent whose parser just renders stdout as log text and reports output>0 once it sees
 * any; `buildArgs` mimics claude's own shape (prompt at args[1]) — executor-ssh.js's launch()
 * relies on that position to pull the prompt off argv and onto stdin. */
function fakeAgent() {
  const tally = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  return {
    defaults: { bin: "claude" },
    buildArgs: ({ prompt }) => ["-p", prompt, "--output-format", "stream-json"],
    createParser: () => ({
      push: (chunk) => {
        tally.output += chunk.length;
        return chunk;
      },
      flush: () => "",
      tally,
      result: null,
      quota: null,
      pushStderr: () => {},
    }),
  };
}

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
    const run = await executor.launch({ runId: "k1", ref: "1", stepId: "code", bin: "x", args: ["-p", "hi"], env: {} });
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

    const run = await executor.launch({ runId: "r1", ref: "42", stepId: "code", bin: "x", args: ["-p", "hi"], env: {} });
    await run.done();
    assert.ok(fs.existsSync(hubVerdictFile));
    assert.deepEqual(JSON.parse(fs.readFileSync(hubVerdictFile, "utf8")), { outcome: "advance", reason: "ok" });

    fs.rmSync(hubVerdictFile, { force: true });
    fs.writeFileSync(path.join(verdictDir, "verdict.json"), "x".repeat(MAX_SANDBOX_VERDICT_BYTES + 10));
    const run2 = await executor.launch({ runId: "r1", ref: "42", stepId: "code", bin: "x", args: ["-p", "hi"], env: {} });
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

test("reapAll: one executor throwing doesn't block reaping the rest", async () => {
  const calls = [];
  const bad = { name: "ssh", reap: async () => { throw new Error("unreachable"); } };
  const good = { name: "ssh", reap: async () => (calls.push("good"), { containers: [], networks: [], runs: ["ok"] }) };
  const result = await reapAll({ ssh: { bad, good } });
  assert.deepEqual(calls, ["good"]);
  assert.deepEqual(result.runs, ["ok"]);
});

// --- executorFor ---

test("executorFor: a remote harness's ssh executor wins over the profile's sandbox", () => {
  const sshExec = { name: "ssh", paths: () => ({}), launch: async () => ({}) };
  const executors = { host: { name: "host" }, sandbox: { name: "sandbox" }, ssh: { remote1: sshExec } };
  assert.equal(executorFor({ sandbox: { type: "docker" } }, { id: "code" }, "remote1", executors), sshExec);
  assert.equal(executorFor({ sandbox: { type: "docker" } }, { id: "code" }, "other", executors).name, "sandbox");
  assert.equal(executorFor({}, { id: "code" }, "remote1", { host: { name: "host" } }).name, "host", "no ssh executor built -> host");
});

test("createExecutors: builds one ssh executor per harness with a remote block; none without any", () => {
  const spawnPaths = { verdictPathFor: () => "/v", sandboxVerdictPathFor: () => "/sv" };
  const cfg = { stateKey: "p", harnesses: { a: { remote: { host: "h", workDir: "/w" } }, b: {} } };
  const executors = createExecutors({ cfg, sandbox: null, spawnPaths });
  assert.deepEqual(Object.keys(executors.ssh), ["a"]);
  const noneRemote = createExecutors({ cfg: { stateKey: "p", harnesses: { b: {} } }, sandbox: null, spawnPaths });
  assert.equal(noneRemote.ssh, undefined);
});

// --- config refusals ---

function baseConfig(overrides = {}) {
  return {
    name: "p",
    tracker: { type: "local", pipeline: [{ id: "code", harness: "worker" }] },
    repoPath: "/repo",
    harnesses: { worker: { remote: { host: "h", workDir: "/w" } } },
    ...overrides,
  };
}

test("config refusal: a remote harness used by a sandboxed step", () => {
  const cfg = baseConfig({ sandbox: { type: "docker" } });
  const v = validateRawConfig(cfg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("remote harness") && e.includes("sandboxed")), v.errors.join("\n"));
});

test("config refusal: GitHub App auth would mint per-run credentials for a remote harness", () => {
  const cfg = baseConfig({ tracker: { type: "github", pipeline: [{ id: "code", harness: "worker" }], auth: { type: "app", appId: "1", installationId: "2", privateKey: "x" } } });
  const v = validateRawConfig(cfg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("GitHub App credentials")), v.errors.join("\n"));
});

test("config refusal: a remote harness resolving to a non-claude agent", () => {
  const cfg = baseConfig({ harnesses: { worker: { agent: "cursor", remote: { host: "h", workDir: "/w" } } } });
  const v = validateRawConfig(cfg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('resolves to agent "cursor"')), v.errors.join("\n"));
});

test("config refusal: a remote harness on a non-local tracker", () => {
  const cfg = baseConfig({ tracker: { type: "jira", pipeline: [{ id: "code", harness: "worker" }] } });
  const v = validateRawConfig(cfg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('"tracker.type" is "jira"')), v.errors.join("\n"));
});

test("config: a remote harness on an unsandboxed, non-App-auth, claude, local-tracker step is accepted", () => {
  const v = validateRawConfig(baseConfig());
  assert.equal(v.ok, true, v.ok ? "" : v.errors.join("\n"));
});

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

// --- code transport (#690): sync the ticket's code to the worker over git+SSH, and back ---

/** A fake worktree-step agent (its launcher cwd IS the synced worktree, #690): drains stdin,
 * commits one new/changed file under a distinct name per run (so a second round never collides
 * with "nothing to commit"), writes a verdict, exits 0.
 * @param {string} dir @param {string} filename */
function writeCommitAgent(dir, filename) {
  const p = path.join(dir, "commit-agent.sh");
  fs.writeFileSync(
    p,
    `#!/bin/sh\ncat > /dev/null\ngit config user.email a@test.local\ngit config user.name a\necho hi > ${shQuote(filename)}\ngit add ${shQuote(filename)}\ngit commit --quiet -m ${shQuote(`worker commit ${filename}`)}\nmkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"\necho '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"\nexit 0\n`,
    { mode: 0o755 },
  );
  return p;
}

/** @param {string} repoPath @returns {string} the committed HEAD sha */
function headOf(repoPath) {
  return execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

test("ssh executor code transport (#690): a worktree step's agent commits on the worker come back fast-forwarded into the hub worktree; a rework run force-pushes the advanced branch", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-sync-"));
  const workerRoot = path.join(root, "worker");
  const hubWorktree = path.join(root, "hub-worktree");
  fs.mkdirSync(workerRoot, { recursive: true });
  initGitRepo(hubWorktree);
  const branch = "agent/1";
  execFileSync("git", ["-C", hubWorktree, "checkout", "-b", branch], { stdio: "ignore" });
  try {
    const remote = { host: "worker.test", workDir: workerRoot, bin: writeCommitAgent(workerRoot, "r1.txt") };
    const cfg = { harnesses: { worker: { remote } } };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") }, cfg });
    const { cwd, verdictFile } = executor.paths({ stepId: "code", ref: "1", hasWorktree: true });
    const hub = { repoId: "default", repoPath: hubWorktree, worktree: hubWorktree, branch };
    const { spawnAgent } = spawnCtx();
    const headBefore = headOf(hubWorktree);

    const r1 = await spawnAgent({ agent: fakeAgent(), prompt: "go", cwd, logPath: path.join(root, "r1.log"), verdictFile, sandboxed: { ref: "1", stepId: "code", step: {}, mounts: [], hub }, executor });
    assert.equal(r1.code, 0, JSON.stringify(r1));
    assert.ok(!r1.sandboxReport?.failed, JSON.stringify(r1.sandboxReport));
    assert.notEqual(headOf(hubWorktree), headBefore, "the hub worktree must have advanced");
    assert.match(execFileSync("git", ["-C", hubWorktree, "log", "-1", "--format=%s"], { encoding: "utf8" }), /worker commit r1\.txt/);
    assert.ok(!fs.existsSync(cwd), "the worker worktree must be removed after done()");

    // Simulate a crashed prior run: its done() never got to run, so the worker worktree is
    // still linked to the branch AND has a commit the hub never got — diverged and ahead, not
    // behind. The next launch must (a) clear that stale worktree before the push (receive-pack
    // refuses to move a branch "currently checked out"), and (b) force-overwrite the divergent
    // tip outright — a plain fast-forward push would be rejected too. The hub is authoritative.
    const gitPath = path.join(workerRoot, ".agenthook", "p", "repos", "default.git");
    const staleWorktree = cwd; // the SAME deterministic path a real crash would have left linked
    execFileSync("git", ["-C", gitPath, "worktree", "add", "-f", staleWorktree, branch], { stdio: "ignore" });
    execFileSync("git", ["-C", staleWorktree, "config", "user.email", "a@test.local"], { stdio: "ignore" });
    execFileSync("git", ["-C", staleWorktree, "config", "user.name", "a"], { stdio: "ignore" });
    fs.writeFileSync(path.join(staleWorktree, "stale.txt"), "stale\n");
    execFileSync("git", ["-C", staleWorktree, "add", "stale.txt"], { stdio: "ignore" });
    execFileSync("git", ["-C", staleWorktree, "commit", "--quiet", "-m", "stale worker-only commit"], { stdio: "ignore" });
    assert.ok(fs.existsSync(staleWorktree), "the stale worktree must still be linked, simulating a crash before cleanup");

    // Rework: a second remote run on the same ref pushes the hub's now-advanced branch and works.
    remote.bin = writeCommitAgent(workerRoot, "r2.txt");
    const headBeforeRework = headOf(hubWorktree);
    const r2 = await spawnAgent({ agent: fakeAgent(), prompt: "go again", cwd, logPath: path.join(root, "r2.log"), verdictFile, sandboxed: { ref: "1", stepId: "code", step: {}, mounts: [], hub }, executor });
    assert.equal(r2.code, 0, JSON.stringify(r2));
    assert.ok(!r2.sandboxReport?.failed, JSON.stringify(r2.sandboxReport));
    assert.notEqual(headOf(hubWorktree), headBeforeRework, "the second run must also advance the hub worktree");
    assert.match(execFileSync("git", ["-C", hubWorktree, "log", "-1", "--format=%s"], { encoding: "utf8" }), /worker commit r2\.txt/);
    assert.ok(!fs.existsSync(staleWorktree), "the stale worktree must have been cleared before the force-push");
    assert.doesNotMatch(execFileSync("git", ["-C", hubWorktree, "log", "--format=%s"], { encoding: "utf8" }), /stale worker-only commit/, "the divergent worker-only commit must have been overwritten, not merged in");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor code transport (#690): a dirty hub worktree refuses the run before spawn; the hub file is untouched", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-sync-dirty-"));
  const workerRoot = path.join(root, "worker");
  const hubWorktree = path.join(root, "hub-worktree");
  fs.mkdirSync(workerRoot, { recursive: true });
  initGitRepo(hubWorktree);
  fs.writeFileSync(path.join(hubWorktree, "README.md"), "hi\nmodified, never committed\n");
  try {
    const remote = { host: "worker.test", workDir: workerRoot };
    const cfg = { harnesses: { worker: { remote } } };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") }, cfg });
    const { cwd, verdictFile } = executor.paths({ stepId: "code", ref: "2", hasWorktree: true });
    const hub = { repoId: "default", repoPath: hubWorktree, worktree: hubWorktree, branch: "main" };
    const { spawnAgent } = spawnCtx();
    const result = await spawnAgent({ agent: fakeAgent(), prompt: "go", cwd, logPath: path.join(root, "run.log"), verdictFile, sandboxed: { ref: "2", stepId: "code", step: {}, mounts: [], hub }, executor });
    assert.equal(result.code, 1);
    assert.match(result.refused ?? "", /uncommitted changes/, JSON.stringify(result));
    assert.equal(fs.readFileSync(path.join(hubWorktree, "README.md"), "utf8"), "hi\nmodified, never committed\n");
  } finally {
    ssh.restore();
    // A refused launch() never spawns a child; the log stream's own close is scheduled, not
    // awaited, by spawn.js's unspawned() path — give it a tick before the dir goes away.
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor code transport (#690): a worktree with .gitmodules, or a .gitattributes with filter=lfs, refuses with a clear message", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-sync-lfs-"));
  const workerRoot = path.join(root, "worker");
  fs.mkdirSync(workerRoot, { recursive: true });
  try {
    for (const [name, filename, content] of [
      ["submodules", ".gitmodules", '[submodule "x"]\n\tpath = x\n\turl = https://example.test/x.git\n'],
      ["lfs", ".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n"],
    ]) {
      const hubWorktree = path.join(root, `hub-${name}`);
      initGitRepo(hubWorktree);
      fs.writeFileSync(path.join(hubWorktree, filename), content);
      execFileSync("git", ["-C", hubWorktree, "add", filename], { stdio: "ignore" });
      execFileSync("git", ["-C", hubWorktree, "commit", "--quiet", "-m", `add ${filename}`], { stdio: "ignore" });
      const remote = { host: "worker.test", workDir: workerRoot };
      const cfg = { harnesses: { worker: { remote } } };
      const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, `hub-verdict-${name}.json`) }, cfg });
      const { cwd, verdictFile } = executor.paths({ stepId: "code", ref: name, hasWorktree: true });
      const hub = { repoId: "default", repoPath: hubWorktree, worktree: hubWorktree, branch: "main" };
      const { spawnAgent } = spawnCtx();
      const result = await spawnAgent({ agent: fakeAgent(), prompt: "go", cwd, logPath: path.join(root, `${name}.log`), verdictFile, sandboxed: { ref: name, stepId: "code", step: {}, mounts: [], hub }, executor });
      assert.equal(result.code, 1, name);
      assert.match(result.refused ?? "", /not supported on a remote harness yet/, `${name}: ${JSON.stringify(result)}`);
    }
  } finally {
    ssh.restore();
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor code transport (#690): non-ff — a worker branch rewritten so the before sha is no longer an ancestor fails the run, leaving the hub branch/worktree at the before sha", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-sync-nonff-"));
  const workerRoot = path.join(root, "worker");
  const hubWorktree = path.join(root, "hub-worktree");
  fs.mkdirSync(workerRoot, { recursive: true });
  initGitRepo(hubWorktree);
  const branch = "agent/3";
  execFileSync("git", ["-C", hubWorktree, "checkout", "-b", branch], { stdio: "ignore" });
  try {
    // The fake agent rewrites history (an amend) instead of adding a commit on top — its new HEAD
    // no longer descends from what the hub pushed.
    const agentScript = path.join(workerRoot, "rewrite-agent.sh");
    fs.writeFileSync(
      agentScript,
      `#!/bin/sh\ncat > /dev/null\ngit config user.email a@test.local\ngit config user.name a\necho rewritten > README.md\ngit add README.md\ngit commit --quiet --amend -m "rewritten"\nexit 0\n`,
      { mode: 0o755 },
    );
    const remote = { host: "worker.test", workDir: workerRoot, bin: agentScript };
    const cfg = { harnesses: { worker: { remote } } };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") }, cfg });
    const { cwd, verdictFile } = executor.paths({ stepId: "code", ref: "3", hasWorktree: true });
    const hub = { repoId: "default", repoPath: hubWorktree, worktree: hubWorktree, branch };
    const { spawnAgent } = spawnCtx();
    const headBefore = headOf(hubWorktree);
    const result = await spawnAgent({ agent: fakeAgent(), prompt: "go", cwd, logPath: path.join(root, "run.log"), verdictFile, sandboxed: { ref: "3", stepId: "code", step: {}, mounts: [], hub }, executor });
    assert.equal(result.code, 0, "the agent itself exited clean — only the sync-back is refused");
    assert.equal(result.sandboxReport?.failed && typeof result.sandboxReport.failed, "string", JSON.stringify(result.sandboxReport));
    assert.match(result.sandboxReport.failed, /rewritten|diverged/);
    assert.equal(headOf(hubWorktree), headBefore, "the hub worktree must stay exactly where it was — nothing overwritten");
    assert.equal(execFileSync("git", ["-C", hubWorktree, "branch", "--show-current"], { encoding: "utf8" }).trim(), branch);
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor code transport (#690): a no-worktree export contains exactly the tracked files at HEAD — gitignored, untracked, .env and the profile config never travel", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-sync-export-"));
  const workerRoot = path.join(root, "worker");
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(workerRoot, { recursive: true });
  initGitRepo(repoPath);
  fs.writeFileSync(path.join(repoPath, ".gitignore"), "ignored.txt\n");
  execFileSync("git", ["-C", repoPath, "add", ".gitignore"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoPath, "commit", "--quiet", "-m", "gitignore"], { stdio: "ignore" });
  fs.writeFileSync(path.join(repoPath, "ignored.txt"), "secret-ish\n");
  fs.writeFileSync(path.join(repoPath, "untracked.txt"), "never committed\n");
  fs.writeFileSync(path.join(repoPath, ".env"), "TOKEN=leak\n");
  fs.writeFileSync(path.join(repoPath, "agenthook.config.json"), "{}\n");
  try {
    // The fake agent lists its cwd (the exported dir) into a result file on the worker.
    const agentScript = path.join(workerRoot, "list-agent.sh");
    fs.writeFileSync(agentScript, `#!/bin/sh\ncat > /dev/null\nls -A . > ${shQuote(path.join(workerRoot, "listing.txt"))}\nexit 0\n`, { mode: 0o755 });
    const remote = { host: "worker.test", workDir: workerRoot, bin: agentScript };
    const cfg = { harnesses: { worker: { remote } } };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") }, cfg });
    const { cwd, verdictFile } = executor.paths({ stepId: "triage", ref: "4", hasWorktree: false });
    const hub = { repoId: "default", repoPath };
    const { spawnAgent } = spawnCtx();
    const result = await spawnAgent({ agent: fakeAgent(), prompt: "go", cwd, logPath: path.join(root, "run.log"), verdictFile, sandboxed: { ref: "4", stepId: "triage", step: {}, mounts: [], hub }, executor });
    assert.equal(result.code, 0, JSON.stringify(result));
    const listing = fs.readFileSync(path.join(workerRoot, "listing.txt"), "utf8").split("\n").filter(Boolean).sort();
    assert.deepEqual(listing, [".gitignore", "README.md"]);
    assert.ok(!fs.existsSync(cwd), "the export dir must be removed after done()");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor code transport (#690): the hub push is HOST_GIT_SAFE-hardened — a pre-push hook the agent's branch could carry never runs", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-sync-hooks-"));
  const workerRoot = path.join(root, "worker");
  const hubWorktree = path.join(root, "hub-worktree");
  fs.mkdirSync(workerRoot, { recursive: true });
  initGitRepo(hubWorktree);
  const branch = "agent/5";
  execFileSync("git", ["-C", hubWorktree, "checkout", "-b", branch], { stdio: "ignore" });
  const hooksDir = path.join(root, "agent-hooks");
  fs.mkdirSync(hooksDir);
  const marker = path.join(root, "pwned");
  fs.writeFileSync(path.join(hooksDir, "pre-push"), `#!/bin/sh\ntouch ${shQuote(marker)}\n`, { mode: 0o755 });
  execFileSync("git", ["-C", hubWorktree, "config", "core.hooksPath", hooksDir], { stdio: "ignore" });
  try {
    const remote = { host: "worker.test", workDir: workerRoot, bin: writeCommitAgent(workerRoot, "hooks.txt") };
    const cfg = { harnesses: { worker: { remote } } };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") }, cfg });
    const { cwd, verdictFile } = executor.paths({ stepId: "code", ref: "5", hasWorktree: true });
    const hub = { repoId: "default", repoPath: hubWorktree, worktree: hubWorktree, branch };
    const { spawnAgent } = spawnCtx();
    const result = await spawnAgent({ agent: fakeAgent(), prompt: "go", cwd, logPath: path.join(root, "run.log"), verdictFile, sandboxed: { ref: "5", stepId: "code", step: {}, mounts: [], hub }, executor });
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.ok(!fs.existsSync(marker), "a planted pre-push hook must never run on the hub's own push");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A fake `git` on PATH that records its full argv (one JSON line per call) then execs the real
 * one — for asserting the exact argv a hub-side call built, not just its observable effect. The
 * fake ssh double already runs its remote script through the same PATH, so a worker-side `git`
 * call (inside the shell script executor-ssh.js sends over ssh) is ALSO recorded; callers filter
 * by `-C <path>` to tell hub calls (always hardened, #690) from worker-side ones (never wrapped
 * by `gitArgv` — only the hub is a HOST_GIT_SAFE concern). */
function withArgvRecordingGit() {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
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
    /** @param {string} forPath only calls with `-C <forPath>` */
    callsFor: (forPath) =>
      (fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter(
        (a) => a[a.indexOf("-C") + 1] === forPath,
      ),
    restore: () => {
      process.env.PATH = savedPath;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("ssh executor code transport (#690): every hub-side git call in a full round trip (dirty/submodule probe, push, fetch, merge --ff-only, update-ref) is HOST_GIT_SAFE-hardened", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-sync-hardening-"));
  const workerRoot = path.join(root, "worker");
  const hubWorktree = path.join(root, "hub-worktree");
  fs.mkdirSync(workerRoot, { recursive: true });
  initGitRepo(hubWorktree);
  const branch = "agent/7";
  execFileSync("git", ["-C", hubWorktree, "checkout", "-b", branch], { stdio: "ignore" });
  // Recording starts only after this test's own setup git calls (unhardened on purpose, never
  // through gitArgv) so they don't pollute what's asserted below.
  const rec = withArgvRecordingGit();
  try {
    const remote = { host: "worker.test", workDir: workerRoot, bin: writeCommitAgent(workerRoot, "hardening.txt") };
    const cfg = { harnesses: { worker: { remote } } };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") }, cfg });
    const { cwd, verdictFile } = executor.paths({ stepId: "code", ref: "7", hasWorktree: true });
    const hub = { repoId: "default", repoPath: hubWorktree, worktree: hubWorktree, branch };
    const { spawnAgent } = spawnCtx();
    const result = await spawnAgent({ agent: fakeAgent(), prompt: "go", cwd, logPath: path.join(root, "run.log"), verdictFile, sandboxed: { ref: "7", stepId: "code", step: {}, mounts: [], hub }, executor });
    assert.equal(result.code, 0, JSON.stringify(result));

    const hubCalls = rec.callsFor(hubWorktree);
    const ops = new Set(hubCalls.map((a) => a[a.indexOf("-C") + 2]));
    for (const op of ["status", "show", "rev-parse", "push", "fetch", "merge", "update-ref"]) {
      assert.ok(ops.has(op), `expected a hub-side "${op}" call, saw ops ${JSON.stringify([...ops])}`);
    }
    for (const call of hubCalls) {
      assert.deepEqual(call.slice(0, 4), ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"], `every hub call must be HOST_GIT_SAFE-hardened, got ${JSON.stringify(call)}`);
    }
  } finally {
    rec.restore();
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor code transport (#690): GIT_SSH_COMMAND carries BatchMode=yes and the harness's port/identity/user; never -A", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-sync-gitssh-"));
  const workerRoot = path.join(root, "worker");
  const hubWorktree = path.join(root, "hub-worktree");
  fs.mkdirSync(workerRoot, { recursive: true });
  initGitRepo(hubWorktree);
  const branch = "agent/6";
  execFileSync("git", ["-C", hubWorktree, "checkout", "-b", branch], { stdio: "ignore" });
  const identityFile = path.join(root, "id_ed25519");
  fs.writeFileSync(identityFile, "fake key material\n");
  try {
    const remote = { host: "worker.test", workDir: workerRoot, port: 2222, identityFile, user: "deploy", bin: writeCommitAgent(workerRoot, "gitssh.txt") };
    const cfg = { harnesses: { worker: { remote } } };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") }, cfg });
    const { cwd, verdictFile } = executor.paths({ stepId: "code", ref: "6", hasWorktree: true });
    const hub = { repoId: "default", repoPath: hubWorktree, worktree: hubWorktree, branch };
    const { spawnAgent } = spawnCtx();
    const result = await spawnAgent({ agent: fakeAgent(), prompt: "go", cwd, logPath: path.join(root, "run.log"), verdictFile, sandboxed: { ref: "6", stepId: "code", step: {}, mounts: [], hub }, executor });
    assert.equal(result.code, 0, JSON.stringify(result));
    // git's own ssh transport (push, fetch) resolved "ssh" off PATH to our fake, driven by
    // GIT_SSH_COMMAND — its argv shows exactly what that env var built.
    const transportCalls = ssh.record().filter((r) => r.remote.some((el) => el.includes("git-receive-pack") || el.includes("git-upload-pack")));
    assert.ok(transportCalls.length >= 1, "expected at least one git-transport ssh invocation");
    for (const call of transportCalls) {
      assert.ok(!call.all.includes("-A"), "never agent-forward");
      const oIdx = call.all.indexOf("-o");
      assert.ok(oIdx >= 0, JSON.stringify(call.all));
      assert.equal(call.all[oIdx + 1], "BatchMode=yes");
      const pIdx = call.all.indexOf("-p");
      assert.equal(call.all[pIdx + 1], "2222");
      const iIdx = call.all.indexOf("-i");
      assert.equal(call.all[iIdx + 1], identityFile);
      const lIdx = call.all.indexOf("-l");
      assert.equal(call.all[lIdx + 1], "deploy");
    }
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- code transport (#690) at the full-pipeline level: step.js/finish.js, not just spawnAgent ---

/** A real git repo + a `claude`-shaped fake bin, for a dispatch-level (`createDispatcher`) test
 * of a remote `createsWorktree` step. Mirrors `deduceHarness` in test/dispatch.test.js, but the
 * step's harness is a remote one, so the agent actually runs on the "worker" (the fake-ssh
 * double) against the worktree #690 synced there — not directly in the hub worktree.
 * @param {{pipeline: any[]}} o */
function remoteWorktreeHarness({ pipeline }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-pipeline-"));
  const repoDir = path.join(dir, "repo");
  const workDir = path.join(dir, "work");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoDir);
  // The harness's `bin` path is fixed at cfg-build time (createDispatcher builds its executors
  // once, from the cfg as it stood then — a later `cfg.harnesses` mutation would never be seen).
  // Each run instead (re)writes the SCRIPT at this fixed path before calling run().
  const agentScript = path.join(workDir, "agent.sh");
  const cfg = /** @type {any} */ ({
    pipeline,
    repoPath: repoDir,
    worktreePrefix: path.join(dir, "wt"),
    stateKey: "p",
    stateDir: dir,
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
    harnesses: { worker: { remote: { host: "worker.test", workDir, bin: agentScript } } },
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({
      platform: "GitHub",
      taskNoun: "issue",
      trigger: "@agent",
      commentHowTo: "comment",
      stageKeys: { source: "sourceLabel", success: "successLabel", failure: "failLabel", hold: "holdLabel", queue: "queueLabel" },
    }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push({ ref, stepId, ...verdict }),
  });
  const run = createDispatcher(cfg, adapter, undefined, store, () => {});
  /** @param {string} stepId @param {string} scriptBody the fixed `agentScript`'s new contents */
  const runStep = async (stepId, scriptBody) => {
    fs.writeFileSync(agentScript, scriptBody, { mode: 0o755 });
    const log = console.log;
    console.log = () => {};
    try {
      return await run({ kind: "pipeline", ref: "55", stepId, dedupKey: `k:${stepId}`, harness: "worker" });
    } finally {
      console.log = log;
    }
  };
  return { cfg, store, advanced, runStep, dir, repoDir, workDir, agentScript };
}

const WORKTREE_PIPELINE = [
  { id: "code", harness: "worker", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0 },
  { id: "review", sourceLabel: "src:review" },
];

// No verdictRepairs: 0 here on purpose, same reasoning as test/dispatch.test.js's own deduce
// test: the default (1 repair turn) applies, so calls()===1 below actually proves deduction
// pre-empted the repair spawn, not just that repairs were disabled.
const WORKTREE_PIPELINE_WITH_REPAIR = [
  { id: "code", harness: "worker", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review" },
  { id: "review", sourceLabel: "src:review" },
];

test("dispatch: a remote worktree run whose sync-back is refused (non-ff) fails the run, not advances — even though the agent's own verdict says advance", async () => {
  const ssh = withFakeSsh();
  const h = remoteWorktreeHarness({ pipeline: WORKTREE_PIPELINE });
  const scriptBody = [
    "#!/bin/sh",
    "cat > /dev/null",
    "git config user.email a@test.local",
    "git config user.name a",
    "echo hi > r.txt",
    "git add r.txt",
    // Amends the commit that was just pushed (the current HEAD) IN PLACE, giving it a new sha
    // with the same parent — a sibling of what was pushed, not a descendant of it, so the
    // ancestor check fails exactly like a history rewrite/reset on the worker would.
    'git commit -q --amend -m "rewritten"',
    'mkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"',
    'echo \'{"outcome":"advance","reason":"the agent itself thinks it succeeded"}\' > "$AGENTHOOK_VERDICT_FILE"',
    'printf \'{"type":"result","subtype":"success","session_id":"s1","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.01}\\n\'',
    "exit 0",
    "",
  ].join("\n");
  try {
    const headBefore = execFileSync("git", ["-C", h.repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const result = await h.runStep("code", scriptBody);
    assert.equal(result.code, 0, "the agent's own process exited clean");
    assert.equal(h.advanced.length, 1);
    assert.equal(h.advanced[0].outcome, "fail", `a refused sync-back must fail the run, never advance on the agent's say-so (got ${JSON.stringify(h.advanced[0])})`);
    assert.match(h.advanced[0].reason, /rewritten|diverged/);
    const headAfter = execFileSync("git", ["-C", h.repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(headAfter, headBefore, "the hub worktree/branch must stay exactly where it was");
  } finally {
    ssh.restore();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("dispatch: a remote worktree run's deduced verdict counts the commits the sync-back fast-forwarded in, not just a local HEAD the worker never actually reached", async () => {
  const ssh = withFakeSsh();
  const h = remoteWorktreeHarness({ pipeline: WORKTREE_PIPELINE_WITH_REPAIR });
  const counter = path.join(h.dir, "counter");
  const scriptBody = [
    "#!/bin/sh",
    "cat > /dev/null",
    `n=0; [ -f ${shQuote(counter)} ] && n=$(cat ${shQuote(counter)})`,
    "n=$((n + 1))",
    `echo "$n" > ${shQuote(counter)}`,
    "git config user.email a@test.local",
    "git config user.name a",
    "echo hi > r.txt",
    "git add r.txt",
    'git commit -q -m "worker commit, no verdict written"',
    'printf \'{"type":"result","subtype":"success","session_id":"s1","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.01}\\n\'',
    "exit 0",
    "",
  ].join("\n");
  try {
    const result = await h.runStep("code", scriptBody);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(h.advanced.length, 1);
    assert.deepEqual(h.advanced[0], { ref: "55", stepId: "code", outcome: "advance", reason: "no verdict written; advanced because the run added 1 commit" });
    assert.equal(Number(fs.readFileSync(counter, "utf8").trim()), 1, "the agent was spawned exactly once — deduction (reading the hub worktree AFTER sync-back fast-forwarded it) pre-empted the repair spawn");
  } finally {
    ssh.restore();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("dispatch: a remote run's verdict-REPAIR turn is the one that rewrites history — its own sync-back refusal must still fail the run, not get dropped in favor of the first turn's clean sync", async () => {
  const ssh = withFakeSsh();
  const h = remoteWorktreeHarness({ pipeline: WORKTREE_PIPELINE_WITH_REPAIR });
  const counter = path.join(h.dir, "counter");
  const scriptBody = [
    "#!/bin/sh",
    "cat > /dev/null",
    `n=0; [ -f ${shQuote(counter)} ] && n=$(cat ${shQuote(counter)})`,
    "n=$((n + 1))",
    `echo "$n" > ${shQuote(counter)}`,
    // Turn 1: no commit, no verdict — NO_VALID_VERDICT, so step.js's repair ladder fires.
    // Turn 2 (the repair, resuming the same session): amends the commit it just synced IN
    // PLACE (a sibling, not a descendant — same non-ff shape the earlier non-ff test uses) and
    // THIS time writes a valid verdict, so repairMissingVerdict stops here and returns this
    // turn's own result as `final` — the one whose sandboxReport must be trusted.
    'if [ "$n" -ge 2 ]; then',
    "  git config user.email a@test.local",
    "  git config user.name a",
    "  echo hi > r.txt",
    "  git add r.txt",
    '  git commit -q --amend -m "rewritten by the repair turn"',
    '  mkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"',
    "  echo '{\"outcome\":\"advance\",\"reason\":\"the repair turn itself thinks it succeeded\"}' > \"$AGENTHOOK_VERDICT_FILE\"",
    "fi",
    'printf \'{"type":"result","subtype":"success","session_id":"s1","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.01}\\n\'',
    "exit 0",
    "",
  ].join("\n");
  try {
    const headBefore = execFileSync("git", ["-C", h.repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const result = await h.runStep("code", scriptBody);
    assert.equal(result.code, 0, "both turns' own processes exited clean");
    assert.equal(Number(fs.readFileSync(counter, "utf8").trim()), 2, "exactly one repair turn ran");
    assert.equal(h.advanced.length, 1);
    assert.equal(h.advanced[0].outcome, "fail", `the repair turn's own refused sync-back must fail the run, never advance on its say-so (got ${JSON.stringify(h.advanced[0])})`);
    assert.match(h.advanced[0].reason, /rewritten|diverged/);
    const headAfter = execFileSync("git", ["-C", h.repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(headAfter, headBefore, "the hub worktree/branch must stay exactly where it was");
  } finally {
    ssh.restore();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("ssh executor code transport (#690): paths() is deterministic per ref(+step), not per spawn — a verdict-repair resume relaunches into the same worker cwd", () => {
  const remote = { host: "worker.test", workDir: "/w" };
  const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => "/hub.json" }, cfg: {} });
  const a = executor.paths({ stepId: "code", ref: "9", hasWorktree: true });
  const b = executor.paths({ stepId: "code", ref: "9", hasWorktree: true });
  assert.equal(a.cwd, b.cwd);
  assert.equal(a.worktree, b.worktree);
  const exportA = executor.paths({ stepId: "triage", ref: "9", hasWorktree: false });
  const exportB = executor.paths({ stepId: "triage", ref: "9", hasWorktree: false });
  assert.equal(exportA.cwd, exportB.cwd);
  assert.notEqual(a.cwd, exportA.cwd);
});

test("ssh executor reap() (#690): removes leftover worktree/export dirs and prunes the bare repos' worktree admin", async () => {
  const ssh = withFakeSsh();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-reap-sync-"));
  try {
    const remote = { host: "worker.test", workDir };
    const cfg = { harnesses: { worker: { remote } } };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") }, cfg });
    const wtDir = path.join(workDir, ".agenthook", "p", "worktrees", "leftover");
    const exportDir = path.join(workDir, ".agenthook", "p", "exports", "leftover-code");
    fs.mkdirSync(wtDir, { recursive: true });
    fs.mkdirSync(exportDir, { recursive: true });
    const reaped = await executor.reap();
    assert.deepEqual(reaped, { containers: [], networks: [], runs: [] });
    assert.ok(!fs.existsSync(wtDir));
    assert.ok(!fs.existsSync(exportDir));
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// --- boot wiring: a remote harness's leftover runs are reaped on boot recovery ---

test("boot: a remote harness's leftover runs are reaped and logged distinctly from the sandbox's", async () => {
  const { createServe } = await import("../src/engine/boot.js");
  const { createStore: makeStore } = await import("../src/store.js");
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
