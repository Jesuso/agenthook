import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// #848: the archive (no-worktree) sync path had no time bound and settled only once BOTH the
// `git archive` and `ssh` children emitted `close` — a child's `close` needs its stdout/stderr
// streams to end, and `git.stdout` only drains once something keeps consuming it after ssh's own
// exit unpipes it. A worker that never answers and never exits left `archiveToWorker` (and so
// `spawnAgent`) pending forever, holding a dispatch slot. Split out of
// dispatch-ssh-unreachable.test.js to stay under its ~25KB budget.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSshExecutor, __setArchiveTimeoutMsForTest } from "../src/dispatch/executor-ssh.js";
import { withHangingSsh, spawnCtx, fakeAgent, initGitRepo, stall } from "./_ssh-helpers.js";

test("ssh executor: a worker that never exits and never reads stdin during the archive sync times out instead of hanging", async () => {
  __setArchiveTimeoutMsForTest(200);
  const ssh = withHangingSsh();
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-848-repo-"));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-848-work-"));
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
      verdictFile: executor.paths({ stepId: "code", ref: "848" }).verdictFile,
      sandboxed: { ref: "848", stepId: "code", step: {}, mounts: [], hub: { repoId: "r1", repoPath: repoDir } },
      executor,
    }), 5000).then(
      (r) => ({ resolved: true, r }),
      (e) => ({ resolved: false, e }),
    );
    assert.equal(verdict.resolved, true, "a timed-out archive sync must resolve refused, not hang");
    assert.equal(verdict.r.code, 1);
    assert.match(verdict.r.refused ?? "", /timed out after 0\.2s/, "the timeout must give a clear, specific reason");
    assert.ok(!verdict.r.sshConfigFailure, "a plain timeout is not an auth/host-key config failure");
    assert.ok(!verdict.r.unreachable, "a plain timeout is not the unreachable-worker marker (no breaker trip)");
  } finally {
    __setArchiveTimeoutMsForTest();
    ssh.restore();
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
