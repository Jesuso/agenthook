import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// #861 (epic #681's "not verified yet" list): the ssh executor's OpenSSH assumptions, checked
// against a REAL `ssh` client and a real throwaway `sshd` (test/_sshd-helpers.js) instead of the
// fake `ssh` every other dispatch-executor-ssh-*.test.js file uses. Skips cleanly (never fails)
// when sshd/ssh/ssh-keygen aren't available — see _sshd-helpers.js's own doc comment. One test per
// assumption row (A1-A12) in the ticket's table.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createSshExecutor } from "../src/dispatch/executor-ssh.js";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store/index.js";
import { worktreePath } from "../src/worktree.js";
import { startThrowawaySshd } from "./_sshd-helpers.js";
import { initGitRepo, spawnCtx, writeCommitAgent, headOf } from "./_ssh-helpers.js";

/** @type {Awaited<ReturnType<typeof startThrowawaySshd>>} */
let sshd;
before(async () => {
  sshd = await startThrowawaySshd();
});
after(async () => {
  if (sshd?.available) await sshd.stop();
});

/** @param {import('node:test').TestContext} t @returns {boolean} true when the test must bail out */
function unavailable(t) {
  if (!sshd.available) {
    t.skip(sshd.reason);
    return true;
  }
  return false;
}

const mkWork = () => fs.mkdtempSync(path.join(os.tmpdir(), "ah-real-work-"));
/** @param {string} dir @param {string} name @param {string} body */
function writeScript(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

/** A free TCP port on 127.0.0.1 with nothing listening (bind :0, read it, close) — a closed port,
 * not a firewalled one: the kernel answers with an immediate RST ("Connection refused"). */
function closedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

/** A minimal agent object (mirrors _ssh-helpers.js's fakeAgent, but exposes the raw stdout/stderr
 * chunks the parser saw, for A1's "arrive on separate streams, intact"). @param {(o: {prompt: string}) => string[]} buildArgs */
function capturingAgent(buildArgs) {
  const out = [];
  const err = [];
  return {
    agent: {
      defaults: { bin: "agent" },
      buildArgs,
      createParser: () => ({
        push: (chunk) => {
          out.push(chunk);
          return chunk;
        },
        flush: () => "",
        tally: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
        result: null,
        quota: null,
        pushStderr: (chunk) => err.push(chunk),
      }),
    },
    out,
    err,
  };
}

/** @param {{port?: number, identityFile?: string}} [overrides] */
function remoteFor(workDir, overrides = {}) {
  return { host: sshd.host, port: sshd.port, identityFile: sshd.identityFile, workDir, ...overrides };
}

// --- A1/A2/A10: stdout/stderr separation, exit code propagation, argv quoting ---

test("real ssh: stdout and stderr arrive separately and intact, the exit code propagates, and an exotic argv element survives ssh's own quoting round trip", async (t) => {
  if (unavailable(t)) return;
  const workDir = mkWork();
  try {
    const exotic = `it's a $(date) "test" with  spaces`;
    const script = writeScript(
      workDir,
      "agent.sh",
      `#!/bin/sh\ncat > /dev/null\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${path.join(workDir, "argv.txt")}\necho STDOUT_MARKER_861\necho STDERR_MARKER_861 >&2\nexit 7\n`,
    );
    const remote = remoteFor(workDir, { bin: script });
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const { spawnAgent } = spawnCtx();
    const { agent, out, err } = capturingAgent(({ prompt }) => ["-p", prompt, "--tag", exotic]);
    const result = await spawnAgent({
      agent,
      prompt: "hi",
      cwd: workDir,
      logPath: path.join(workDir, "run.log"),
      sandboxed: { ref: "1", stepId: "code", step: {}, mounts: [] },
      executor,
    });
    assert.equal(result.code, 7, JSON.stringify(result)); // A2
    assert.match(out.join(""), /STDOUT_MARKER_861/); // A1
    assert.doesNotMatch(out.join(""), /STDERR_MARKER_861/);
    assert.match(err.join(""), /STDERR_MARKER_861/);
    assert.doesNotMatch(err.join(""), /STDOUT_MARKER_861/);
    const argv = fs.readFileSync(path.join(workDir, "argv.txt"), "utf8").trim().split("\n");
    assert.ok(argv.includes(exotic), `exotic argv element lost/mangled in transit; saw ${JSON.stringify(argv)}`); // A10
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// --- A3/A4: wrong key -> exit 255, classified auth ---

test("real ssh: a wrong identity file is refused with exit 255 and classified as an ssh auth (config) failure", async (t) => {
  if (unavailable(t)) return;
  const workDir = mkWork();
  try {
    const remote = remoteFor(workDir, { identityFile: sshd.wrongIdentityFile, bin: "/bin/true" });
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const { spawnAgent } = spawnCtx();
    const result = await spawnAgent({
      agent: capturingAgent(({ prompt }) => ["-p", prompt]).agent,
      prompt: "hi",
      cwd: workDir,
      logPath: path.join(workDir, "run.log"),
      sandboxed: { ref: "4", stepId: "code", step: {}, mounts: [] },
      executor,
    });
    assert.equal(result.code, 255);
    assert.match(result.sshConfigFailure ?? "", /^ssh auth failed on 127\.0\.0\.1: .*Permission denied \(/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// --- A5: changed host key -> classified host-key failure ---

test("real ssh: a rotated host key is refused and classified as an ssh host-key (config) failure", async (t) => {
  if (unavailable(t)) return;
  const workDir = mkWork();
  try {
    sshd.rotateHostKey();
    const remote = remoteFor(workDir, { bin: "/bin/true" });
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const { spawnAgent } = spawnCtx();
    const { agent, err } = capturingAgent(({ prompt }) => ["-p", prompt]);
    const result = await spawnAgent({
      agent,
      prompt: "hi",
      cwd: workDir,
      logPath: path.join(workDir, "run.log"),
      sandboxed: { ref: "5", stepId: "code", step: {}, mounts: [] },
      executor,
    });
    assert.equal(result.code, 255, JSON.stringify(result));
    assert.match(
      result.sshConfigFailure ?? "",
      /^ssh host key failed on 127\.0\.0\.1: /,
      `result=${JSON.stringify(result)} stderr=${JSON.stringify(err.join(""))}`,
    );
  } finally {
    sshd.restoreHostKey(); // undo the rotation so every later test connects normally
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// --- A6: closed port -> unreachable, on both the launch path and the hub sync path ---

test("real ssh: a closed port is classified unreachable on the plain launch path", async (t) => {
  if (unavailable(t)) return;
  const workDir = mkWork();
  const port = await closedPort();
  try {
    const remote = remoteFor(workDir, { port, bin: "/bin/true" });
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const { spawnAgent } = spawnCtx();
    const result = await spawnAgent({
      agent: capturingAgent(({ prompt }) => ["-p", prompt]).agent,
      prompt: "hi",
      cwd: workDir,
      logPath: path.join(workDir, "run.log"),
      sandboxed: { ref: "6", stepId: "code", step: {}, mounts: [] },
      executor,
    });
    assert.equal(result.unreachable, "worker unreachable: 127.0.0.1 (connection refused)");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("real ssh: a closed port is classified unreachable on the hub (pre-run sync) path", async (t) => {
  if (unavailable(t)) return;
  const dir = mkWork();
  const repoPath = path.join(dir, "repo");
  initGitRepo(repoPath);
  const port = await closedPort();
  try {
    const remote = remoteFor(path.join(dir, "work"), { port });
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(dir, "hub.json") } });
    await assert.rejects(
      executor.launch({ runId: "r6", ref: "6", stepId: "code", bin: "x", args: ["-p", "hi"], prompt: "hi", env: {}, hub: { repoId: "r", repoPath } }),
      (e) => {
        assert.equal(e.unreachable, "worker unreachable: 127.0.0.1 (connection refused)");
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- A7: killing the local ssh client closes the remote stdin, the watchdog reaps the agent ---

test("real ssh: killing the local ssh client ends the remote agent process (closed-stdin watchdog)", async (t) => {
  if (unavailable(t)) return;
  const workDir = mkWork();
  const pidFile = path.join(workDir, "agent.pid");
  try {
    const script = writeScript(workDir, "sleepy.sh", `#!/bin/sh\necho "$$" > ${JSON.stringify(pidFile)}\ncat > /dev/null\nsleep 30\n`);
    const remote = remoteFor(workDir, { bin: script });
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const children = new Set();
    const { spawnAgent } = spawnCtx({ children });
    const promise = spawnAgent({
      agent: capturingAgent(({ prompt }) => ["-p", prompt]).agent,
      prompt: "hi",
      cwd: workDir,
      logPath: path.join(workDir, "run.log"),
      sandboxed: { ref: "7", stepId: "code", step: {}, mounts: [] },
      executor,
    });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(pidFile), "the remote agent never started");
    const [child] = children;
    assert.ok(child, "the local ssh client was never tracked");
    child.kill("SIGKILL");
    await promise;
    const agentPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    const reapDeadline = Date.now() + 5000;
    let alive = true;
    while (Date.now() < reapDeadline) {
      try {
        process.kill(agentPid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(alive, false, "the remote agent process must be reaped once the local ssh client dies");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// --- A8: the executor's own kill() ends the remote process group ---

test("real ssh: run.kill() TERM-then-KILLs the remote process group via a fresh ssh call", async (t) => {
  if (unavailable(t)) return;
  const workDir = mkWork();
  let sleeper;
  try {
    fs.mkdirSync(path.join(workDir, ".agenthook", "p", "runs"), { recursive: true });
    const { spawn } = await import("node:child_process");
    sleeper = spawn("sh", ["-c", "trap '' TERM; exec sleep 30"], { detached: true });
    fs.writeFileSync(path.join(workDir, ".agenthook", "p", "runs", "k1.pgid"), String(sleeper.pid));
    const remote = remoteFor(workDir);
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const run = await executor.launch({ runId: "k1", ref: "1", stepId: "code", bin: "x", args: ["-p", "hi"], prompt: "hi", env: {} });
    await run.kill();
    // Poll with a deadline, not a single immediate check: `sleeper` is this test's own child, so
    // right after kill() it can briefly sit as a zombie (still answers kill(pid, 0)) until libuv
    // reaps it — a single check would false-negative on that race.
    const deadline = Date.now() + 5000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(sleeper.pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(alive, false, "kill() must end even a TERM-ignoring remote process group");
  } finally {
    if (sleeper) {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// --- A9: env/prompt travel off-argv ---

test("real ssh: an AGENTHOOK_ env value reaches the agent, and neither it nor the prompt ever appear in any process's argv", async (t) => {
  if (unavailable(t)) return;
  const workDir = mkWork();
  const pidFile = path.join(workDir, "agent.pid");
  const envOutFile = path.join(workDir, "env-out.txt");
  const secretEnv = "super-secret-env-value-861";
  const secretPrompt = "super-secret-prompt-value-861";
  try {
    const script = writeScript(
      workDir,
      "sleepy-env.sh",
      // `exec sleep 30` (not a plain `sleep 30` child) so SIGKILLing this script's own pid below
      // ends the sleep immediately instead of leaving an orphaned 30s sleep holding the ssh
      // session open and making the test itself take 30s.
      `#!/bin/sh\necho "$$" > ${JSON.stringify(pidFile)}\ncat > /dev/null\nprintf '%s' "$AGENTHOOK_TEST_SECRET" > ${JSON.stringify(envOutFile)}\nexec sleep 30\n`,
    );
    const remote = remoteFor(workDir, { bin: script });
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const { spawnAgent } = spawnCtx();
    const promise = spawnAgent({
      agent: capturingAgent(({ prompt }) => ["-p", prompt]).agent,
      prompt: secretPrompt,
      cwd: workDir,
      logPath: path.join(workDir, "run.log"),
      env: { AGENTHOOK_TEST_SECRET: secretEnv },
      sandboxed: { ref: "9", stepId: "code", step: {}, mounts: [] },
      executor,
    });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(pidFile), "the remote agent never started");
    const agentPid = fs.readFileSync(pidFile, "utf8").trim();
    // Scan EVERY process's cmdline (the launcher's `sh -c`, the sshd session, the local ssh
    // client), not just the agent's own: a secret leaking into the launcher script's argv
    // (rather than the agent's) would otherwise go unnoticed.
    for (const pid of fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      let cmdline;
      try {
        cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      } catch {
        continue; // the process exited between readdir and read
      }
      assert.ok(!cmdline.includes(secretEnv), `the env value must not reach any process argv (pid ${pid}: ${JSON.stringify(cmdline)})`);
      assert.ok(!cmdline.includes(secretPrompt), `the prompt must not reach any process argv (pid ${pid}: ${JSON.stringify(cmdline)})`);
    }
    process.kill(Number(agentPid), "SIGKILL");
    await promise;
    const envOutDeadline = Date.now() + 5000;
    while (!fs.existsSync(envOutFile) && Date.now() < envOutDeadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.readFileSync(envOutFile, "utf8"), secretEnv, "the agent must still SEE the env value on its own stdin-independent env");
  } finally {
    if (fs.existsSync(pidFile)) {
      try {
        process.kill(Number(fs.readFileSync(pidFile, "utf8").trim()), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// --- A11: no-worktree sync via git archive | ssh tar -x, full dispatcher ---

test("real ssh: a no-worktree step archives the repo to the worker and copies the agent's verdict back", async (t) => {
  if (unavailable(t)) return;
  const dir = mkWork();
  const repoDir = path.join(dir, "repo");
  const workDir = path.join(dir, "work");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoDir);
  try {
    // The agent's cwd for a no-worktree step is the worker's EXPORT dir (a subdir of `workDir`
    // the executor removes once the run ends), not `workDir` itself — write the marker to an
    // absolute path outside it so it outlives that cleanup and is actually reachable below.
    const syncedMarker = path.join(workDir, "synced.txt");
    const agentScript = writeScript(
      workDir,
      "agent.sh",
      `#!/bin/sh\ncat > /dev/null\n[ -f README.md ] && echo yes > ${JSON.stringify(syncedMarker)}\nmkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"\necho '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"\nexit 0\n`,
    );
    const cfg = {
      pipeline: [{ id: "code", harness: "worker" }],
      harnesses: { worker: { remote: remoteFor(workDir, { bin: agentScript }) } },
      repoPath: repoDir,
      stateKey: "p",
      stateDir: dir,
      dataDir: dir,
      logDir: dir,
      instructionsFile: path.join(dir, "none.md"),
    };
    const store = createStore(dir);
    const advanced = [];
    const adapter = {
      describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
      fetchTask: async (ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
      advance: async (ref, stepId, verdict) => advanced.push({ ref, stepId, ...verdict }),
    };
    const run = createDispatcher(cfg, adapter, undefined, store, () => {});
    const log = console.log;
    console.log = () => {};
    let result;
    try {
      result = await run({ kind: "pipeline", ref: "11", stepId: "code", dedupKey: "k:11", harness: "worker" });
    } finally {
      console.log = log;
    }
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(advanced.length, 1);
    assert.equal(advanced[0].outcome, "advance", JSON.stringify(advanced));
    // sshd runs on 127.0.0.1, so `workDir` IS the worker's real filesystem — read it directly to
    // confirm the archive actually delivered README.md, not just that the dir was created.
    assert.equal(fs.readFileSync(syncedMarker, "utf8"), "yes\n", "the archived repo never reached the worker");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- A12: worktree step, commits fetched back and fast-forwarded into the hub worktree ---

test("real ssh: a worktree step's worker commit is fetched back and fast-forwarded into the hub worktree", async (t) => {
  if (unavailable(t)) return;
  const dir = mkWork();
  const repoDir = path.join(dir, "repo");
  const workDir = path.join(dir, "work");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoDir);
  const agentScript = path.join(workDir, "commit-agent.sh");
  writeCommitAgent(workDir, "worker-wrote.txt"); // writes agentScript at this exact path
  try {
    const cfg = {
      pipeline: [{ id: "code", harness: "worker", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review" }, { id: "review", sourceLabel: "src:review" }],
      repoPath: repoDir,
      worktreePrefix: path.join(dir, "wt"),
      stateKey: "p",
      stateDir: dir,
      dataDir: dir,
      logDir: dir,
      instructionsFile: path.join(dir, "none.md"),
      harnesses: { worker: { remote: remoteFor(workDir, { bin: agentScript }) } },
    };
    const store = createStore(dir);
    const advanced = [];
    const adapter = {
      describe: () => ({
        platform: "GitHub",
        taskNoun: "issue",
        trigger: "@agent",
        commentHowTo: "comment",
        stageKeys: { source: "sourceLabel", success: "successLabel", failure: "failLabel", hold: "holdLabel", queue: "queueLabel" },
      }),
      fetchTask: async (ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
      advance: async (ref, stepId, verdict) => advanced.push({ ref, stepId, ...verdict }),
    };
    const run = createDispatcher(cfg, adapter, undefined, store, () => {});
    // A `createsWorktree` step fast-forwards the HUB WORKTREE (under worktreePrefix, on the run's
    // own branch) — not repoDir's checked-out branch, which never moves. Assert on that worktree.
    const hubWorktree = worktreePath(cfg, "12");
    const log = console.log;
    console.log = () => {};
    let result;
    try {
      result = await run({ kind: "pipeline", ref: "12", stepId: "code", dedupKey: "k:12", harness: "worker" });
    } finally {
      console.log = log;
    }
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.ok(fs.existsSync(hubWorktree), "the dispatcher never created the hub worktree");
    assert.equal(
      fs.readFileSync(path.join(hubWorktree, "worker-wrote.txt"), "utf8"),
      "hi\n",
      "the worker's commit must be fast-forwarded into the hub worktree",
    );
    assert.doesNotThrow(() => headOf(hubWorktree), "the hub worktree must be a real git checkout");
    assert.equal(advanced.length, 1);
    assert.equal(advanced[0].outcome, "advance", JSON.stringify(advanced));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
