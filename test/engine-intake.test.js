import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { intakeEvent, createPushSink } from "../src/engine.js";
import { createQueue } from "../src/queue.js";
import { createServe } from "../src/engine/boot.js";
import { createStore } from "../src/store.js";

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

// ── createPushSink: settle-safe in-process pushes (local tracker onJobs) ─────

test("createPushSink: a job pushed for X while X runs waits for that run (and its cleanup) to settle, then starts", async () => {
  /** @type {string[]} */
  const log = [];
  /** @type {Map<string, () => void>} */
  const releases = new Map();
  /** @type {(jobs: any[]) => void} */
  let sink = () => {};
  const run = async (j) => {
    log.push(`start ${j.ref}:${j.stepId}`);
    if (j.stepId === "triage") {
      sink([job(j.ref, "code")]); // advance() pushes mid-run, before dispatch's per-ref cleanup
      await new Promise((r) => releases.set(j.stepId, () => r(undefined)));
      log.push(`cleanup ${j.ref}:${j.stepId}`);
    }
    return { kind: j.kind, ref: j.ref, name: j.ref, url: "", code: 0 };
  };
  const queue = createQueue(4, run);
  /** @type {any[][]} */
  const intaken = [];
  sink = createPushSink({ hasRef: queue.hasRef, whenRefFree: queue.whenRefFree, intake: (jobs) => (intaken.push(jobs), jobs.forEach((j) => queue.enqueue(j))) });

  queue.enqueue(job("X", "triage"));
  await Promise.resolve();
  assert.deepEqual(log, ["start X:triage"]);
  assert.deepEqual(intaken, [], "parked: X's run has not settled");

  releases.get("triage")?.();
  await queue.onIdle();
  assert.deepEqual(log, ["start X:triage", "cleanup X:triage", "start X:code"]);
  assert.deepEqual(intaken.map((js) => js.map((j) => j.stepId)), [["code"]]);
});

test("createPushSink: a job for an idle ref goes straight to intake; another ref's run doesn't hold it", async () => {
  /** @type {(() => void)[]} */
  const releases = [];
  const run = (j) => new Promise((resolve) => releases.push(() => resolve({ kind: j.kind, ref: j.ref, name: j.ref, url: "", code: 0 })));
  const queue = createQueue(4, run);
  /** @type {any[]} */
  const intaken = [];
  const sink = createPushSink({ hasRef: queue.hasRef, whenRefFree: queue.whenRefFree, intake: (jobs) => intaken.push(...jobs) });
  queue.enqueue(job("A", "code"));
  sink([job("B", "triage")]);
  assert.deepEqual(intaken.map((j) => j.ref), ["B"]);
  releases.shift()?.();
  await queue.onIdle();
});

test("queue.hasRef / whenRefFree: track queued + active jobs per ref; removing waiting jobs frees it", async () => {
  /** @type {(() => void)[]} */
  const releases = [];
  const run = (j) => new Promise((resolve) => releases.push(() => resolve({ kind: j.kind, ref: j.ref, name: j.ref, url: "", code: 0 })));
  const queue = createQueue(1, run);
  let fired = 0;
  queue.whenRefFree("A", () => fired++);
  assert.equal(fired, 1, "free now → called synchronously");

  queue.enqueue(job("A", "triage")); // running
  queue.enqueue(job("B", "triage")); // waiting
  assert.equal(queue.hasRef("A"), true);
  assert.equal(queue.hasRef("B"), true);
  queue.whenRefFree("B", () => fired++);
  queue.remove("B");
  assert.equal(queue.hasRef("B"), false);
  assert.equal(fired, 2, "removing B's only waiting job wakes its waiter");

  queue.whenRefFree("A", () => fired++);
  assert.equal(fired, 2);
  releases.shift()?.();
  await queue.onIdle();
  assert.equal(queue.hasRef("A"), false);
  assert.equal(fired, 3);
});

// ── boot's restoreQueued (src/engine/boot.js): must tag the re-enqueued `enqueued` with
// the job's kind, or src/ui/rows.js buildRows can't tell a CI/merge re-enqueue apart from
// a real pipeline re-run (issue #577) ──

test("boot restoreQueued: a queued CI job re-enqueued at boot emits `enqueued` tagged with its kind", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-restore-queued-"));
  try {
    const cfg = /** @type {any} */ ({
      name: "p", stateKey: "p", provider: "local", stateDir: dir, dataDir: dir, logDir: path.join(dir, "logs"), port: 0,
      pipeline: [{ id: "code" }], publicUrlFile: path.join(dir, "public_url.txt"), pidFile: path.join(dir, "server.pid"), controlSock: path.join(dir, "c.sock"),
    });
    const store = createStore(dir);
    store.addQueued({ kind: "ci", ref: "T1", stepId: "", dedupKey: "ci:T1:1" });

    /** @type {any[]} */
    const emitted = [];
    const emit = (event, ref, step, extra) => emitted.push({ event, ref, step, ...extra });
    const heartbeat = { update: () => {} };
    const state = /** @type {any} */ ({ server: http.createServer(), control: null });
    const ingress = { describe: () => ({ name: "manual", ephemeral: false }), up: async () => ({ url: "https://x" }), down: async () => {} };
    const serve = createServe(/** @type {any} */ ({
      cfg, state, store, sandbox: null, emit, startedAt: new Date().toISOString(), reconcileOnBoot: false,
      adapter: { registerWebhook: async () => {}, unregisterWebhooks: async () => {}, advance: async () => {} },
      forge: null,
      ingress,
      heartbeat,
      queue: { enqueue: () => true },
      puller: { pull: async () => {} },
      quotaPacer: { reading: () => {} },
      restart: async () => ({}), decommission: async () => ({}), ops: {}, shutdown: () => {},
    }));
    try {
      await serve();
      const enqueued = emitted.find((e) => e.event === "enqueued" && e.ref === "T1");
      assert.ok(enqueued, "restoreQueued emitted an enqueued event for the restored job");
      assert.equal(enqueued.kind, "ci", "the restored job's kind must survive onto the emitted event");
    } finally {
      state.control?.close?.();
      state.server.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
