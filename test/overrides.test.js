import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { createQueue } from "../src/queue.js";
import { createOps } from "../src/ops.js";
import { createQuotaPacer } from "../src/quota.js";
import { seedOverrides, overrideEntries, fileOverrideEntries } from "../src/overrides.js";
import { digest } from "../src/commands/tick.js";
import { harnessSlotLints } from "../src/commands/doctor.js";
import { HELP, suggestCommand } from "../bin/agenthook.js";

/** Build a store + queue + heartbeat over a temp dir, with optional persisted overrides. */
function setup({ harnesses, maxConcurrent = 1, stepHarnesses, overrides } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-ovr-"));
  /** @type {any} */
  const cfg = {
    name: "t", stateDir: dir, dataDir: dir, maxConcurrent, harnesses,
    pipeline: [{ id: "code", ...(stepHarnesses ? { harness: stepHarnesses } : {}) }],
  };
  const store = createStore(dir);
  if (overrides) store.setOverrides(overrides);
  /** @type {any[]} */ const beats = [];
  const heartbeat = { update: (p) => beats.push(p) };
  /** @type {any[]} */ const started = [];
  const queue = createQueue(
    maxConcurrent,
    async (job) => { started.push(job); return new Promise(() => {}); },
    undefined,
    undefined,
    {},
    harnesses
      ? { steps: { code: { harnesses: stepHarnesses ?? Object.keys(harnesses) } }, caps: Object.fromEntries(Object.entries(harnesses).map(([n, h]) => [n, h.maxConcurrent])) }
      : undefined,
  );
  return { dir, cfg, store, queue, beats, heartbeat, started };
}

/** @param {any} job */
const job = (job) => ({ kind: "pipeline", dedupKey: `${job.ref}:${job.stepId}`, ...job });

// --- store ---

test("getOverrides returns {} when missing or corrupt; setOverrides deletes the file when empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-ovr-"));
  const store = createStore(dir);
  const file = path.join(dir, "overrides.json");
  assert.deepEqual(store.getOverrides(), {});
  fs.writeFileSync(file, "not json");
  assert.deepEqual(store.getOverrides(), {}, "corrupt file reads as {}");
  fs.writeFileSync(file, "[1,2]");
  assert.deepEqual(store.getOverrides(), {}, "an array is not an override object");
  store.setOverrides({ paused: true, maxConcurrent: 4 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { paused: true, maxConcurrent: 4 });
  store.setOverrides({});
  assert.equal(fs.existsSync(file), false, "no entries → the file is deleted");
});

// --- seeding ---

test("a per-harness drain override is applied at boot and a restored job does not start", () => {
  const s = setup({ harnesses: { a: { maxConcurrent: 1 } }, stepHarnesses: ["a"], overrides: { harnesses: { a: 0 } } });
  seedOverrides({ cfg: s.cfg, store: s.store, queue: s.queue, quotaPacer: { operatorPause() {} }, heartbeat: s.heartbeat });
  assert.deepEqual(s.queue.harnessState().a, { active: 0, max: 0, state: "up" });
  s.queue.enqueue(job({ ref: "R", stepId: "code" }));
  assert.equal(s.started.length, 0, "the harness is drained: nothing starts");
  assert.equal(s.queue.state().queued, 1);
});

test("a global pause override is restored: queue paused, heartbeat flags, restored job waits", () => {
  const s = setup({ overrides: { paused: true } });
  let operatorPaused = false;
  seedOverrides({ cfg: s.cfg, store: s.store, queue: s.queue, quotaPacer: { operatorPause: () => { operatorPaused = true; } }, heartbeat: s.heartbeat });
  assert.equal(s.queue.isPaused(), true);
  assert.equal(operatorPaused, true, "the quota pacer is told about the restored pause");
  assert.ok(s.beats.some((b) => b.paused === true));
  assert.deepEqual(s.beats.at(-1), { overrides: { paused: true } });
  s.queue.enqueue(job({ ref: "R", stepId: "code" }));
  assert.equal(s.started.length, 0, "nothing starts while paused");
});

test("an unknown-harness override is dropped at boot with a log line and the file rewritten", () => {
  const s = setup({ harnesses: { a: { maxConcurrent: 2 } }, overrides: { harnesses: { a: 2, gone: 0 } } });
  const warns = [];
  const logs = [];
  const w = console.warn; const l = console.log;
  console.warn = (/** @type {string} */ x) => warns.push(x);
  console.log = (/** @type {string} */ x) => logs.push(x);
  try {
    seedOverrides({ cfg: s.cfg, store: s.store, queue: s.queue, quotaPacer: { operatorPause() {} }, heartbeat: s.heartbeat });
  } finally {
    console.warn = w; console.log = l;
  }
  assert.deepEqual(warns, [`[overrides] dropped override for harness "gone": not in the config`]);
  assert.deepEqual(s.store.getOverrides(), { harnesses: { a: 2 } }, "the file is rewritten without the dropped entry");
  assert.deepEqual(s.queue.harnessState().a, { active: 0, max: 2, state: "up" });
  assert.match(logs.join("\n"), /\[overrides\] restored harness a = 2/);
});

// --- ops persistence ---

/** Build ops over a temp store/queue. */
function opsSetup({ harnesses, maxConcurrent = 1, stepHarnesses, overrides, locked = false, pacer } = {}) {
  const s = setup({ harnesses, maxConcurrent, stepHarnesses, overrides });
  const ops = createOps({
    cfg: s.cfg, store: s.store, forge: null, queue: s.queue,
    cancelRun: () => false, intake: () => 0, emit: () => {},
    heartbeat: s.heartbeat, pull: async () => {}, isLocked: () => locked, adapter: {},
    ...(pacer ? { pacer } : {}),
  });
  return { ...s, ops };
}

test("pause writes overrides.json and resume clears it (global)", async () => {
  const s = opsSetup();
  await s.ops.pause({});
  assert.deepEqual(s.store.getOverrides(), { paused: true });
  assert.ok(fs.existsSync(path.join(s.dir, "overrides.json")));
  const r = await s.ops.resume({});
  assert.equal(r.paused, false);
  assert.deepEqual(s.store.getOverrides(), {}, "resume clears the persisted pause");
  assert.equal(fs.existsSync(path.join(s.dir, "overrides.json")), false);
});

test("set_concurrency persists and reset removes its entry; exactly one of max/reset", async () => {
  const s = opsSetup({ harnesses: { a: { maxConcurrent: 2 } }, maxConcurrent: 1 });
  await s.ops.set_concurrency({ max: 5 });
  assert.equal(s.queue.max(), 5);
  assert.deepEqual(s.store.getOverrides(), { maxConcurrent: 5 });
  await s.ops.set_concurrency({ reset: true });
  assert.equal(s.queue.max(), 1, "back to the config value");
  assert.deepEqual(s.store.getOverrides(), {});

  await s.ops.set_concurrency({ max: 0, harness: "a" });
  assert.deepEqual(s.store.getOverrides(), { harnesses: { a: 0 } });
  assert.deepEqual(s.queue.harnessState().a, { active: 0, max: 0, state: "up" });
  await s.ops.set_concurrency({ reset: true, harness: "a" });
  assert.deepEqual(s.store.getOverrides(), {}, "the harness entry is removed");
  assert.deepEqual(s.queue.harnessState().a, { active: 0, max: 2, state: "up" }, "back to the config value");

  await assert.rejects(() => s.ops.set_concurrency({ max: 3, reset: true }), /exactly one/);
  await assert.rejects(() => s.ops.set_concurrency({}), /exactly one/);
});

test("setting a value equal to the config value removes the entry", async () => {
  const s = opsSetup({ harnesses: { a: { maxConcurrent: 2 } }, maxConcurrent: 1 });
  await s.ops.set_concurrency({ max: 5 });
  await s.ops.set_concurrency({ max: 1 }); // == cfg.maxConcurrent
  assert.deepEqual(s.store.getOverrides(), {}, "global entry removed");

  await s.ops.set_concurrency({ max: 0, harness: "a" });
  await s.ops.set_concurrency({ max: 2, harness: "a" }); // == cfg harness maxConcurrent
  assert.deepEqual(s.store.getOverrides(), {}, "harness entry removed");
});

test("resume while a restart holds the queue leaves the persisted pause in force", async () => {
  const s = opsSetup({ locked: true });
  await s.ops.pause({});
  assert.deepEqual(s.store.getOverrides(), { paused: true });
  const r = await s.ops.resume({});
  assert.equal(r.paused, true);
  assert.match(r.note, /restart/);
  assert.deepEqual(s.store.getOverrides(), { paused: true }, "the pause is still persisted");
});

// --- quota interplay ---

test("a quota release does not resume a restored operator pause", () => {
  const s = setup({ overrides: { paused: true } });
  const pacer = createQuotaPacer({
    thresholds: { pauseAboveSevenDay: 0.9 },
    pauseQueue: () => s.queue.pause(),
    resumeQueue: () => s.queue.resume(),
  });
  seedOverrides({ cfg: s.cfg, store: s.store, queue: s.queue, quotaPacer: pacer, heartbeat: s.heartbeat });
  assert.equal(s.queue.isPaused(), true);
  const future = "2099-01-01T00:00:00.000Z";
  pacer.reading({ sevenDay: { utilization: 0.99, resetsAt: future } }); // trips → pauseQueue
  pacer.reading({ sevenDay: { utilization: 0.1, resetsAt: future } }); // below → would resume
  assert.equal(s.queue.isPaused(), true, "the quota release must not undo the restored pause");
});

// --- visibility ---

test("overrideEntries renders each override next to its config value", () => {
  assert.deepEqual(overrideEntries({ paused: true, maxConcurrent: { value: 4, config: 1 }, harnesses: { "oc-local": { value: 0, config: 1 }, "cloud": { value: 3, config: null } } }), [
    "paused (override; unpause to clear)",
    "maxConcurrent: 4 (override; config 1)",
    "oc-local: 0 slots (override; config 1)",
    "cloud: 3 slots (override; config unbounded)",
  ]);
  assert.deepEqual(overrideEntries(null), []);
  assert.deepEqual(fileOverrideEntries({ paused: true, maxConcurrent: 4, harnesses: { "oc-local": 0 } }), ["paused", "maxConcurrent: 4", "oc-local: 0 slots"]);
});

test("tick digest prints an override line per entry", () => {
  const out = digest({
    profile: "p", up: true, paused: false, restartPending: false,
    slots: { active: 0, max: 1, queued: 0, free: 1, harnesses: { "oc-local": { active: 0, max: 0, state: "up" } } },
    overrides: { harnesses: { "oc-local": { value: 0, config: 1 } } },
    running: [], queue: [], held: [], board: undefined, prs: undefined, epics: undefined, events: [], cursor: 0,
  });
  assert.ok(out.includes("override oc-local: 0 slots (override; config 1)"), out);
});

test("doctor harnessSlotLints shows the override wording and flags unknown entries", () => {
  const cfg = { maxConcurrent: 3, harnesses: { "oc-local": { maxConcurrent: 1 } }, pipeline: [{ id: "code", harness: ["oc-local"] }] };
  const lints = harnessSlotLints(cfg, { paused: true, maxConcurrent: 5, harnesses: { "oc-local": 0, gone: 1 } });
  assert.ok(lints.some((l) => l.label === `harness "oc-local"` && l.note === "0 slots (override; config 1)"), JSON.stringify(lints));
  assert.ok(lints.some((l) => l.label === "operator pause" && l.note === "paused (override; unpause to clear)"));
  assert.ok(lints.some((l) => l.label === "global maxConcurrent" && l.note === "5 (override; config 3)"));
  assert.ok(lints.some((l) => l.label === `override for harness "gone"` && /dropped on boot/.test(l.note)));
});

// --- CLI ---

test("pause / unpause / concurrency are registered in HELP and resolvable", () => {
  assert.match(HELP, /pause \[--harness <name>\]/);
  assert.match(HELP, /unpause \[--harness <name>\]/);
  assert.match(HELP, /concurrency <n\|reset> \[--harness <name>\]/);
  assert.equal(suggestCommand("paus"), "pause");
  assert.equal(suggestCommand("unpuse"), "unpause");
  assert.equal(suggestCommand("concurrenc"), "concurrency");
});
