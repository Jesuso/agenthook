import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRestartRequester } from "../src/engine/controllers.js";
import { createQueue } from "../src/queue.js";

const info = (j) => ({ kind: j.kind, ref: j.ref, name: j.ref, url: "", code: 0 });
const job = (ref) => ({ kind: "pipeline", ref, stepId: "s", dedupKey: `${ref}:s` });

/** Requester over a real queue; `release()` settles the one running job. */
function harness({ draining = false, badConfig = false, configError = null, badMove = false, harnessesDown, validateSandbox } = {}) {
  /** @type {(() => void)[]} */
  const releases = [];
  const run = (j) => new Promise((resolve) => releases.push(() => resolve(info(j))));
  const queue = createQueue(1, run);
  const h = {
    queue,
    draining,
    pendingCalls: /** @type {any[]} */ ([]),
    fired: 0,
    firedMove: /** @type {any[]} */ ([]),
    validatedMoves: /** @type {string[]} */ ([]),
    release: () => releases.shift()?.(),
  };
  h.r = createRestartRequester({
    queue,
    isDraining: () => h.draining,
    validateConfig: () => {
      if (badConfig) throw new Error(configError ?? "bad config");
    },
    validateMove: (to) => {
      h.validatedMoves.push(to);
      if (badMove) throw new Error(`bad move ${to}`);
    },
    ...(validateSandbox && { validateSandbox }),
    ...(harnessesDown && { harnessesDown }),
    onPending: (s) => h.pendingCalls.push(s),
    fire: (moveTo) => {
      h.fired++;
      h.firedMove.push(moveTo);
    },
  });
  return h;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("restart: rejects any when other than 'idle', changing nothing", async () => {
  const h = harness();
  for (const args of [undefined, {}, { when: "now" }, { when: "IDLE" }]) {
    await assert.rejects(h.r.request(args));
  }
  assert.equal(h.r.isPending(), false);
  assert.deepEqual(h.pendingCalls, []);
});

test("restart: an invalid config on disk rejects, queue not paused", async () => {
  const h = harness({ badConfig: true });
  await assert.rejects(h.r.request({ when: "idle" }), /bad config/);
  assert.equal(h.r.isPending(), false);
  h.queue.enqueue(job("A"));
  assert.equal(h.queue.state().active, 1, "queue still pumps");
});

test("restart: a config-check failure rejects exposed, with the original reason and the stop/start escape", async () => {
  const h = harness({ badConfig: true, configError: 'config: harness "pi-local" agent "pi" is not a known agent (claude, cursor, hermes, opencode).' });
  await assert.rejects(
    h.r.request({ when: "idle" }),
    (e) => {
      assert.equal(e.expose, true, "exposed so the client sees the reason");
      assert.ok(e.message.includes('agent "pi" is not a known agent'), `original reason present: ${e.message}`);
      assert.ok(e.message.includes("agenthook stop && agenthook start"), `stop/start escape present: ${e.message}`);
      assert.ok(e.message.includes("running receiver"), `says the check ran in the running process: ${e.message}`);
      return true;
    },
  );
  assert.equal(h.r.isPending(), false);
  assert.equal(h.pendingCalls.length, 0, "onPending not called");
  assert.equal(h.fired, 0, "fire not called");
  h.queue.enqueue(job("A"));
  assert.equal(h.queue.state().active, 1, "queue not paused");
});

test("restart: a long config-check reason is bounded before the hint, so the hint survives", async () => {
  const h = harness({ badConfig: true, configError: `config: ${"x".repeat(1000)}` });
  await assert.rejects(h.r.request({ when: "idle" }), (e) => {
    assert.ok(e.message.endsWith("agenthook stop && agenthook start\`"), `hint intact: ${e.message.slice(-80)}`);
    assert.ok(e.message.length < 500, `bounded, got ${e.message.length}`);
    return true;
  });
});

test("restart: non-config refusals are exposed with their reason, without the stop/start hint", async () => {
  {
    const h = harness({ draining: true });
    await assert.rejects(h.r.request({ when: "idle" }), (e) => {
      assert.equal(e.expose, true);
      assert.match(e.message, /shutdown already in progress/);
      assert.ok(!e.message.includes("stop && agenthook start"));
      return true;
    });
    assert.equal(h.pendingCalls.length, 0);
  }
  {
    const h = harness();
    await assert.rejects(h.r.request({ when: "now" }), (e) => {
      assert.equal(e.expose, true);
      assert.match(e.message, /unsupported when/);
      assert.ok(!e.message.includes("stop && agenthook start"));
      return true;
    });
  }
  {
    const h = harness({ badMove: true });
    await assert.rejects(h.r.request({ when: "idle", moveTo: "taken" }), (e) => {
      assert.equal(e.expose, true);
      assert.match(e.message, /bad move taken/);
      assert.ok(!e.message.includes("stop && agenthook start"));
      return true;
    });
    assert.equal(h.r.isPending(), false);
  }
});

test("restart: rejected while a signal shutdown is draining", async () => {
  const h = harness({ draining: true });
  await assert.rejects(h.r.request({ when: "idle" }));
  assert.equal(h.r.isPending(), false);
});

test("restart: accepts immediately, pauses, fires only at 0 active; second call is alreadyPending", async () => {
  const h = harness();
  h.queue.enqueue(job("A")); // running
  const res = await h.r.request({ when: "idle" });
  assert.deepEqual(res, { accepted: true, active: 1, queued: 0 });
  assert.deepEqual(h.pendingCalls, [{ active: 1, queued: 0 }]);
  assert.equal(h.queue.enqueue(job("B")), true, "incoming jobs still enqueue");
  assert.deepEqual(h.queue.state(), { active: 1, queued: 1 }, "but don't start");
  assert.deepEqual(await h.r.request({ when: "idle" }), { accepted: true, alreadyPending: true, active: 1, queued: 1 });
  await tick();
  assert.equal(h.fired, 0, "not while an agent runs");
  h.release();
  await tick();
  await tick();
  assert.equal(h.fired, 1);
  assert.deepEqual(h.queue.state(), { active: 0, queued: 1 }, "B left queued for the successor");
  assert.equal(h.pendingCalls.length, 1);
});

test("restart: fires right away when nothing is running", async () => {
  const h = harness();
  await h.r.request({ when: "idle" });
  await tick();
  await tick();
  assert.equal(h.fired, 1);
});

test("restart: a signal shutdown before 0 active cancels the fire", async () => {
  const h = harness();
  h.queue.enqueue(job("A"));
  await h.r.request({ when: "idle" });
  h.draining = true; // SIGTERM arrived
  h.release();
  await tick();
  await tick();
  assert.equal(h.fired, 0);
});

test("restart moveTo: validated before pausing, then handed to fire", async () => {
  const h = harness();
  h.queue.enqueue(job("A"));
  const res = await h.r.request({ when: "idle", moveTo: "newkey" });
  assert.deepEqual(res, { accepted: true, active: 1, queued: 0 });
  assert.deepEqual(h.validatedMoves, ["newkey"]);
  assert.deepEqual(h.pendingCalls, [{ active: 1, queued: 0, moveTo: "newkey" }]);
  h.release();
  await tick();
  await tick();
  assert.deepEqual(h.firedMove, ["newkey"]);
});

test("restart moveTo: a bad target rejects, not pending, queue not paused", async () => {
  const h = harness({ badMove: true });
  await assert.rejects(h.r.request({ when: "idle", moveTo: "taken" }), /bad move taken/);
  assert.equal(h.r.isPending(), false);
  assert.deepEqual(h.pendingCalls, []);
  h.queue.enqueue(job("A"));
  assert.equal(h.queue.state().active, 1, "queue still pumps");
});

test("restart moveTo: a non-string rejects before anything", async () => {
  const h = harness();
  for (const moveTo of [5, null, {}, true]) await assert.rejects(h.r.request({ when: "idle", moveTo }), /moveTo must be a string/);
  assert.deepEqual(h.validatedMoves, []);
  assert.equal(h.r.isPending(), false);
});

test("restart moveTo: alreadyPending with a different moveTo rejects; same or none is alreadyPending", async () => {
  const h = harness();
  h.queue.enqueue(job("A"));
  await h.r.request({ when: "idle", moveTo: "one" });
  await assert.rejects(h.r.request({ when: "idle", moveTo: "two" }), /already pending/);
  assert.equal((await h.r.request({ when: "idle", moveTo: "one" })).alreadyPending, true);
  assert.equal((await h.r.request({ when: "idle" })).alreadyPending, true);
  assert.deepEqual(h.validatedMoves, ["one"]);
});

test("restart moveTo: a pending plain restart rejects a later move", async () => {
  const h = harness();
  h.queue.enqueue(job("A"));
  await h.r.request({ when: "idle" });
  await assert.rejects(h.r.request({ when: "idle", moveTo: "x" }), /without a move/);
  h.release();
  await tick();
  await tick();
  assert.deepEqual(h.firedMove, [undefined]);
});

test("restart: a down harness adds harnessesDown to the reply, on both the fresh and the alreadyPending reply", async () => {
  const down = [{ harness: "opus", until: "2026-01-01T00:00:00.000Z", reason: "3 timeouts" }];
  const h = harness({ harnessesDown: () => down });
  h.queue.enqueue(job("A"));
  const res = await h.r.request({ when: "idle" });
  assert.deepEqual(res, { accepted: true, active: 1, queued: 0, harnessesDown: down });
  const again = await h.r.request({ when: "idle" });
  assert.deepEqual(again, { accepted: true, alreadyPending: true, active: 1, queued: 0, harnessesDown: down });
});

test("restart: no down harness leaves the reply shape unchanged (no harnessesDown key)", async () => {
  const h = harness({ harnessesDown: () => [] });
  const res = await h.r.request({ when: "idle" });
  assert.deepEqual(res, { accepted: true, active: 0, queued: 0 });
  assert.equal("harnessesDown" in res, false);
});

test("restart: no harnessesDown dependency at all leaves the reply shape unchanged", async () => {
  const h = harness();
  const res = await h.r.request({ when: "idle" });
  assert.deepEqual(res, { accepted: true, active: 0, queued: 0 });
});

test("restart: a rejecting validateSandbox refuses, exposed, with the doctor --fix hint; nothing paused or fired", async () => {
  const h = harness({ validateSandbox: async () => { throw new Error("sandbox image agenthook-agent:0.17.0 not found — run `agenthook doctor --fix` or build it (docs/sandbox.md)"); } });
  await assert.rejects(h.r.request({ when: "idle" }), (e) => {
    assert.equal(e.expose, true);
    assert.match(e.message, /^restart: the respawn would not boot —/);
    assert.ok(e.message.includes("agenthook-agent:0.17.0 not found"), `names the image: ${e.message}`);
    assert.ok(e.message.includes("nothing was paused"));
    assert.ok(e.message.includes("agenthook doctor --fix"));
    return true;
  });
  assert.equal(h.r.isPending(), false);
  assert.equal(h.pendingCalls.length, 0, "onPending not called");
  assert.equal(h.fired, 0, "fire not called");
  h.queue.enqueue(job("A"));
  assert.equal(h.queue.state().active, 1, "queue not paused");
});

test("restart: a long validateSandbox reason is bounded before the hint, so the hint survives", async () => {
  const h = harness({ validateSandbox: async () => { throw new Error(`x`.repeat(1000)); } });
  await assert.rejects(h.r.request({ when: "idle" }), (e) => {
    assert.ok(e.message.endsWith("run `agenthook doctor --fix`, then restart again"), `hint intact: ${e.message.slice(-80)}`);
    assert.ok(e.message.length < 500, `bounded, got ${e.message.length}`);
    return true;
  });
});

test("restart: a resolving validateSandbox is accepted exactly as before", async () => {
  let called = 0;
  const h = harness({ validateSandbox: async () => { called++; } });
  h.queue.enqueue(job("A"));
  const res = await h.r.request({ when: "idle" });
  assert.deepEqual(res, { accepted: true, active: 1, queued: 0 });
  assert.equal(called, 1);
  assert.deepEqual(h.pendingCalls, [{ active: 1, queued: 0 }]);
  h.release();
  await tick();
  await tick();
  assert.equal(h.fired, 1);
});

test("restart: no validateSandbox dependency at all leaves behaviour unchanged", async () => {
  const h = harness();
  const res = await h.r.request({ when: "idle" });
  assert.deepEqual(res, { accepted: true, active: 0, queued: 0 });
  await tick();
  await tick();
  assert.equal(h.fired, 1);
});

test("restart: two overlapping requests racing a slow validateSandbox — exactly one accepted, the other alreadyPending; fire runs once", async () => {
  /** @type {(() => void)[]} */
  const gates = [];
  const h = harness({
    validateSandbox: () => new Promise((resolve) => gates.push(resolve)),
  });
  h.queue.enqueue(job("A"));
  const p1 = h.r.request({ when: "idle" });
  const p2 = h.r.request({ when: "idle" });
  assert.equal(gates.length, 2, "both calls reached the sandbox check before either resolved");
  assert.equal(h.r.isPending(), false, "pending is not set while the check is in flight");
  gates[0]();
  gates[1]();
  const [r1, r2] = await Promise.all([p1, p2]);
  const results = [r1, r2];
  const accepted = results.filter((r) => !r.alreadyPending);
  const already = results.filter((r) => r.alreadyPending);
  assert.equal(accepted.length, 1, "exactly one request wins");
  assert.equal(already.length, 1, "the other is alreadyPending");
  assert.equal(h.pendingCalls.length, 1, "onPending called once");
  h.release();
  await tick();
  await tick();
  assert.equal(h.fired, 1, "fire runs at most once");
});
