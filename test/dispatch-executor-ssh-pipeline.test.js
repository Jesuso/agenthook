import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The ssh executor (#689, experimental): code transport (#690) at the full-pipeline level
// (step.js/finish.js, not just spawnAgent), the raw-launched gate (#710), paths()/reap()
// determinism, and the --no-tags hardening (#691). Split from dispatch-executor-ssh.test.js
// (see #717-style splits).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { shQuote, createSshExecutor } from "../src/dispatch/executor-ssh.js";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store.js";
import { initGitRepo, withFakeSsh, spawnCtx, fakeAgent, writeCommitAgent, headOf, withArgvRecordingGit } from "./_ssh-helpers.js";

// --- code transport (#690) at the full-pipeline level: step.js/finish.js, not just spawnAgent ---

/** A real git repo + a `claude`-shaped fake bin, for a dispatch-level (`createDispatcher`) test
 * of a remote `createsWorktree` step. Mirrors `deduceHarness` in test/dispatch-deduce.test.js, but the
 * step's harness is a remote one, so the agent actually runs on the "worker" (the fake-ssh
 * double) against the worktree #690 synced there — not directly in the hub worktree.
 * @param {{pipeline: any[]}} o */
function remoteWorktreeHarness({ pipeline }) {
  /** @type {any[]} */
  const events = [];
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
  const run = createDispatcher(cfg, adapter, undefined, store, (event, ref, step, extra) => events.push({ event, ref, step, ...extra }));
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
  return { cfg, store, advanced, events, runStep, dir, repoDir, workDir, agentScript };
}

const WORKTREE_PIPELINE = [
  { id: "code", harness: "worker", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0 },
  { id: "review", sourceLabel: "src:review" },
];

// No verdictRepairs: 0 here on purpose, same reasoning as test/dispatch-deduce.test.js's own deduce
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

// --- gate (#710) on the ssh executor ---

const GATE_PIPELINE = [
  { id: "code", harness: "worker", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review", verdictRepairs: 0, gate: "true", gateTimeoutMinutes: 1 },
  { id: "review", sourceLabel: "src:review" },
];

test("dispatch: an ssh step's gate runs via a raw launch, through the real sandboxVerdictPathFor wiring — a passing gate must not wipe the agent's own advance verdict", async () => {
  const ssh = withFakeSsh();
  const h = remoteWorktreeHarness({ pipeline: GATE_PIPELINE });
  const scriptBody = [
    "#!/bin/sh",
    "cat > /dev/null",
    'mkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"',
    'echo \'{"outcome":"advance","reason":"the agent itself thinks it succeeded"}\' > "$AGENTHOOK_VERDICT_FILE"',
    'printf \'{"type":"result","subtype":"success","session_id":"s1","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0.01}\\n\'',
    "exit 0",
    "",
  ].join("\n");
  try {
    const result = await h.runStep("code", scriptBody);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(h.advanced.length, 1, "exactly one advance — the gate must veto, not grant, and here it passes");
    assert.equal(h.advanced[0].outcome, "advance", `a passing raw-launched gate must not cost the agent's own verdict (got ${JSON.stringify(h.advanced[0])})`);
    assert.equal(h.advanced[0].reason, "the agent itself thinks it succeeded", "the agent's own verdict reason must survive the gate run untouched");
    assert.ok(h.events.some((e) => e.event === "gate_pass"), "gate_pass must have fired");
    assert.ok(!h.events.some((e) => e.event === "gate_fail"), "the gate must not be reported as failing");
    assert.ok(h.events.some((e) => e.event === "run_end" && e.outcome === "advance" && e.gate === "pass"), `run_end must carry gate: "pass" (got ${JSON.stringify(h.events.filter((e) => e.event === "run_end"))})`);
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

// --- hardening: sync-back must not follow worker-planted tags (#691) ---

test("ssh executor code transport (#691): the sync-back fetch argv carries --no-tags", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-sync-notags-argv-"));
  const workerRoot = path.join(root, "worker");
  const hubWorktree = path.join(root, "hub-worktree");
  fs.mkdirSync(workerRoot, { recursive: true });
  initGitRepo(hubWorktree);
  const branch = "agent/notags";
  execFileSync("git", ["-C", hubWorktree, "checkout", "-b", branch], { stdio: "ignore" });
  const rec = withArgvRecordingGit();
  try {
    const remote = { host: "worker.test", workDir: workerRoot, bin: writeCommitAgent(workerRoot, "notags.txt") };
    const cfg = { harnesses: { worker: { remote } } };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") }, cfg });
    const { cwd, verdictFile } = executor.paths({ stepId: "code", ref: "notags", hasWorktree: true });
    const hub = { repoId: "default", repoPath: hubWorktree, worktree: hubWorktree, branch };
    const { spawnAgent } = spawnCtx();
    const result = await spawnAgent({ agent: fakeAgent(), prompt: "go", cwd, logPath: path.join(root, "run.log"), verdictFile, sandboxed: { ref: "notags", stepId: "code", step: {}, mounts: [], hub }, executor });
    assert.equal(result.code, 0, JSON.stringify(result));
    const fetchCall = rec.callsFor(hubWorktree).find((a) => a.includes("fetch"));
    assert.ok(fetchCall, "expected a hub-side fetch call");
    assert.ok(fetchCall.includes("--no-tags"), `fetch argv must carry --no-tags, got ${JSON.stringify(fetchCall)}`);
  } finally {
    rec.restore();
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ssh executor code transport (#691): a tag the worker plants on its new commit never reaches the hub repo; the commit itself still fast-forwards", async () => {
  const ssh = withFakeSsh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-sync-notags-e2e-"));
  const workerRoot = path.join(root, "worker");
  const hubWorktree = path.join(root, "hub-worktree");
  fs.mkdirSync(workerRoot, { recursive: true });
  initGitRepo(hubWorktree);
  const branch = "agent/notags2";
  execFileSync("git", ["-C", hubWorktree, "checkout", "-b", branch], { stdio: "ignore" });
  try {
    // A worker agent that commits AND tags its own new commit — the tag must never auto-follow
    // into the hub repo, even though it points straight into the fetched history.
    const agentScript = path.join(workerRoot, "tagging-agent.sh");
    fs.writeFileSync(
      agentScript,
      `#!/bin/sh\ncat > /dev/null\ngit config user.email a@test.local\ngit config user.name a\necho hi > tagged.txt\ngit add tagged.txt\ngit commit --quiet -m "worker commit with a tag"\ngit tag planted-tag\nmkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"\necho '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"\nexit 0\n`,
      { mode: 0o755 },
    );
    const remote = { host: "worker.test", workDir: workerRoot, bin: agentScript };
    const cfg = { harnesses: { worker: { remote } } };
    const executor = createSshExecutor({ stateKey: "p", remote, spawnPaths: { sandboxVerdictPathFor: () => path.join(root, "hub-verdict.json") }, cfg });
    const { cwd, verdictFile } = executor.paths({ stepId: "code", ref: "notags2", hasWorktree: true });
    const hub = { repoId: "default", repoPath: hubWorktree, worktree: hubWorktree, branch };
    const { spawnAgent } = spawnCtx();
    const headBefore = headOf(hubWorktree);
    const tagsBefore = execFileSync("git", ["-C", hubWorktree, "tag", "-l"], { encoding: "utf8" }).trim();
    const result = await spawnAgent({ agent: fakeAgent(), prompt: "go", cwd, logPath: path.join(root, "run.log"), verdictFile, sandboxed: { ref: "notags2", stepId: "code", step: {}, mounts: [], hub }, executor });
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.ok(!result.sandboxReport?.failed, JSON.stringify(result.sandboxReport));
    assert.notEqual(headOf(hubWorktree), headBefore, "the commit itself must still fast-forward into the hub worktree");
    assert.equal(execFileSync("git", ["-C", hubWorktree, "tag", "-l"], { encoding: "utf8" }).trim(), tagsBefore, "no new tag must have reached the hub repo");
  } finally {
    ssh.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
