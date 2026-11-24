import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// #828: an unreachable remote-harness worker must trip the breaker (with a clear
// `worker unreachable: <host> (…) reason`), never refuse or fail the ticket. Covers the ssh
// failure classifier, the ConnectTimeout wiring (ssh client + git transport), the sync/launch
// failure paths against a fake `ssh`, and — at dispatcher level — that a worker-unreachable
// trip requeues with the attempt count restored (a trip never counts, owner decision, option 3).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { classifySshFailure, sshConfigFailureReason, createSshExecutor, SSH_CONNECT_TIMEOUT_S } from "../src/dispatch/executor-ssh.js";
import { healthTrip } from "../src/dispatch/harness.js";
import { withFakeSsh, withFailingSsh, withDroppingSsh, spawnCtx, fakeAgent, initGitRepo } from "./_ssh-helpers.js";
import { createStore } from "../src/store.js";
import { createDispatcher } from "../src/dispatch.js";

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
  assert.equal(healthTrip({ ...base, cancelled: true, unreachable: "worker unreachable: x (refused)" }), undefined, "a cancelled run never trips");
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
    const result = await spawnAgent({
      agent: fakeAgent(),
      prompt: "hi",
      cwd: runDir,
      logPath: path.join(workDir, "run.log"),
      verdictFile: executor.paths({ stepId: "code", ref: "1" }).verdictFile,
      sandboxed: { ref: "1", stepId: "code", step: {}, mounts: [], hub: { repoId: "r1", repoPath: repoDir, worktree: wtDir, branch: "feature" } },
      executor,
    });
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
      const verdict = await spawnAgent({
        agent: fakeAgent(),
        prompt: "hi",
        cwd: workDir,
        logPath: path.join(workDir, "run.log"),
        verdictFile: executor.paths({ stepId: "code", ref: "2" }).verdictFile,
        sandboxed: { ref: "2", stepId: "code", step: {}, mounts: [], hub: { repoId: "r1", repoPath: repoDir } },
        executor,
      }).then(
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
      const verdict = await spawnAgent({
        agent: fakeAgent(),
        prompt: "hi",
        cwd: workDir,
        logPath: path.join(workDir, "run.log"),
        verdictFile: executor.paths({ stepId: "code", ref: "3" }).verdictFile,
        sandboxed: { ref: "3", stepId: "code", step: {}, mounts: [], hub: { repoId: "r1", repoPath: repoDir } },
        executor,
      }).then(
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

// --- the run itself: ssh exits 255 before/during the run ---

test("ssh executor: exit 255 with unreachable stderr becomes a worker-unreachable spawnError that trips healthTrip", async () => {
  const ssh = withFailingSsh("ssh: connect to host worker-x port 22: Connection timed out");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-work-"));
  try {
    const remote = { host: "worker-x", workDir, bin: "irrelevant" };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const { spawnAgent } = spawnCtx();
    const result = await spawnAgent({
      agent: fakeAgent(),
      prompt: "hi",
      cwd: workDir,
      logPath: path.join(workDir, "run.log"),
      verdictFile: executor.paths({ stepId: "code", ref: "4" }).verdictFile,
      sandboxed: { ref: "4", stepId: "code", step: {}, mounts: [] },
      executor,
    });
    assert.equal(result.spawnError, "worker unreachable: worker-x (connection timed out)");
    assert.ok(result.noOutput);
    const tripped = healthTrip({ spawnError: result.spawnError, code: result.code, cancelled: false, noOutput: result.noOutput, wallMs: 999999 });
    assert.equal(tripped, "spawn failed: worker unreachable: worker-x (connection timed out)");
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("ssh executor: exit 255 with auth stderr becomes a refusal that never trips healthTrip", async () => {
  const ssh = withFailingSsh("git@worker-x: Permission denied (publickey).");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-work-"));
  try {
    const remote = { host: "worker-x", workDir, bin: "irrelevant" };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const { spawnAgent } = spawnCtx();
    const result = await spawnAgent({
      agent: fakeAgent(),
      prompt: "hi",
      cwd: workDir,
      logPath: path.join(workDir, "run.log"),
      verdictFile: executor.paths({ stepId: "code", ref: "5" }).verdictFile,
      sandboxed: { ref: "5", stepId: "code", step: {}, mounts: [] },
      executor,
    });
    assert.equal(result.code, 255);
    assert.equal(result.refused, "ssh auth failed on worker-x: git@worker-x: Permission denied (publickey).");
    assert.equal(result.sshConfigFailure, "ssh auth failed on worker-x: git@worker-x: Permission denied (publickey).");
    assert.equal(result.spawnError, undefined, "an auth failure is a refusal, not a spawn error");
    // Without the suppression field this exact shape (fast exit, no output) would trip.
    assert.notEqual(healthTrip({ code: result.code, cancelled: false, noOutput: result.noOutput, wallMs: result.wallMs ?? 50 }), undefined);
    assert.equal(healthTrip({ sshConfigFailure: result.sshConfigFailure, code: result.code, cancelled: false, noOutput: result.noOutput, wallMs: 50 }), undefined);
  } finally {
    ssh.restore();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("ssh executor: a mid-run connection loss (255 after output) is neither a refusal nor a trip", async () => {
  const ssh = withDroppingSsh("worker: started the job", "Connection to worker-x lost.");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-work-"));
  try {
    const remote = { host: "worker-x", workDir, bin: "irrelevant" };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(workDir, "hub.json") } });
    const { spawnAgent } = spawnCtx();
    const result = await spawnAgent({
      agent: fakeAgent(),
      prompt: "hi",
      cwd: workDir,
      logPath: path.join(workDir, "run.log"),
      verdictFile: executor.paths({ stepId: "code", ref: "6" }).verdictFile,
      sandboxed: { ref: "6", stepId: "code", step: {}, mounts: [] },
      executor,
    });
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

// --- dispatcher level: a worker-unreachable trip requeues and never consumes an attempt ---

test("dispatcher: an unreachable worker trips the breaker — run_end requeued, the ticket is not moved, and the attempt count is restored even past the cap", async () => {
  const ssh = withFailingSsh("ssh: connect to host worker-x port 22: Connection refused");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-dispatch-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-dispatch-repo-"));
  initGitRepo(repoDir);
  try {
    const cfg = /** @type {any} */ ({
      repoPath: repoDir,
      worktreePrefix: path.join(dir, "wt"),
      dataDir: dir,
      logDir: dir,
      instructionsFile: path.join(dir, "none.md"),
      harnesses: { "worker-x": { remote: { host: "worker-x", workDir: path.join(dir, "work") } } },
      pipeline: [{ id: "code", harness: "worker-x", maxAttempts: 2 }],
    });
    const store = createStore(dir);
    store.bumpAttempt("42", "code");
    store.bumpAttempt("42", "code");
    store.bumpAttempt("42", "code"); // already 3 — past maxAttempts 2; a trip must still requeue
    /** @type {any[]} */ const events = [];
    /** @type {any[]} */ const advanced = [];
    const adapter = /** @type {any} */ ({
      describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
      fetchTask: async (ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
      advance: async (ref, stepId, v) => advanced.push([ref, stepId, v.outcome, v.reason]),
    });
    const emit = (event, _r, _s, extra) => events.push({ event, ...extra });
    const run = createDispatcher(cfg, adapter, undefined, store, emit);
    const log = console.log;
    console.log = () => {};
    let info;
    try {
      info = await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code", harness: "worker-x" });
    } finally {
      console.log = log;
    }
    info = /** @type {any} */ (info);
    assert.deepEqual(advanced, [], "the ticket must not be moved by a worker-unreachable trip");
    assert.equal(info.health.harness, "worker-x");
    assert.equal(info.health.reason, "worker unreachable: worker-x (connection refused)");
    assert.equal(info.health.requeue, true, "a trip always requeues — even past the attempt cap");
    const runEnd = events.find((e) => e.event === "run_end");
    assert.equal(runEnd.outcome, "requeued");
    assert.match(runEnd.reason, /^worker unreachable: worker-x \(connection refused\)/);
    assert.equal(store.getAttempt("42", "code"), 3, "the pre-run bump is undone — the trip never counts as an attempt");
  } finally {
    ssh.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// --- helpers (kept local: this is the only test file that builds a worktree for the hub) ---

function execGit(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
