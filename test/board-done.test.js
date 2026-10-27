import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `board_done` (via "flag"): a tracker's done-flag job is a signal — the request handler hands
// it to src/board-done.js (dedup on `seen`, one emit), never to intake/the run queue.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createBoardDone } from "../src/board-done.js";
import { createRequestHandler } from "../src/engine/http.js";
import { createStore } from "../src/store.js";

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
