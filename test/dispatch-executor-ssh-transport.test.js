import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The ssh executor (#689, experimental): code transport (#690) at the spawnAgent level — sync
// the ticket's code to the worker over git+SSH, and back, including the hub-side hardening
// (HOST_GIT_SAFE, --no-tags) and the raw-launch (#710) gate exception. Split from
// dispatch-executor-ssh.test.js (see #717-style splits).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { shQuote, framePayload, remoteEnvAllowlist, createSshExecutor } from "../src/dispatch/executor-ssh.js";
import { initGitRepo, withFakeSsh, spawnCtx, fakeAgent, writeCommitAgent, headOf, withArgvRecordingGit } from "./_ssh-helpers.js";

// --- code transport (#690): sync the ticket's code to the worker over git+SSH, and back ---

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

test("ssh executor raw launch (#710's gate): runs the given argv verbatim on the worker, with an empty prompt, and done() never fetches edits back", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-raw-"));
  const workerRoot = path.join(root, "worker");
  const hubWorktree = path.join(root, "hub-worktree");
  fs.mkdirSync(workerRoot, { recursive: true });
  initGitRepo(hubWorktree);
  const branch = "agent/raw";
  execFileSync("git", ["-C", hubWorktree, "checkout", "-b", branch], { stdio: "ignore" });
  try {
    const remote = { host: "worker.test", workDir: workerRoot };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") } });
    const { cwd } = executor.paths({ stepId: "code", ref: "1", hasWorktree: true });
    const hub = { repoId: "default", repoPath: hubWorktree, worktree: hubWorktree, branch };
    const headBefore = headOf(hubWorktree);

    const box = await executor.launch({
      runId: "gate-1",
      ref: "1",
      stepId: "code",
      bin: "sh",
      args: ["-c", "git config user.email a@test.local && git config user.name a && git commit --allow-empty -q -m raw-run; echo did-not-pull-a-prompt"],
      env: {},
      cwd,
      mounts: [],
      step: {},
      hub,
      raw: true,
    });
    assert.equal(box.stdin, framePayload(remoteEnvAllowlist({}), ""), "raw carries an empty prompt on stdin, never a real one");
    assert.ok(fs.existsSync(cwd), "a worktree-step raw launch still gets the worker worktree synced");

    // Stdin must stay open until the remote process exits on its own (closing it is itself one of
    // the launcher's kill signals, src/dispatch/spawn.js) — never execFileSync/spawnSync's
    // write-then-close, which would race the kill watchdog.
    const { spawn } = await import("node:child_process");
    const out = await new Promise((resolve, reject) => {
      const child = spawn(box.bin, box.args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", () => {});
      child.stdin.write(box.stdin);
      child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stdout}`))));
      child.on("error", reject);
    });
    assert.match(out, /did-not-pull-a-prompt/, "the given argv ran verbatim on the worker");
    const report = await box.done();
    assert.deepEqual(report, {}, "raw done() never reports a sync-back failure (it never syncs back)");
    assert.equal(headOf(hubWorktree), headBefore, "a raw run's edits on the worker are discarded — the hub worktree never advances");
    assert.ok(!fs.existsSync(cwd), "the worker worktree is cleaned up after a raw run");
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

    // A no-worktree (export) step's hub calls — against repoPath, not the worktree path — are a
    // separate code path (`archiveToWorker`/`submoduleOrLfsPath`), so it's checked separately.
    const repoPath = hubWorktree;
    const { cwd: exportCwd, verdictFile: exportVerdictFile } = executor.paths({ stepId: "triage", ref: "7", hasWorktree: false });
    const exportHub = { repoId: "default", repoPath };
    const exportResult = await spawnAgent({ agent: fakeAgent(), prompt: "go", cwd: exportCwd, logPath: path.join(root, "run-export.log"), verdictFile: exportVerdictFile, sandboxed: { ref: "7", stepId: "triage", step: {}, mounts: [], hub: exportHub }, executor });
    assert.equal(exportResult.code, 0, JSON.stringify(exportResult));

    const exportCalls = rec.callsFor(repoPath).slice(hubCalls.length);
    const exportOps = new Set(exportCalls.map((a) => a[a.indexOf("-C") + 2]));
    for (const op of ["show", "archive"]) {
      assert.ok(exportOps.has(op), `expected a hub-side "${op}" call for the no-worktree export, saw ops ${JSON.stringify([...exportOps])}`);
    }
    for (const call of exportCalls) {
      assert.deepEqual(call.slice(0, 4), ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"], `every hub call for a no-worktree export must be HOST_GIT_SAFE-hardened, got ${JSON.stringify(call)}`);
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
