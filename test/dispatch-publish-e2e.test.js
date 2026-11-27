import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The outbox publisher at the finishStep level (#825, review rework): the finish.js/spawn.js
// wiring the unit tests (test/dispatch-publish.test.js) never see — a remote (ssh) run's
// outbox is copied back and published with the hub's own credentials (fake forge/tracker
// record the calls), a workflow touch means the APPLIED verdict is hold, a host run with the
// same files publishes nothing, and a verdict-repair turn keeps the first turn's outbox
// (the resume launch never wipes it). Mirrors remoteWorktreeHarness in
// test/dispatch-executor-ssh-pipeline.test.js (fake ssh double, real dispatcher).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFakeSsh, initGitRepo } from "./_ssh-helpers.js";
import { createDispatcher } from "../src/dispatch/index.js";
import { createStore } from "../src/store/index.js";

const PIPELINE = [
  { id: "code", harness: "worker", createsWorktree: true, sourceLabel: "src:code", successLabel: "src:review" },
  { id: "review", sourceLabel: "src:review" },
];
const PR = { title: "Fix the flaky test", body: "what I did" };
const COMMENT = "Ran the suite, here is the result.";

/** The fake worker agent's script: drains stdin, then writes the outbox (next to
 * $AGENTHOOK_VERDICT_FILE, where the worker's done() copies it back) and the verdict.
 * @param {string} [turnGate] when set (a counter file path), the OUTBOX is written only on
 * turn 1 and the verdict only from turn 2 — the verdict-repair case (turn 1 exits clean with
 * no verdict, turn 2 is the resume that must keep turn 1's outbox/). */
function agentScript(turnGate) {
  const outbox = [
    `mkdir -p "$d/outbox"`,
    `printf '%s' ${JSON.stringify(JSON.stringify(PR))} > "$d/outbox/pr.json"`,
    `printf '%s' ${JSON.stringify(COMMENT)} > "$d/outbox/comment.md"`,
  ];
  const verdict = [`printf '%s' '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"`];
  return [
    "#!/bin/sh",
    "cat > /dev/null",
    // the claude adapter's parseResults needs a result line with a session_id for a
    // verdict-repair turn to find the session to resume (#677's gate);
    `printf '{"type":"result","session_id":"s1","result":"ok"}\n'`,
    `d="$(dirname "$AGENTHOOK_VERDICT_FILE")"`,
    ...(turnGate
      ? [
          `n=$(( $(cat ${JSON.stringify(turnGate)} 2>/dev/null || echo 0) + 1 ))`,
          `echo "$n" > ${JSON.stringify(turnGate)}`,
          `if [ "$n" = "1" ]; then`,
          ...outbox,
          `  exit 0`,
          `fi`,
          ...verdict,
          "exit 0",
        ]
      : [...outbox, ...verdict, "exit 0"]),
    ``,
  ].join("\n");
}

/** A full-pipeline ssh harness (#689 fake-ssh double) whose forge and tracker RECORD the
 * outbox-publishing calls instead of hitting GitHub. `push`/`pr`/`comment` are called for
 * EVERY attempt (after the args were recorded), so a guard that throws still leaves a record.
 * @param {{push?: (a: any) => any, pr?: (a: any) => any, comment?: (ref: string, body: string) => any}} [o] */
function remotePublishHarness(o = {}) {
  const ssh = withFakeSsh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ssh-pub-"));
  const repoDir = path.join(dir, "repo");
  const workDir = path.join(dir, "work");
  fs.mkdirSync(workDir, { recursive: true });
  initGitRepo(repoDir);
  const agentScript = path.join(workDir, "agent.sh");
  const cfg = /** @type {any} */ ({
    pipeline: PIPELINE,
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
  /** @type {any[]} */
  const events = [];
  const pushedArgs = [];
  const prArgs = [];
  const comments = [];
  /** @type {Array<["adapter"|"forge", string|undefined]>} every runCredentials the hub mints for a run */
  const credCalls = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({
      platform: "GitHub",
      taskNoun: "issue",
      trigger: "@agent",
      commentHowTo: "comment",
      stageKeys: { source: "sourceLabel", success: "successLabel", failure: "failLabel", hold: "holdLabel", queue: "queueLabel" },
    }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    runCredentials: async (/** @type {any} */ o) => { credCalls.push(["adapter", o?.ref]); return { label: "adapter-cred" }; },
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push({ ref, stepId, ...verdict }),
    postComment: async (/** @type {string} */ ref, /** @type {string} */ body) => {
      comments.push([ref, body]);
      return o.comment?.(ref, body);
    },
  });
  const forge = /** @type {any} */ ({
    describe: () => ({ name: "github" }),
    runCredentials: async (/** @type {any} */ o) => { credCalls.push(["forge", o?.ref]); return { label: "forge-cred" }; },
    publishBranch: async (/** @type {any} */ a) => {
      pushedArgs.push(a);
      return o.push ? o.push(a) : { pushed: [] };
    },
    openPr: async (/** @type {any} */ a) => {
      prArgs.push(a);
      return o.pr ? o.pr(a) : { number: 31, created: true };
    },
  });
  const run = createDispatcher(cfg, adapter, undefined, store, (event, ref, step, extra) => events.push({ event, ref, step, ...extra }), forge);
  /** @param {string} stepId @param {string} scriptBody */
  const runStep = async (stepId, scriptBody) => {
    fs.writeFileSync(agentScript, scriptBody, { mode: 0o755 });
    const log = console.log;
    console.log = () => {};
    try {
      await run({ kind: "pipeline", ref: "55", stepId, dedupKey: `k:${stepId}`, harness: "worker" });
    } finally {
      console.log = log;
    }
  };
  return { ssh, store, advanced, events, pushedArgs, prArgs, comments, credCalls, runStep, dir };
}

test("finishStep: a remote (ssh) run's outbox is published — the branch is pushed, the draft PR opened, the comment posted — and the run advances", async () => {
  const h = remotePublishHarness({
    push: () => ({ pushed: ["origin/agent/55"] }),
    pr: () => ({ number: 31, created: true }),
  });
  try {
    await h.runStep("code", agentScript());
    assert.equal(h.pushedArgs.length, 1, "the branch was pushed");
    assert.equal(h.pushedArgs[0].branch, "agent/55");
    assert.deepEqual(h.prArgs, [{ branch: "agent/55", title: PR.title, body: PR.body }], "the outbox's PR was opened");
    assert.deepEqual(h.comments, [["55", COMMENT]], "the outbox comment was posted");
    assert.deepEqual(h.advanced.map((a) => a.outcome), ["advance"], "a clean publish leaves the verdict untouched");
    // No per-run credentials minted for a remote run — the worker holds no tracker/forge access (#826)
    assert.equal(h.credCalls.length, 0, `no adapter/forge runCredentials for a remote run: ${JSON.stringify(h.credCalls)}`);
    const codeLogs = fs.readdirSync(h.dir).filter((f) => /step-code-55\.log$/.test(f));
    assert.ok(codeLogs.length > 0, "the run's step log exists");
    assert.match(fs.readFileSync(path.join(h.dir, codeLogs[codeLogs.length - 1]), "utf8"), /no per-run credentials minted/);
  } finally {
    h.ssh.restore();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("finishStep: a remote run whose commits touch a workflow file HOLDS — that is the applied verdict, and nothing else publishes", async () => {
  const h = remotePublishHarness({
    push: () => ({ workflow: ".github/workflows/ci.yml" }),
    pr: () => {
      throw new Error("openPr must not run after a workflow hold");
    },
    comment: () => {
      throw new Error("postComment must not run after a workflow hold");
    },
  });
  try {
    await h.runStep("code", agentScript());
    assert.equal(h.advanced.length, 1);
    assert.equal(h.advanced[0].outcome, "hold", "the hold coming out of publishing IS the applied verdict");
    assert.match(/** @type {string} */ (h.advanced[0].reason), /\.github\/workflows\/ci\.yml/, "the reason names the path");
    assert.match(/** @type {string} */ (h.store.getHeld("55")?.reason), /\.github\/workflows\/ci\.yml/, "the held entry was recorded");
    assert.ok(h.events.some((e) => e.event === "blocked"), "a blocked event fired");
    assert.equal(h.prArgs.length, 0, "no PR after a workflow hold");
    assert.equal(h.comments.length, 0, "no comment after a workflow hold");
  } finally {
    h.ssh.restore();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("finishStep: a host run leaves the SAME outbox files, but nothing is published (the publisher is ssh-only)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-host-pub-"));
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `d="$(dirname "$AGENTHOOK_VERDICT_FILE")"`,
      `mkdir -p "$d/outbox"`,
      `printf '%s' ${JSON.stringify(JSON.stringify(PR))} > "$d/outbox/pr.json"`,
      `printf '%s' ${JSON.stringify(COMMENT)} > "$d/outbox/comment.md"`,
      `printf '%s' '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"`,
      "exit 0",
      ``,
    ].join("\n"),
    { mode: 0o755 },
  );
  const cfg = /** @type {any} */ ({
    pipeline: [
      { id: "code" },
      { id: "done", manual: true },
    ],
    claudeBin: bin,
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  const calls = { push: 0, pr: 0, comment: 0 };
  let hostCredCalls = 0;
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    runCredentials: async () => { hostCredCalls += 1; return { label: "host-cred" }; },
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push({ ref, stepId, ...verdict }),
    postComment: () => {
      calls.comment++;
      throw new Error("postComment must not run for a host run");
    },
  });
  const forge = /** @type {any} */ ({
    describe: () => ({ name: "github" }),
    publishBranch: () => {
      calls.push++;
      throw new Error("publishBranch must not run for a host run");
    },
    openPr: () => {
      calls.pr++;
      throw new Error("openPr must not run for a host run");
    },
  });
  const run = createDispatcher(cfg, adapter, undefined, store, () => {}, forge);
  try {
    const log = console.log;
    console.log = () => {};
    try {
      await run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code" });
    } finally {
      console.log = log;
    }
    assert.deepEqual(advanced.map((a) => a.outcome), ["advance"], "the run's own verdict applies unchanged");
    assert.deepEqual(calls, { push: 0, pr: 0, comment: 0 }, "nothing was published");
    assert.equal(hostCredCalls, 1, "a host run still mints its per-run credentials");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("finishStep: an outbox written BEFORE a verdict-repair turn survives the repair launch (resume keeps outbox/) and is still published", async () => {
  const h = remotePublishHarness({
    push: () => ({ pushed: ["origin/agent/55"] }),
    pr: () => ({ number: 31, created: true }),
  });
  const counter = path.join(h.dir, "turns");
  try {
    await h.runStep("code", agentScript(counter));
    assert.equal(fs.readFileSync(counter, "utf8").trim(), "2", "the original run + one repair turn");
    assert.deepEqual(h.events.find((e) => e.event === "verdict_repair"), { event: "verdict_repair", ref: "55", step: "code", result: "repaired", turns: 1 });
    assert.equal(h.pushedArgs.length, 1, "the branch was pushed once");
    assert.equal(h.pushedArgs[0].branch, "agent/55");
    assert.equal(h.prArgs.length, 1, "the outbox written in turn 1 survived turn 2's launcher");
    assert.deepEqual(h.prArgs[0], { branch: "agent/55", title: PR.title, body: PR.body });
    assert.deepEqual(h.comments, [["55", COMMENT]]);
    assert.deepEqual(h.advanced.map((a) => a.outcome), ["advance"]);
  } finally {
    h.ssh.restore();
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});
