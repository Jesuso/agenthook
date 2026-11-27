import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// #828, queue-integrated: a worker that is unreachable during the pre-run sync (the real
// executor, the real dispatcher, the real queue) — a `first-free` routing list spills the
// requeued job to the next harness, a single-harness step waits in the queue (never fails)
// until the cooldown lets a probe through, and a trip never consumes an attempt even past
// the cap (owner option 3). A revert of the sync-unreachable → trip wiring turns the spill
// job into a plain failure (no requeue, no second start), so these would go red.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFailingSsh, withFlippingSsh, initGitRepo } from "./_ssh-helpers.js";
import { createStore } from "../src/store/index.js";
import { createDispatcher } from "../src/dispatch/index.js";
import { createQueue } from "../src/queue.js";

/** Wait (with a generous timeout) for `cond` — a hung run must fail the test, not stall the suite.
 * @param {() => boolean} cond @param {string} what */
async function until(cond, what) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 15000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The dispatcher as a queue's `run`: records the harness each start landed on, resolves with
 * the dispatcher's settle info (whose `health` is what the queue's breaker reads). */
function queueRun(dispatch, started) {
  return (/** @type {any} */ j) =>
    new Promise((resolve) => {
      started.push(`${j.ref}:${j.harness ?? "-"}`);
      dispatch(j).then(resolve);
    });
}

function baseCfg(dir, repoDir, over) {
  return /** @type {any} */ ({
    repoPath: repoDir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
    ...over,
  });
}

const adapter = /** @type {any} */ ({
  describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
  fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
  advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ v) => {
    adapter.advanced.push([ref, stepId, v.outcome, v.reason]);
  },
});
/** @type {any[]} */ adapter.advanced = [];

test("first-free spill: an unreachable worker at sync requeues (run_end requeued), the job then runs on the next harness and succeeds", async () => {
  adapter.advanced = [];
  const ssh = withFailingSsh("ssh: connect to host worker-x port 22: Connection refused");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-route-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-route-repo-"));
  initGitRepo(repoDir);
  /** @type {any[]} */ const events = [];
  const emit = (/** @type {string} */ event, _r, _s, /** @type {any} */ extra) => events.push({ event, ...extra });
  try {
    const opusAgent = path.join(dir, "opus-agent.sh");
    fs.writeFileSync(opusAgent, `#!/bin/sh\ncat > /dev/null\nmkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"\necho '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"\nexit 0\n`, { mode: 0o755 });
    const cfg = baseCfg(dir, repoDir, {
      harnesses: {
        "worker-x": { remote: { host: "worker-x", workDir: path.join(dir, "workx") } },
        opus: { bin: opusAgent },
      },
      pipeline: [{ id: "code", harness: ["worker-x", "opus"], routing: "first-free" }],
    });
    const store = createStore(dir);
    const dispatch = createDispatcher(cfg, adapter, undefined, store, emit);
    /** @type {string[]} */ const started = [];
    const q = createQueue(
      2,
      queueRun(dispatch, started),
      undefined,
      undefined,
      {},
      { steps: { code: { harnesses: ["worker-x", "opus"], routing: "first-free" } }, caps: { "worker-x": 1, opus: 2 }, cooldowns: { "worker-x": 10 } },
    );
    const log = console.log;
    const warn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      q.enqueue({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "42:code" });
      // The second start (on opus) settles the test: nothing runs after it.
      await until(() => started.length === 2 && adapter.advanced.length === 1, "the spill run on opus to complete");
      assert.deepEqual(started, ["42:worker-x", "42:opus"], "the worker ran first (first-free), the requeued job spilled to the next harness");
      const requeued = events.filter((e) => e.event === "run_end" && e.outcome === "requeued");
      assert.equal(requeued.length, 1, "exactly one run_end requeued — the unreachable sync");
      assert.equal(requeued[0].harness, "worker-x");
      assert.equal(requeued[0].reason, "worker unreachable: worker-x (connection refused)", "the trip reason is verbatim, not 'spawn failed: …'");
      const ws = q.harnessState()["worker-x"];
      assert.equal(ws.state, "down");
      assert.equal(ws.reason, "worker unreachable: worker-x (connection refused)", "the queue health reason is the same one the UI/status surface");
      assert.deepEqual(adapter.advanced, [["42", "code", "advance", "ok"]], "the spill run on the second harness completes normally");
      assert.equal(events.some((e) => e.event === "failed"), false, "no harness on the step is permanently failed");
    } finally {
      console.log = log;
      console.warn = warn;
      q.close();
    }
  } finally {
    ssh.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("single-harness wait: an unreachable worker keeps the job queued (no failure); after the cooldown the probe runs and the worker answers", async () => {
  adapter.advanced = [];
  const ssh = withFlippingSsh("ssh: connect to host worker-x port 22: Connection timed out");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-wait-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-wait-repo-"));
  initGitRepo(repoDir);
  let t = Date.parse("2026-11-08T12:00:00Z");
  /** @type {any[]} */ const events = [];
  const emit = (/** @type {string} */ event, _r, _s, /** @type {any} */ extra) => events.push({ event, ...extra });
  try {
    const agentScript = path.join(dir, "worker-agent.sh");
    fs.writeFileSync(agentScript, `#!/bin/sh\ncat > /dev/null\nmkdir -p "$(dirname "$AGENTHOOK_VERDICT_FILE")"\necho '{"outcome":"advance","reason":"ok"}' > "$AGENTHOOK_VERDICT_FILE"\nexit 0\n`, { mode: 0o755 });
    const cfg = baseCfg(dir, repoDir, {
      harnesses: { "worker-x": { remote: { host: "worker-x", workDir: path.join(dir, "work"), bin: agentScript } } },
      pipeline: [{ id: "code", harness: "worker-x" }],
    });
    const store = createStore(dir);
    const dispatch = createDispatcher(cfg, adapter, undefined, store, emit);
    /** @type {string[]} */ const started = [];
    const q = createQueue(
      2,
      queueRun(dispatch, started),
      undefined,
      undefined,
      {},
      { steps: { code: { harnesses: ["worker-x"] } }, caps: { "worker-x": 1 }, cooldowns: { "worker-x": 1 }, now: () => t },
    );
    const log = console.log;
    const warn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      q.enqueue({ kind: "pipeline", ref: "A", stepId: "code", dedupKey: "A:code" });
      await until(() => started.length === 1 && q.state().queued === 1, "the job to requeue while the harness is down");
      assert.deepEqual(started, ["A:worker-x"], "one attempt on the worker, nothing else");
      assert.equal(q.state().queued, 1, "the job waits in the queue while the harness is down");
      assert.equal(q.harnessState()["worker-x"].state, "down");
      assert.equal(adapter.advanced.length, 0, "no verdict yet — the ticket is not failed or moved");
      assert.equal(events.some((e) => e.event === "failed"), false);

      // The cooldown passes, the worker answers again — a pump (enqueuing B) lets the probe through.
      t += 60000;
      ssh.flip();
      q.enqueue({ kind: "pipeline", ref: "B", stepId: "code", dedupKey: "B:code" });
      await until(() => started.length === 3 && adapter.advanced.length === 2, "the probe and the run behind it to complete");
      assert.deepEqual(started, ["A:worker-x", "A:worker-x", "B:worker-x"], "the requeued job probes first, then the job behind it");
      assert.equal(q.harnessState()["worker-x"].state, "up", "a healthy probe brings the harness back");
      assert.deepEqual(adapter.advanced, [["A", "code", "advance", "ok"], ["B", "code", "advance", "ok"]], "both runs complete normally");
      assert.equal(q.state().queued, 0);
    } finally {
      console.log = log;
      console.warn = warn;
      q.close();
    }
  } finally {
    ssh.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("dispatcher: an unreachable worker trips the breaker — run_end requeued, the ticket is not moved, and the attempt count is restored even past the cap (a trip never counts, #828 option 3)", async () => {
  adapter.advanced = [];
  const ssh = withFailingSsh("ssh: connect to host worker-x port 22: Connection refused");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-route-"));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-828-route-repo-"));
  initGitRepo(repoDir);
  try {
    const cfg = baseCfg(dir, repoDir, {
      harnesses: { "worker-x": { remote: { host: "worker-x", workDir: path.join(dir, "work") } } },
      pipeline: [{ id: "code", harness: "worker-x", maxAttempts: 2 }],
    });
    const store = createStore(dir);
    store.bumpAttempt("42", "code");
    store.bumpAttempt("42", "code");
    store.bumpAttempt("42", "code"); // already 3 — past maxAttempts 2; a trip must still requeue
    /** @type {any[]} */ const events = [];
    const emit = (/** @type {string} */ event, _r, _s, /** @type {any} */ extra) => events.push({ event, ...extra });
    const dispatch = createDispatcher(cfg, adapter, undefined, store, emit);
    const log = console.log;
    console.log = () => {};
    let info;
    try {
      info = await dispatch({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k:code", harness: "worker-x" });
    } finally {
      console.log = log;
    }
    info = /** @type {any} */ (info);
    assert.deepEqual(adapter.advanced, [], "a worker-unreachable trip must not move the ticket");
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
