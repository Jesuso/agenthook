import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { intakeEvent } from "../src/engine.js";
import { createQueue } from "../src/queue.js";

const job = (ref, stepId = "s") => ({ kind: "pipeline", ref, stepId, dedupKey: `${ref}:${stepId}` });

test("intakeEvent: accepted -> enqueued; refused duplicate -> coalesced; refused draining -> none", () => {
  assert.equal(intakeEvent(true, false), "enqueued");
  assert.equal(intakeEvent(true, true), "enqueued");
  assert.equal(intakeEvent(false, true), "coalesced");
  assert.equal(intakeEvent(false, false), null);
});

test("intakeEvent matches a real queue: two intakes of the same ref+step while the first is queued/running produce one enqueued, one coalesced", async () => {
  /** @type {(() => void)[]} */
  const releases = [];
  const run = (j) => new Promise((resolve) => releases.push(() => resolve({ kind: j.kind, ref: j.ref, name: j.ref, url: "", code: 0 })));
  const queue = createQueue(1, run);
  const events = [];

  const intake = (j) => {
    const wasInflight = queue.has(j) && !queue.isClosed();
    const ok = queue.enqueue(j);
    const ev = intakeEvent(ok, wasInflight);
    if (ev) events.push(ev);
    return ok;
  };

  const a1 = job("A", "code");
  const a2 = job("A", "code"); // different webhook delivery, same ref+step
  assert.equal(intake(a1), true);
  assert.equal(intake(a2), false, "coalesced");
  assert.deepEqual(events, ["enqueued", "coalesced"]);

  queue.close();
  assert.equal(intake(job("B", "code")), false, "draining refusal");
  assert.deepEqual(events, ["enqueued", "coalesced"], "draining refusal emits nothing");

  releases.shift()?.();
  await queue.onIdle();
});

test("intakeEvent: a duplicate refused while draining emits nothing even for a ref already in flight", async () => {
  const releases = [];
  const run = (j) => new Promise((resolve) => releases.push(() => resolve({ kind: j.kind, ref: j.ref, name: j.ref, url: "", code: 0 })));
  const queue = createQueue(2, run);
  const events = [];

  const intake = (j) => {
    const wasInflight = queue.has(j) && !queue.isClosed();
    const ok = queue.enqueue(j);
    const ev = intakeEvent(ok, wasInflight);
    if (ev) events.push(ev);
    return ok;
  };

  const a1 = job("A", "code");
  assert.equal(intake(a1), true); // A now running
  queue.close();
  assert.equal(intake(job("A", "code")), false, "refused: A already inflight AND draining");
  assert.deepEqual(events, ["enqueued"], "draining refusal emits nothing, even though A is inflight");

  releases.shift()?.();
  await queue.onIdle();
});
