import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `board_done` (via "flag"): a tracker's done-flag job is a signal — the request handler hands
// it to src/board-done.js (dedup on `seen`, one emit), never to intake/the run queue.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { clearHoldOnDone, createBoardDone } from "../src/board-done.js";
import { createRequestHandler } from "../src/engine/http.js";
import { createStore } from "../src/store.js";
import { createQueue } from "../src/queue.js";

const job = { kind: /** @type {const} */ ("board_done"), ref: "36", stepId: "", dedupKey: "done:d-1" };

test("createBoardDone: one board_done (via flag) per dedupKey, persisted in seen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-board-done-"));
  const store = createStore(dir);
  /** @type {any[]} */ const events = [];
  const boardDone = createBoardDone({ store, emit: (e, ref, step, x) => events.push([e, ref, step, x]) });
  assert.equal(boardDone(job), true);
  assert.equal(boardDone({ ...job }), false, "a redelivery with the same dedupKey emits nothing");
  assert.equal(createBoardDone({ store: createStore(dir), emit: (e) => events.push([e]) })(job), false, "dedup survives a fresh store (disk is the source of truth)");
  assert.deepEqual(events, [["board_done", "36", "", { via: "flag" }]]);
});

test("request handler: a board_done job is emitted once, never reaches intake, the queue stays empty", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-board-done-"));
  const store = createStore(dir);
  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const intaken = [];
  const pipelineJob = { kind: /** @type {const} */ ("pipeline"), ref: "37", stepId: "code", dedupKey: "unblock:36:37" };
  let settled = () => {};
  const adapter = /** @type {any} */ ({
    authenticate: () => ({ type: "accept" }),
    processEvents: async () => [job, pipelineJob],
  });
  const boardDone = createBoardDone({ store, emit: (e, ref, step, x) => events.push([e, ref, step, x]) });
  const handler = createRequestHandler({
    adapter,
    forge: null,
    intake: (jobs) => {
      intaken.push(...jobs);
      settled();
    },
    ciGreen: () => assert.fail("not a ci_green"),
    epicChanged: () => assert.fail("not an epic_changed"),
    boardDone,
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  try {
    for (let i = 0; i < 2; i++) {
      const done = new Promise((r) => (settled = () => r(undefined)));
      const res = await fetch(`http://127.0.0.1:${port}/github/`, { method: "POST", body: "{}" });
      assert.equal(res.status, 200);
      await done;
    }
  } finally {
    server.close();
  }
  assert.deepEqual(events, [["board_done", "36", "", { via: "flag" }]], "two deliveries, one event");
  assert.deepEqual(intaken, [pipelineJob, pipelineJob], "only the pipeline job reaches intake");
  assert.equal(store.listQueued().length, 0);
});

/** A store + a real run queue whose one slot is taken by another ref's run, so later jobs wait. */
function heldSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-board-done-held-"));
  const store = createStore(dir);
  const queue = createQueue(1, () => new Promise(() => {}), () => {}, { onAdd: (j) => store.addQueued(j), onRemove: (j) => store.removeQueued(j) });
  queue.enqueue({ kind: "pipeline", ref: "busy", stepId: "code", dedupKey: "step:busy:code" });
  /** @type {any[]} */ const events = [];
  const emit = (/** @type {string} */ e, /** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ x) => void events.push([e, ref, step, x]);
  return { store, queue, events, emit };
}

test("board_done webhook on a HELD ref: hold dropped, its waiting resume dequeued (merge job kept), hold_cleared, no tracker write", async () => {
  const { store, queue, events, emit } = heldSetup();
  store.setHeld("36", { stepId: "code", reason: "which option?", heldAt: "2026-11-01T00:00:00Z" });
  const resume = { kind: /** @type {const} */ ("pipeline"), ref: "36", stepId: "code", dedupKey: "step:36:code" };
  const merge = { kind: /** @type {const} */ ("merge"), ref: "36", stepId: "done", dedupKey: "merged:9" };
  queue.enqueue(resume);
  queue.enqueue(merge);
  store.markSeen(resume.dedupKey);
  // The tracker adapter: any write (a section move, a completion) fails the test.
  const adapter = /** @type {any} */ ({
    authenticate: () => ({ type: "accept" }),
    processEvents: async () => [job],
    advance: async () => assert.fail("no tracker move"),
    enterStage: async () => assert.fail("no tracker move"),
    complete: async () => assert.fail("no tracker write"),
  });
  let settled = () => {};
  const handler = createRequestHandler({
    adapter,
    forge: null,
    intake: () => settled(),
    ciGreen: () => {},
    epicChanged: () => {},
    boardDone: createBoardDone({ store, emit, queue }),
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  try {
    const done = new Promise((r) => (settled = () => r(undefined)));
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{}" })).status, 200);
    await done;
  } finally {
    server.close();
  }
  assert.equal(store.getHeld("36"), undefined, "no longer held");
  assert.deepEqual(store.listQueued().map((j) => `${j.kind}:${j.ref}`), ["merge:36"], "the resume is gone, the merge job stays");
  store.reloadSeen();
  assert.equal(store.hasSeen(resume.dedupKey), false, "a later re-entry of that stage still fires");
  assert.deepEqual(events, [
    ["board_done", "36", "", { via: "flag" }],
    ["hold_cleared", "36", "code", { via: "board_done", dequeued: ["code"] }],
  ]);
});

test("board_done on a ref that is NOT held: nothing but board_done — its queued job and other holds stay", () => {
  const { store, queue, events, emit } = heldSetup();
  store.setHeld("other", { stepId: "code", heldAt: "2026-11-01T00:00:00Z" });
  queue.enqueue({ kind: "pipeline", ref: "36", stepId: "code", dedupKey: "step:36:code" });
  assert.equal(createBoardDone({ store, emit, queue })(job), true);
  assert.deepEqual(events, [["board_done", "36", "", { via: "flag" }]]);
  assert.deepEqual(store.listQueued().map((j) => j.ref), ["36"]);
  assert.equal(store.getHeld("other")?.stepId, "code");
});

test("clearHoldOnDone: a held ref with nothing queued (and no queue passed) → hold dropped, no dequeued field; a repeat is a no-op", () => {
  const { store, events, emit } = heldSetup();
  store.setHeld("36", { stepId: "review", heldAt: "2026-11-01T00:00:00Z" });
  assert.equal(clearHoldOnDone({ store, emit }, "36"), true);
  assert.equal(clearHoldOnDone({ store, emit }, "36"), false);
  assert.deepEqual(events, [["hold_cleared", "36", "review", { via: "board_done" }]]);
});
