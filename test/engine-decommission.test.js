import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecommissionRequester, createRestartRequester, finishTeardown, runDecommission, unregisterAll, waitForExit } from "../src/engine.js";
import { archiveStateDir } from "../src/archive.js";
import { createQueue } from "../src/queue.js";

const info = (j) => ({ kind: j.kind, ref: j.ref, name: j.ref, url: "", code: 0 });
const job = (ref) => ({ kind: "pipeline", ref, stepId: "s", dedupKey: `${ref}:s` });
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Decommission + restart requesters over one real queue, wired to each other like the engine. */
function harness() {
  /** @type {(() => void)[]} */
  const releases = [];
  const run = (j) => new Promise((resolve) => releases.push(() => resolve(info(j))));
  const queue = createQueue(1, run);
  const h = {
    queue,
    draining: false,
    pendingCalls: /** @type {any[]} */ ([]),
    fired: /** @type {any[]} */ ([]),
    restartFired: 0,
    release: () => releases.shift()?.(),
  };
  h.d = createDecommissionRequester({
    queue,
    isDraining: () => h.draining,
    isRestartPending: () => h.r.isPending(),
    onPending: (s) => h.pendingCalls.push(s),
    fire: (opts) => void h.fired.push(opts),
  });
  h.r = createRestartRequester({
    queue,
    isDraining: () => h.draining,
    validateConfig: () => {},
    isDecommissionPending: () => h.d.isPending(),
    onPending: () => {},
    fire: () => void h.restartFired++,
  });
  return h;
}

test("decommission: rejects any when other than 'idle', changing nothing", async () => {
  const h = harness();
  for (const args of [undefined, {}, { when: "now" }, { when: "IDLE" }]) {
    await assert.rejects(h.d.request(args), /unsupported when/);
  }
  assert.equal(h.d.isPending(), false);
  assert.deepEqual(h.pendingCalls, []);
});

test("decommission: a non-boolean unregister rejects before anything", async () => {
  const h = harness();
  for (const unregister of [1, "yes", null, {}]) {
    await assert.rejects(h.d.request({ when: "idle", unregister }), /unregister must be a boolean/);
  }
  assert.equal(h.d.isPending(), false);
  h.queue.enqueue(job("A"));
  assert.equal(h.queue.state().active, 1, "queue not paused");
});

test("decommission: accepts immediately, pauses, fires only at 0 active (unregister defaults true); second call is alreadyPending", async () => {
  const h = harness();
  h.queue.enqueue(job("A")); // running
  assert.deepEqual(await h.d.request({ when: "idle" }), { accepted: true, active: 1, queued: 0 });
  assert.deepEqual(h.pendingCalls, [{ active: 1, queued: 0, unregister: true }]);
  assert.equal(h.queue.enqueue(job("B")), true, "incoming jobs still enqueue");
  assert.deepEqual(h.queue.state(), { active: 1, queued: 1 }, "but don't start");
  assert.deepEqual(await h.d.request({ when: "idle", unregister: false }), { accepted: true, alreadyPending: true, active: 1, queued: 1 });
  await tick();
  assert.deepEqual(h.fired, [], "not while an agent runs");
  h.release();
  await tick();
  await tick();
  assert.deepEqual(h.fired, [{ unregister: true }]);
  assert.deepEqual(h.queue.state(), { active: 0, queued: 1 }, "B stays queued (archived queue.json)");
  assert.equal(h.pendingCalls.length, 1);
});

test("decommission: unregister:false is handed to fire", async () => {
  const h = harness();
  await h.d.request({ when: "idle", unregister: false });
  await tick();
  await tick();
  assert.deepEqual(h.fired, [{ unregister: false }]);
});

test("decommission: rejected while a signal shutdown is draining", async () => {
  const h = harness();
  h.draining = true;
  await assert.rejects(h.d.request({ when: "idle" }), /shutdown already in progress/);
  assert.equal(h.d.isPending(), false);
});

test("decommission: a signal shutdown before 0 active cancels the fire", async () => {
  const h = harness();
  h.queue.enqueue(job("A"));
  await h.d.request({ when: "idle" });
  h.draining = true; // SIGTERM arrived
  h.release();
  await tick();
  await tick();
  assert.deepEqual(h.fired, []);
});

test("decommission and restart exclude each other while pending", async () => {
  const a = harness();
  a.queue.enqueue(job("A"));
  await a.r.request({ when: "idle" });
  await assert.rejects(a.d.request({ when: "idle" }), /a restart is pending/);
  assert.equal(a.d.isPending(), false);

  const b = harness();
  b.queue.enqueue(job("A"));
  await b.d.request({ when: "idle" });
  await assert.rejects(b.r.request({ when: "idle" }), /a decommission is pending/);
  assert.equal(b.r.isPending(), false);
  b.release();
  await tick();
  await tick();
  assert.equal(b.restartFired, 0);
  assert.equal(b.fired.length, 1);
});

test("unregisterAll: both ok; forge null → 'none'", async () => {
  const ok = { unregisterWebhooks: async () => {} };
  assert.deepEqual(await unregisterAll(ok, ok), { tracker: "ok", forge: "ok" });
  assert.deepEqual(await unregisterAll(ok, null), { tracker: "ok", forge: "none" });
});

test("unregisterAll: a rejection marks that side 'failed' and never throws", async () => {
  const ok = { unregisterWebhooks: async () => {} };
  const bad = (/** @type {string} */ m) => ({
    unregisterWebhooks: async () => {
      throw new Error(m);
    },
  });
  assert.deepEqual(await unregisterAll(bad("t down"), ok), { tracker: "failed", forge: "ok", errors: { tracker: "t down" } });
  assert.deepEqual(await unregisterAll(ok, bad("f down")), { tracker: "ok", forge: "failed", errors: { forge: "f down" } });
  assert.deepEqual(await unregisterAll(bad("a"), bad("b")), { tracker: "failed", forge: "failed", errors: { tracker: "a", forge: "b" } });
});

test("waitForExit(keepQueued): a paused queue with queued jobs resolves at 0 active, not onIdle", async () => {
  /** @type {(() => void)[]} */
  const releases = [];
  const queue = createQueue(1, (j) => new Promise((resolve) => releases.push(() => resolve(info(j)))));
  queue.enqueue(job("A"));
  queue.pause();
  queue.enqueue(job("B"));
  let kept = false;
  let drained = false;
  waitForExit(queue, true).then(() => (kept = true));
  waitForExit(queue, false).then(() => (drained = true));
  await tick();
  assert.equal(kept, false, "agent A still running");
  releases.shift()?.();
  await tick();
  await tick();
  assert.equal(kept, true, "resolved once A finished");
  assert.equal(drained, false, "onIdle would hang on the paused queue");
  assert.deepEqual(queue.state(), { active: 0, queued: 1 });
});

/** A cfg-shaped object over a temp registry with a state dir `key`. */
function cfgIn(key) {
  const registry = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ah-decom-")), "reg");
  const stateDir = path.join(registry, key);
  fs.mkdirSync(stateDir, { recursive: true });
  return { registry, cfg: { configPath: "/nope.json", stateKey: key, stateDir, name: key, installDir: "/i", pidFile: path.join(stateDir, "server.pid") } };
}

/** Capture console.log/error lines while `fn` runs. @param {() => void} fn */
function captureLogs(fn) {
  /** @type {string[]} */
  const lines = [];
  const { log, error } = console;
  console.log = (...a) => void lines.push(a.join(" "));
  console.error = (...a) => void lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines;
}

test("finishTeardown(archive): archives, never spawns, logs the exact archived line", () => {
  const { registry, cfg } = cfgIn("decom");
  let spawned = 0;
  /** @type {string} */
  let to = "";
  const lines = captureLogs(() =>
    finishTeardown(
      { cfg, archive: true },
      {
        spawnDetached: () => {
          spawned++;
          return { pid: 1, logPath: "" };
        },
        archiveStateDir: (o) => {
          ({ archivedTo: to } = archiveStateDir({ ...o, registry }));
          return { archivedTo: to };
        },
      },
    ),
  );
  assert.equal(spawned, 0);
  assert.ok(to && fs.existsSync(to) && !fs.existsSync(cfg.stateDir));
  assert.deepEqual(lines, [`[decommission] archived ${cfg.stateDir} → ${to}`]);
  const audit = JSON.parse(fs.readFileSync(path.join(to, "ui-audit.jsonl"), "utf8"));
  assert.equal(audit.reason, "decommission");
  assert.equal(audit.source, "decommission");
});

test("finishTeardown(archive): runs only once the pidfile is gone (a live pidfile refuses)", () => {
  const { registry, cfg } = cfgIn("decom-live");
  fs.writeFileSync(cfg.pidFile, String(process.pid));
  const archive = (/** @type {any} */ o) => archiveStateDir({ ...o, registry });
  const lines = captureLogs(() => finishTeardown({ cfg, archive: true }, { archiveStateDir: archive, spawnDetached: () => assert.fail("spawned") }));
  assert.match(lines[0], new RegExp(`^\\[decommission\\] archive failed: .*is running.* — state dir left at ${cfg.stateDir}$`));
  assert.ok(fs.existsSync(cfg.stateDir));
  fs.rmSync(cfg.pidFile); // teardown removes the pidfile before its tail
  const ok = captureLogs(() => finishTeardown({ cfg, archive: true }, { archiveStateDir: archive }));
  assert.match(ok[0], /^\[decommission\] archived /);
  assert.ok(!fs.existsSync(cfg.stateDir));
});

test("finishTeardown(respawn): spawns, never archives", () => {
  const { cfg } = cfgIn("restart");
  let spawned = 0;
  captureLogs(() =>
    finishTeardown(
      { cfg, respawn: true },
      {
        spawnDetached: () => {
          spawned++;
          return { pid: 1, logPath: "x" };
        },
        archiveStateDir: () => assert.fail("archived"),
      },
    ),
  );
  assert.equal(spawned, 1);
  assert.ok(fs.existsSync(cfg.stateDir));
});

/** runDecommission deps that record the event + shutdown call. */
function fireDeps({ trackerFails = false, draining = false } = {}) {
  const d = {
    events: /** @type {any[]} */ ([]),
    shutdowns: /** @type {any[]} */ ([]),
    unregistered: 0,
    adapter: {
      unregisterWebhooks: async () => {
        d.unregistered++;
        if (trackerFails) throw new Error("tracker 500");
      },
    },
    forge: null,
    isDraining: () => draining,
    queued: () => 2,
    emit: (/** @type {any[]} */ ...a) => void d.events.push(a),
    shutdown: (/** @type {any[]} */ ...a) => void d.shutdowns.push(a),
  };
  return d;
}

test("runDecommission: a failed unregister still archives", async () => {
  const d = fireDeps({ trackerFails: true });
  /** @type {string[]} */
  const lines = [];
  const { log } = console;
  console.log = (...a) => void lines.push(a.join(" "));
  try {
    await runDecommission({ unregister: true }, d);
  } finally {
    console.log = log;
  }
  assert.deepEqual(lines, ["[decommission] webhooks — tracker failed, forge none (tracker: tracker 500)"]);
  assert.deepEqual(d.events, [["decommissioning", "", "", { queued: 2, unregister: { tracker: "failed", forge: "none", errors: { tracker: "tracker 500" } } }]]);
  assert.deepEqual(d.shutdowns, [["decommission", { archive: true }]]);
});

test("runDecommission: unregister:false skips the webhooks; a signal during it owns the exit", async () => {
  const { log } = console;
  console.log = () => {};
  try {
    const skip = fireDeps();
    await runDecommission({ unregister: false }, skip);
    assert.equal(skip.unregistered, 0);
    assert.deepEqual(skip.events[0][3].unregister, { tracker: "skipped", forge: "skipped" });
    assert.equal(skip.shutdowns.length, 1);

    const sig = fireDeps({ draining: true });
    await runDecommission({ unregister: true }, sig);
    assert.equal(sig.unregistered, 1);
    assert.deepEqual(sig.events, []);
    assert.deepEqual(sig.shutdowns, [], "no archive");
  } finally {
    console.log = log;
  }
});
