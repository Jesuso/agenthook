import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Quota pacing with named harnesses (#723): a claude reading at/above a `quota` threshold closes
// the run's subscription group — not the whole receiver — until the window resets. Unit tests for
// `quotaGroupOf`, the queue's `closeForQuota`/unharnessed gate/reopen timer, the harness-quota
// controller's grouping and readout, and the persisted cause.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quotaGroupOf } from "../src/dispatch/harness.js";
import { createQueue } from "../src/queue.js";
import { createHarnessQuota } from "../src/engine/controllers.js";
import { createStore } from "../src/store/index.js";
import { createOps } from "../src/ops.js";
import { harnessQuotaLints } from "../src/commands/doctor.js";

const T0 = Date.parse("2026-11-08T12:00:00Z");
const MIN = 60000;
const job = (ref, stepId = "code") => ({ kind: "pipeline", ref, stepId, dedupKey: `${ref}:${stepId}` });

// ---------------------------------------------------------------------------
// quotaGroupOf
// ---------------------------------------------------------------------------

const CLAUDE_HARNESSES = {
  sharedA: { agent: "claude", maxConcurrent: 1 },
  sharedB: { agent: "claude", maxConcurrent: 1 },
  own: { agent: "claude", env: { ANTHROPIC_API_KEY: "sk-x" }, maxConcurrent: 1 },
  baseUrl: { agent: "claude", env: { ANTHROPIC_BASE_URL: "http://localhost:1" }, maxConcurrent: 1 },
  oauth: { agent: "claude", env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, maxConcurrent: 1 },
  qwen: { agent: "opencode", maxConcurrent: 1 },
};

test("quotaGroupOf: claude harnesses without own-subscription env share the group with unharnessed claude steps", () => {
  const cfg = { agent: "claude", harnesses: CLAUDE_HARNESSES };
  assert.deepEqual(quotaGroupOf(cfg, "sharedA", null), { harnesses: ["sharedA", "sharedB"], unharnessed: true });
  assert.deepEqual(quotaGroupOf(cfg, null, { agent: "claude" }), { harnesses: ["sharedA", "sharedB"], unharnessed: true });
});

test("quotaGroupOf: any credential/base-URL var makes a claude harness a group of one; non-claude harnesses are never grouped", () => {
  const cfg = { agent: "claude", harnesses: CLAUDE_HARNESSES };
  for (const name of ["own", "baseUrl", "oauth"]) {
    assert.deepEqual(quotaGroupOf(cfg, name, null), { harnesses: [name], unharnessed: false }, name);
  }
  assert.deepEqual(quotaGroupOf(cfg, "qwen", null), { harnesses: [], unharnessed: false });
});

test("quotaGroupOf: an unharnessed step on its own credentials or a non-claude agent is gated on nothing", () => {
  const cfg = { agent: "claude", harnesses: CLAUDE_HARNESSES };
  assert.deepEqual(quotaGroupOf(cfg, null, { agent: "claude", env: { ANTHROPIC_AUTH_TOKEN: "t" } }), { harnesses: [], unharnessed: false });
  assert.deepEqual(quotaGroupOf(cfg, null, { agent: "opencode" }), { harnesses: [], unharnessed: false });
});

test("quotaGroupOf: the profile default cfg.agent is honoured", () => {
  const cfg = { agent: "opencode", harnesses: { bare: { maxConcurrent: 1 }, claude: { agent: "claude", maxConcurrent: 1 } } };
  assert.deepEqual(quotaGroupOf(cfg, "bare", null), { harnesses: [], unharnessed: false }, "cfg.agent opencode");
  assert.deepEqual(quotaGroupOf(cfg, "claude", null), { harnesses: ["claude"], unharnessed: true });
});

// ---------------------------------------------------------------------------
// The queue: closeForQuota, routing around a closed harness, the unharnessed
// gate, and the one-shot reopen timer.
// ---------------------------------------------------------------------------

/** A fake clock + one-shot timers fired by hand (src/shared/quota.js test style). */
function clock() {
  let t = T0;
  /** @type {Map<number, {fn: () => void, at: number}>} */
  const timers = new Map();
  let id = 0;
  return {
    now: () => t,
    setTimer: (/** @type {() => void} */ fn, /** @type {number} */ ms) => (timers.set(++id, { fn, at: t + ms }), id),
    clearTimer: (/** @type {number} */ i) => void timers.delete(i),
    /** Advance to `to`, firing due timers. @param {number} to */
    advance(to) {
      t = to;
      for (const [i, x] of [...timers]) if (x.at <= t) (timers.delete(i), x.fn());
    },
  };
}

/**
 * A harnessed queue on a fake clock with the quota reopen timer wired. `done` is omitted: these
 * tests only start runs and never settle them (the runs are held open).
 * @param {number} max @param {any} harnessing
 */
function quotaQueue(max, harnessing) {
  const c = clock();
  /** @type {string[]} */ const started = [];
  /** @type {any[]} */ const events = [];
  /** @type {any} */ let persisted = null;
  const run = (/** @type {any} */ j) =>
    new Promise((resolve) => {
      started.push(`${j.ref}:${j.harness ?? "-"}`);
    });
  const q = createQueue(max, run, undefined, undefined, {}, {
    ...harnessing,
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    onHealth: (/** @type {any} */ down, /** @type {string|null} */ gate) => (persisted = { down, gate }),
    onHarnessDown: (/** @type {string} */ n, /** @type {any} */ i) => events.push(["down", n, i]),
    onHarnessUp: (/** @type {string} */ n, /** @type {any} */ i) => events.push(["up", n, i]),
  });
  return { q, started, events, now: c.now, advance: c.advance, persisted: () => persisted };
}

test("closeForQuota routes a step to its other harness and reopens on the timer", () => {
  const b = quotaQueue(4, { steps: { code: { harnesses: ["A", "B"], routing: "first-free" }, onlyA: { harnesses: ["A"] } }, caps: { A: 1, B: 1 } });
  const until = T0 + 10 * MIN;
  b.q.closeForQuota(["A"], { until, reason: "quota: weekly 92% ≥ 90%, back at <ISO>" });
  b.q.enqueue(job("X", "code"));
  b.q.enqueue(job("Y", "onlyA"));
  assert.deepEqual(b.started, ["X:B"], "the closed harness is skipped, not failed");
  assert.equal(b.q.state().capped, 1, "Y waits, counted in capped");
  assert.equal(b.q.harnessState().A.state, "down");
  assert.equal(b.q.harnessState().A.cause, "quota");
  b.advance(until); // the reopen timer fires — no other pump
  assert.deepEqual(b.started, ["X:B", "Y:A"], "Y starts once the quota window resets");
  assert.equal(b.q.harnessState().A.state, "up");
  assert.deepEqual(b.events.at(-1), ["up", "A", { cause: "quota" }]);
});

test("closeForQuota emits harness_down with the quota cause and fields", () => {
  const b = quotaQueue(2, { steps: { code: { harnesses: ["A"] } }, caps: { A: 1 } });
  const until = T0 + 5 * MIN;
  b.q.closeForQuota(["A"], { until, reason: "quota: weekly 92% ≥ 90%, back at <ISO>", window: "sevenDay", utilization: 0.92, threshold: 0.9 });
  assert.deepEqual(b.events[0], ["down", "A", { reason: "quota: weekly 92% ≥ 90%, back at <ISO>", until: new Date(until).toISOString(), cause: "quota", window: "sevenDay", utilization: 0.92, threshold: 0.9 }]);
});

test("an unharnessed shared claude step waits while the gate holds, then starts", () => {
  const b = quotaQueue(2, { steps: { code: { harnesses: ["A"] } }, caps: { A: 1 }, unharnessedShared: ["triage"] });
  const until = T0 + 10 * MIN;
  b.q.closeForQuota(["A"], { until, reason: "quota: weekly 92% ≥ 90%", unharnessed: true });
  b.q.enqueue(job("T", "triage"));
  assert.deepEqual(b.started, [], "the unharnessed shared step is gated");
  assert.equal(b.q.state().capped, 1);
  b.advance(until);
  assert.deepEqual(b.started, ["T:-"], "the gate opens on the reopen timer");
});

test("a quota entry persists with cause and seeds a restart still-down, reopening to up (never probing) on the timer alone", () => {
  const until = T0 + 10 * MIN;
  const b1 = quotaQueue(2, { steps: { code: { harnesses: ["A"] } }, caps: { A: 1 } });
  b1.q.closeForQuota(["A"], { until, reason: "quota: weekly 92% ≥ 90%" });
  const p = b1.persisted();
  assert.equal(p.down.A.cause, "quota");
  assert.equal(p.down.A.strikes, 0, "a quota entry never adds strikes");
  // Simulated restart: a new queue seeded from the persisted record.
  const b2 = quotaQueue(2, { steps: { code: { harnesses: ["A"] } }, caps: { A: 1 }, health: p.down, unharnessedUntil: p.gate });
  assert.equal(b2.q.harnessState().A.state, "down");
  assert.equal(b2.q.harnessState().A.cause, "quota");
  b2.q.enqueue(job("Z", "code"));
  assert.deepEqual(b2.started, [], "still gated after the restart");
  b2.advance(until); // only the reopen timer, no reading, no pump trigger
  assert.deepEqual(b2.started, ["Z:A"]);
  assert.equal(b2.q.harnessState().A.state, "up", "quota expiry goes to up, not probing");
});

test("harness-health.json round-trips a quota cause and the unharnessed gate", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-quota-"));
  const s = createStore(dir);
  const down = { A: { until: "2026-11-08T12:10:00.000Z", strikes: 0, reason: "quota: weekly 92% ≥ 90%", cause: "quota" } };
  s.setHarnessHealth(down, "2026-11-08T12:10:00.000Z");
  assert.deepEqual(createStore(dir).getHarnessHealth(), { down, unharnessedUntil: "2026-11-08T12:10:00.000Z" });
});

// ---------------------------------------------------------------------------
// The harness-quota controller: grouping, the shared-group readout, and the
// harness_reset suppression.
// ---------------------------------------------------------------------------

const READING = { sevenDay: { utilization: 0.92, resetsAt: "2026-11-09T12:00:00Z" } };

function controllerHarness(/** @type {Record<string, any>} */ over = {}) {
  /** @type {any[]} */ const closes = [];
  const hb = { quota: null };
  const heartbeat = { update: (/** @type {any} */ p) => Object.assign(hb, p) };
  const queue = { closeForQuota: (/** @type {string[]} */ names, /** @type {any} */ opts) => closes.push({ names, opts }) };
  const cfg = {
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "ah-hq-")),
    agent: "claude",
    pipeline: [{ id: "code" }],
    quota: { pauseAboveSevenDay: 0.9 },
    harnesses: CLAUDE_HARNESSES,
    ...over,
  };
  const controller = createHarnessQuota({ cfg, queue, heartbeat, now: () => T0 });
  return { controller, closes, hb, cfg };
}

test("harness controller: a shared-group reading closes every shared harness and the readout", () => {
  const h = controllerHarness();
  h.controller.reading(READING, { harness: "sharedA", stepId: "code" });
  assert.equal(h.closes.length, 1);
  assert.deepEqual(h.closes[0].names, ["sharedA", "sharedB"]);
  assert.equal(h.closes[0].opts.unharnessed, true);
  assert.equal(h.closes[0].opts.until, Date.parse("2026-11-09T12:00:00Z"));
  assert.match(h.closes[0].opts.reason, /^quota: weekly 92% ≥ 90%/);
  assert.deepEqual(h.hb.quota, READING, "the shared group's reading is the readout");
  assert.ok(fs.existsSync(path.join(h.cfg.stateDir, "quota.json")), "the shared-group reading is persisted");
});

test("harness controller: an own-credential reading closes only itself and never overwrites the readout", () => {
  const h = controllerHarness();
  h.controller.reading(READING, { harness: "own", stepId: "code" });
  assert.equal(h.closes.length, 1);
  assert.deepEqual(h.closes[0].names, ["own"]);
  assert.equal(h.closes[0].opts.unharnessed, false);
  assert.equal(h.hb.quota, null, "an own-credential reading never writes heartbeat.quota");
  assert.equal(fs.existsSync(path.join(h.cfg.stateDir, "quota.json")), false, "an own-credential reading never writes quota.json");
});

test("harness controller: harness_reset suppresses re-closing the harness until its trip resets", () => {
  const h = controllerHarness();
  h.controller.reading(READING, { harness: "sharedA", stepId: "code" });
  const until = Date.parse("2026-11-09T12:00:00Z");
  h.controller.suppress("sharedA", until);
  h.controller.reading(READING, { harness: "sharedA", stepId: "code" });
  assert.equal(h.closes.length, 2);
  assert.deepEqual(h.closes[1].names, ["sharedB"], "the suppressed harness is not re-closed, its sibling still is");
});

test("harness_reset (ops): reopens a quota-closed harness, starts its waiting job, and a further reading before resetsAt does not re-close it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-hq-reset-"));
  const c = clock();
  const cfg = /** @type {any} */ ({
    name: "t",
    provider: "github",
    stateDir: dir,
    dataDir: dir,
    agent: "claude",
    pipeline: [{ id: "code", harness: ["A", "B"] }],
    quota: { pauseAboveSevenDay: 0.9 },
    harnesses: { A: { agent: "claude", maxConcurrent: 1 }, B: { agent: "claude", maxConcurrent: 1 } },
  });
  const store = createStore(dir);
  /** @type {string[]} */ const started = [];
  const queue = createQueue(2, (j) => new Promise(() => started.push(`${j.ref}:${j.harness ?? "-"}`)), undefined, undefined, {}, {
    steps: { code: { harnesses: ["A", "B"], routing: "first-free" } },
    caps: { A: 1, B: 1 },
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  const hb = { quota: null };
  const heartbeat = { update: (/** @type {any} */ p) => Object.assign(hb, p) };
  const harnessQuota = createHarnessQuota({ cfg, queue, heartbeat, now: c.now });
  const ops = createOps({ cfg, store, adapter: {}, forge: null, queue, cancelRun: () => false, intake: () => 0, emit: () => {}, heartbeat, pull: async () => {}, isLocked: () => false, harnessQuota });
  // A reading on A trips the shared group: both A and B close.
  harnessQuota.reading(READING, { harness: "A", stepId: "code" });
  assert.equal(queue.harnessState().A.state, "down");
  assert.equal(queue.harnessState().B.state, "down");
  queue.enqueue(job("R", "code"));
  assert.deepEqual(started, [], "both harnesses closed: R waits");
  const r = await ops.harness_reset({ harness: "A" });
  assert.equal(r.reset, true);
  assert.deepEqual(started, ["R:A"], "A reopens and starts the waiting job");
  // A further above-threshold reading before resetsAt re-closes nothing: A is suppressed.
  harnessQuota.reading(READING, { harness: "A", stepId: "code" });
  assert.equal(queue.harnessState().A.state, "up", "A stays up — the reset suppressed re-closing");
  assert.equal(queue.harnessState().B.state, "down");
});

test("harness controller: a below-threshold reading closes nothing", () => {
  const h = controllerHarness();
  h.controller.reading({ sevenDay: { utilization: 0.5, resetsAt: "2026-11-09T12:00:00Z" } }, { harness: "sharedA", stepId: "code" });
  assert.deepEqual(h.closes, []);
});

test("doctor: a quota-closed harness is an info finding with its reopen time; health/probing are not", () => {
  const profile = {
    up: true,
    heartbeat: {
      queue: {
        harnesses: {
          quotaA: { active: 0, max: 1, state: "down", until: "2026-11-08T12:10:00.000Z", reason: "quota: weekly 92% ≥ 90%", cause: "quota" },
          healthA: { active: 0, max: 1, state: "down", until: "2026-11-08T12:10:00.000Z", reason: "spawn failed", cause: "health" },
        },
      },
    },
  };
  const lints = harnessQuotaLints(/** @type {any} */ (profile));
  assert.equal(lints.length, 1);
  assert.equal(lints[0].level, "info");
  assert.equal(lints[0].label, "harness quotaA closed for quota");
  assert.match(lints[0].note, /back at 12:10Z/);
});
