import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// #828: an unreachable remote-harness worker must trip the breaker (with a clear
// `worker unreachable: <host> (…) reason`), never refuse or fail the ticket. Covers the ssh
// failure classifier, the ConnectTimeout wiring (ssh client + git transport), and the sync/launch
// failure paths against a fake `ssh`. Queue-integrated spill/wait/attempt-restore coverage
// lives in test/dispatch-ssh-unreachable-routing.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { classifySshFailure, sshConfigFailureReason, createSshExecutor, SSH_CONNECT_TIMEOUT_S } from "../src/dispatch/executor-ssh.js";
import { healthTrip } from "../src/dispatch/harness.js";
import { withFakeSsh, withFailingSsh, withDroppingSsh, spawnCtx, fakeAgent, initGitRepo, stall } from "./_ssh-helpers.js";

// --- classifySshFailure: the pattern table ---

test("classifySshFailure: connection-class stderr is 'unreachable' with the matched line", () => {
  const cases = [
    ["ssh: connect to host 10.0.0.5 port 22: Connection refused", "connection refused"],
    ["ssh: connect to host worker-x port 22: Connection timed out", "connection timed out"],
    ["ssh: connect to host worker-x port 22: No route to host", "no route to host"],
    ["ssh: connect to host worker-x port 22: Network is unreachable", "network unreachable"],
    ["ssh: Could not resolve hostname worker-x: Temporary failure in name resolution", "could not resolve hostname"],
    ["ssh: connect to host worker-x port 22: Connection closed by 10.0.0.5 port 22", "connection closed by remote host"],
    ["ssh: kex_exchange_identification: banner line contains escape sequence", "connection closed by remote host"],
    ["Connection to worker-x lost.", "connection lost"],
    ["Connection reset by 10.0.0.5 port 22", "connection lost"],
    ["client_loop: send2: Broken pipe", "connection lost"],
  ];
  for (const [stderr, detail] of cases) {
    const cls = classifySshFailure(stderr);
    assert.deepEqual(cls, { kind: "unreachable", detail, line: stderr }, `unreachable/${detail}: ${stderr}`);
  }
  // real ssh prints several lines; the matching one wins, whatever the rest is.
  const multi = classifySshFailure("Warning: Permanently added 'worker-x' (ED25519) to the list of known hosts.\nssh: connect to host worker-x port 22: Connection timed out");
  assert.equal(multi?.kind, "unreachable");
  assert.equal(multi?.line, "ssh: connect to host worker-x port 22: Connection timed out");
});

test("classifySshFailure: auth and host-key stderr is 'config' (a refusal, never a trip)", () => {
  const auth = classifySshFailure("git@worker-x: Permission denied (publickey).");
  assert.deepEqual(auth, { kind: "config", detail: "auth", line: "git@worker-x: Permission denied (publickey)." });
  const hostkey = classifySshFailure("Host key verification failed.");
  assert.deepEqual(hostkey, { kind: "config", detail: "host key", line: "Host key verification failed." });
  const changed = classifySshFailure("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    REMOTE HOST IDENTIFICATION HAS CHANGED!                     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.");
  assert.deepEqual(changed, { kind: "config", detail: "host key", line: "@    REMOTE HOST IDENTIFICATION HAS CHANGED!                     @" });
});

test("classifySshFailure: unknown or empty stderr is undefined (callers keep generic handling)", () => {
  assert.equal(classifySshFailure(undefined), undefined);
  assert.equal(classifySshFailure(""), undefined);
  assert.equal(classifySshFailure("\n   \n"), undefined);
  assert.equal(classifySshFailure("git: 'agent' is not a git command"), undefined);
  assert.equal(classifySshFailure("fatal: unable to access 'https://example/': Could not resolve host: example"), undefined, "a git HTTPS failure is not an ssh worker failure");
  assert.equal(classifySshFailure("mkdir: cannot create directory '/data/x': Permission denied"), undefined, "a worker-side command error is not an ssh auth rejection");
});

test("sshConfigFailureReason: names the class, the worker host and the matched line", () => {
  assert.equal(
    sshConfigFailureReason("worker-x", { detail: "auth", line: "git@worker-x: Permission denied (publickey)." }),
    "ssh auth failed on worker-x: git@worker-x: Permission denied (publickey).",
  );
  assert.equal(sshConfigFailureReason("worker-x", { detail: "host key", line: "Host key verification failed." }), "ssh host key failed on worker-x: Host key verification failed.");
});

// --- healthTrip: unreachable trips verbatim, config never trips ---

test("healthTrip: an unreachable worker trips verbatim; a classified ssh config failure never trips", () => {
  const base = { code: 255, cancelled: false, noOutput: true, wallMs: 50 };
  assert.equal(
    healthTrip({ ...base, unreachable: "worker unreachable: worker-x (connection refused)" }),
    "worker unreachable: worker-x (connection refused)",
  );
  assert.equal(healthTrip({ ...base, sshConfigFailure: "ssh auth failed on worker-x: Permission denied (publickey)." }), undefined, "a config failure refuses — it never trips, even at the fast-exit shape that would otherwise trip");
  assert.equal(healthTrip({ ...base, unreachable: "worker unreachable: x (timed out)", sshConfigFailure: "ssh auth failed on x: Permission denied (publickey)." }), "worker unreachable: x (timed out)", "unreachable wins when both ride the run");
  assert.equal(healthTrip({ ...base, cancelled: true, unreachable: "worker unreachable: x (refused)" }), "worker unreachable: x (refused)", "a cancelled run that was also unreachable still reports it (marked down, no requeue) — same as preflight/spawnError");
  assert.equal(healthTrip({ code: 0, cancelled: true, preflight: "preflight down" }), "preflight down", "a cancelled run with a preflight refusal still reports it (the pre-#828 order is kept)");
});

// --- ConnectTimeout: rides on the ssh client argv and the git transport command ---

test("ssh: every call carries -o ConnectTimeout, and the git transport's GIT_SSH_COMMAND does too", async () => {
  const ssh = withFakeSsh();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-wt-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-repo-"));
  const wtDir = path.join(workDir, "wt");
  initGitRepo(repoDir);
  execGit(repoDir, ["worktree", "add", wtDir, "-b", "feature"]);
  try {
    const remote = { host: "worker.test", workDir };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    // Full sync (worktree step) then a bare launch — every local ssh invocation must carry the timeout.
    // cwd is a dedicated run dir, not workDir itself: the sync's `rm -rf <cwd>` must not eat the
    // worker's repos dir (a real run's worktree is always such a subpath).
    const runDir = path.join(workDir, "runs", "1");
    fs.mkdirSync(runDir, { recursive: true });
    const agentScript = path.join(workDir, "fake-agent.sh");
    fs.writeFileSync(agentScript, `#!/bin/sh\ncat > /dev/null\nmkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"\necho '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"\nexit 0\n`, { mode: 0o755 });
    const { spawnAgent } = spawnCtx();
    remote.bin = agentScript;
    const result = await stall(spawnAgent({
      agent: fakeAgent(),
      prompt: "hi",
      cwd: runDir,
      logPath: path.join(workDir, "run.log"),
      verdictFile: executor.paths({ stepId: "code", ref: "1" }).verdictFile,
      sandboxed: { ref: "1", stepId: "code", step: {}, mounts: [], hub: { repoId: "r1", repoPath: repoDir, worktree: wtDir, branch: "feature" } },
      executor,
    }), 20000);
    assert.equal(result.code, 0, JSON.stringify(result));
    const rec = ssh.record();
    assert.ok(rec.length >= 3, `expected sync + launch ssh calls, saw ${rec.length}`);
    for (const r of rec) assert.ok(r.all.includes("ConnectTimeout=10"), `an ssh call lacks ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}: ${JSON.stringify(r.all)}`);
    const push = rec.find((r) => r.all.some((el) => el.includes("git-receive-pack")));
    assert.ok(push, "the git push over the ssh transport was never recorded");
    assert.ok(push.all.some((el) => el.includes(`ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`)), "GIT_SSH_COMMAND must carry ConnectTimeout: " + JSON.stringify(push.all));
  } finally {
    ssh.restore();
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// --- the sync path: unreachable ⇒ worker-unreachable marker, config ⇒ clean refusal ---

test("ssh executor: a refused/timed-out connection during the pre-run sync rejects with worker unreachable", async () => {
  for (const [stderr, detail] of [
    ["ssh: connect to host worker-x port 22: Connection refused", "connection refused"],
    ["ssh: connect to host worker-x port 22: Connection timed out", "connection timed out"],
  ]) {
    const ssh = withFailingSsh(stderr);
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-repo-"));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-work-"));
    initGitRepo(repoDir);
    try {
      const remote = { host: "worker-x", workDir };
      const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
      const { spawnAgent } = spawnCtx();
      const verdict = await stall(spawnAgent({
        agent: fakeAgent(),
        prompt: "hi",
        cwd: workDir,
        logPath: path.join(workDir, "run.log"),
        verdictFile: executor.paths({ stepId: "code", ref: "2" }).verdictFile,
        sandboxed: { ref: "2", stepId: "code", step: {}, mounts: [], hub: { repoId: "r1", repoPath: repoDir } },
        executor,
      }), 20000).then(
        (r) => ({ resolved: true, r }),
        (e) => ({ resolved: false, e }),
      );
      assert.equal(verdict.resolved, true, `the launch must resolve refused (finishStep reports it), not throw: ${stderr}`);
      assert.equal(verdict.r.code, 1);
      assert.equal(verdict.r.unreachable, `worker unreachable: worker-x (${detail})`, "the marker rides the result so finish() can trip the breaker");
      assert.match(verdict.r.refused ?? "", /export to worker failed/);
      assert.ok(!verdict.r.sshConfigFailure, "an unreachable worker is not an auth/host-key config failure");
      assert.ok(ssh.argvs().some((a) => a.includes(`ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`)), "the failing ssh call itself must have carried ConnectTimeout");
    } finally {
      ssh.restore();
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
});

test("ssh executor: an auth or host-key failure during the sync is a clean refusal (no breaker, no requeue)", async () => {
  const cases = [
    ["git@worker-x: Permission denied (publickey).", "ssh auth failed on worker-x: git@worker-x: Permission denied (publickey)."],
    ["Host key verification failed.", "ssh host key failed on worker-x: Host key verification failed."],
  ];
  for (const [stderr, wantReason] of cases) {
    const ssh = withFailingSsh(stderr);
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-repo-"));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-work-"));
    initGitRepo(repoDir);
    try {
      const remote = { host: "worker-x", workDir };
      const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
      const { spawnAgent } = spawnCtx();
      const verdict = await stall(spawnAgent({
        agent: fakeAgent(),
        prompt: "hi",
        cwd: workDir,
        logPath: path.join(workDir, "run.log"),
        verdictFile: executor.paths({ stepId: "code", ref: "3" }).verdictFile,
        sandboxed: { ref: "3", stepId: "code", step: {}, mounts: [], hub: { repoId: "r1", repoPath: repoDir } },
        executor,
      }), 20000).then(
        (r) => ({ resolved: true, r }),
        (e) => ({ resolved: false, e }),
      );
      assert.equal(verdict.resolved, true, `the launch must resolve refused (finishStep reports it), not throw: ${stderr}`);
      assert.equal(verdict.r.code, 1);
      assert.equal(verdict.r.refused, wantReason, "the refusal must say which auth/host-key failure and on which worker");
      assert.equal(verdict.r.sshConfigFailure, wantReason);
      assert.equal(verdict.r.unreachable, undefined, "an auth/host-key failure must NOT mark the worker unreachable (no breaker trip)");
    } finally {
      ssh.restore();
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
});

// The worktree-push sync path (a step whose hub worktree is pushed to the worker's bare repo): the
// first ssh contact is `ensureWorkerBareRepo` (runRemoteChecked) — unreachable/classified the
// same way as the archive path above, before any push happens.

test("ssh executor: an unreachable worker during the worktree-push sync rejects with the worker-unreachable marker", async () => {
  const cases = [
    ["ssh: connect to host worker-x port 22: No route to host", "no route to host", /No route to host/],
    ["ssh: connect to host worker-x port 22: Connection refused", "connection refused", /Connection refused/],
  ];
  for (const [stderr, detail, reasonRe] of cases) {
    const ssh = withFailingSsh(stderr);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-wt-work-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-wt-repo-"));
    const wtDir = path.join(workDir, "wt");
    initGitRepo(repoDir);
    execGit(repoDir, ["worktree", "add", wtDir, "-b", "feature"]);
    try {
      const remote = { host: "worker-x", workDir };
      const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
      const { spawnAgent } = spawnCtx();
      // A real run's worktree cwd is a per-run subdir of the worker's dir: the sync's `rm -rf <cwd>`
      // must not eat the worker's repos dir, so the fake ssh would have to survive it.
      const runDir = path.join(workDir, "runs", "7");
      fs.mkdirSync(runDir, { recursive: true });
      const result = await stall(spawnAgent({
        agent: fakeAgent(),
        prompt: "hi",
        cwd: runDir,
        logPath: path.join(workDir, "run.log"),
        verdictFile: executor.paths({ stepId: "code", ref: "7" }).verdictFile,
        sandboxed: { ref: "7", stepId: "code", step: {}, mounts: [], hub: { repoId: "r1", repoPath: repoDir, worktree: wtDir, branch: "feature" } },
        executor,
      }), 20000).then((r) => ({ resolved: true, r }), (e) => ({ resolved: false, e }));
      assert.equal(result.resolved, true, `the launch must resolve refused (finishStep reports it), not throw: ${stderr}`);
      assert.equal(result.r.code, 1);
      assert.equal(result.r.unreachable, `worker unreachable: worker-x (${detail})`, "the marker rides the result so finish() can trip the breaker");
      assert.match(result.r.refused ?? "", reasonRe, "the raw reason carries the ssh stderr line, not a config-failure rewrite");
      assert.ok(!result.r.sshConfigFailure, "an unreachable worker is not an auth/host-key config failure");
    } finally {
      ssh.restore();
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
});

test("ssh executor: an auth or host-key failure during the worktree-push sync is a clean refusal (no breaker, no requeue)", async () => {
  const cases = [
    ["git@worker-x: Permission denied (publickey).", "ssh auth failed on worker-x: git@worker-x: Permission denied (publickey)."],
    ["Host key verification failed.", "ssh host key failed on worker-x: Host key verification failed."],
  ];
  for (const [stderr, wantReason] of cases) {
    const ssh = withFailingSsh(stderr);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-wt-work-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-wt-repo-"));
    const wtDir = path.join(workDir, "wt");
    initGitRepo(repoDir);
    execGit(repoDir, ["worktree", "add", wtDir, "-b", "feature"]);
    try {
      const remote = { host: "worker-x", workDir };
      const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
      const { spawnAgent } = spawnCtx();
      const runDir = path.join(workDir, "runs", "8");
      fs.mkdirSync(runDir, { recursive: true });
      const result = await stall(spawnAgent({
        agent: fakeAgent(),
        prompt: "hi",
        cwd: runDir,
        logPath: path.join(workDir, "run.log"),
        verdictFile: executor.paths({ stepId: "code", ref: "8" }).verdictFile,
        sandboxed: { ref: "8", stepId: "code", step: {}, mounts: [], hub: { repoId: "r1", repoPath: repoDir, worktree: wtDir, branch: "feature" } },
        executor,
      }), 20000).then((r) => ({ resolved: true, r }), (e) => ({ resolved: false, e }));
      assert.equal(result.resolved, true, `the launch must resolve refused (finishStep reports it), not throw: ${stderr}`);
      assert.equal(result.r.code, 1);
      assert.equal(result.r.refused, wantReason, "the refusal must say which auth/host-key failure and on which worker");
      assert.equal(result.r.sshConfigFailure, wantReason);
      assert.equal(result.r.unreachable, undefined, "an auth/host-key failure must NOT mark the worker unreachable (no breaker trip)");
    } finally {
      ssh.restore();
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
});

// --- the run itself: ssh exits 255 before/during the run ---

test("ssh executor: exit 255 with unreachable stderr becomes a verbatim worker-unreachable trip (no spawn-error prefix)", async () => {
  const cases = [
    ["ssh: connect to host worker-x port 22: Connection refused", "connection refused"],
    ["ssh: connect to host worker-x port 22: Connection timed out", "connection timed out"],
    ["ssh: connect to host worker-x port 22: No route to host", "no route to host"],
  ];
  for (const [stderr, detail] of cases) {
    const ssh = withFailingSsh(stderr);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-work-"));
    try {
      const remote = { host: "worker-x", workDir, bin: "irrelevant" };
      const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
      const { spawnAgent } = spawnCtx();
      const result = await stall(spawnAgent({
        agent: fakeAgent(),
        prompt: "hi",
        cwd: workDir,
        logPath: path.join(workDir, "run.log"),
        verdictFile: executor.paths({ stepId: "code", ref: "4" }).verdictFile,
        sandboxed: { ref: "4", stepId: "code", step: {}, mounts: [] },
        executor,
      }), 20000);
      assert.ok(result.noOutput);
      assert.equal(result.unreachable, `worker unreachable: worker-x (${detail})`, "the marker rides the result so finish() can trip the breaker");
      assert.equal(result.spawnError, undefined, "a launch-time unreachable worker is a health signal, not a spawn error");
      // `refused` carries the same reason so a run without a harness fails on it (no fall-through to the verdict file).
      assert.equal(result.refused, `worker unreachable: worker-x (${detail})`);
      assert.equal(
        healthTrip({ unreachable: result.unreachable, code: result.code, cancelled: false, noOutput: result.noOutput, wallMs: 999999 }),
        `worker unreachable: worker-x (${detail})`,
        "the trip reason is verbatim — no 'spawn failed:' prefix",
      );
    } finally {
      ssh.restore();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
});

test("ssh executor: exit 255 with auth or host-key stderr becomes a refusal that never trips healthTrip", async () => {
  const cases = [
    ["git@worker-x: Permission denied (publickey).", "ssh auth failed on worker-x: git@worker-x: Permission denied (publickey)."],
    ["Host key verification failed.", "ssh host key failed on worker-x: Host key verification failed."],
  ];
  for (const [stderr, wantReason] of cases) {
    const ssh = withFailingSsh(stderr);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-work-"));
    try {
      const remote = { host: "worker-x", workDir, bin: "irrelevant" };
      const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
      const { spawnAgent } = spawnCtx();
      const result = await stall(spawnAgent({
        agent: fakeAgent(),
        prompt: "hi",
        cwd: workDir,
        logPath: path.join(workDir, "run.log"),
        verdictFile: executor.paths({ stepId: "5" }).verdictFile,
        sandboxed: { ref: "5", stepId: "code", step: {}, mounts: [] },
        executor,
      }), 20000);
      assert.equal(result.code, 255);
      assert.equal(result.refused, wantReason, "the refusal must say which auth/host-key failure and on which worker");
      assert.equal(result.sshConfigFailure, wantReason);
      assert.equal(result.unreachable, undefined, "an auth/host-key failure must NOT mark the worker unreachable (no breaker trip)");
      assert.equal(result.spawnError, undefined, "an auth failure is a refusal, not a spawn error");
      // Without the suppression field this exact shape (fast exit, no output) would trip.
      assert.notEqual(healthTrip({ code: result.code, cancelled: false, noOutput: result.noOutput, wallMs: result.wallMs ?? 50 }), undefined);
      assert.equal(healthTrip({ sshConfigFailure: result.sshConfigFailure, code: result.code, cancelled: false, noOutput: result.noOutput, wallMs: 50 }), undefined);
    } finally {
      ssh.restore();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
});

test("ssh executor: a mid-run connection loss (255 after output) is neither a refusal nor a trip", async () => {
  const ssh = withDroppingSsh("worker: started the job", "Connection to worker-x lost.");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-work-"));
  try {
    const remote = { host: "worker-x", workDir, bin: "irrelevant" };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const { spawnAgent } = spawnCtx();
    const result = await stall(spawnAgent({
      agent: fakeAgent(),
      prompt: "hi",
      cwd: workDir,
      logPath: path.join(workDir, "run.log"),
      verdictFile: executor.paths({ stepId: "code", ref: "6" }).verdictFile,
      sandboxed: { ref: "6", stepId: "code", step: {}, mounts: [] },
      executor,
    }), 20000);
    assert.equal(result.code, 255);
    assert.equal(result.noOutput, false, "the worker produced output before the link dropped");
    assert.equal(result.refused, undefined);
    assert.equal(result.spawnError, undefined, "a mid-run loss is not classified as an unreachable worker");
    assert.equal(healthTrip({ code: result.code, cancelled: false, noOutput: result.noOutput, wallMs: 50 }), undefined, "and so it must not trip the breaker");
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});


// --- helpers (kept local: this is the only test file that builds a worktree for the hub) ---

function execGit(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
