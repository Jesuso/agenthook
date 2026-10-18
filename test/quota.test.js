import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Claude quota (#397): the stream parser's `rate_limit_event`, quota.json, the readout, the
// pacer's state machine (fake clock + timers) and its interplay with operator pause/resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claude, createStreamParser } from "../src/agents/claude.js";
import { createQuotaPacer, evaluateQuota, formatDuration, formatQuota, normalizeQuota, normalizeTrip, quotaErrors, quotaFromRateLimitEvent } from "../src/quota.js";
import { readQuota, writeQuota } from "../src/quota-file.js";
import { createQueue } from "../src/queue.js";
import { createOps } from "../src/ops.js";
import { createStore } from "../src/store.js";
import { createQuotaControl } from "../src/engine.js";
import { validateRawConfig } from "../src/config.js";

const FIXTURE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-rate-limit-event.jsonl"), "utf8");
const RESET_5H = "2026-10-18T18:10:00.000Z"; // 1792347000 s
const RESET_7D = "2026-10-18T21:00:00.000Z"; // 1792357200 s
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-quota-"));
const T = (/** @type {string} */ iso) => Date.parse(iso);

// --- parser ---

test("parser: the real rate_limit_event capture → quota with ISO resets; no log text", () => {
  const p = createStreamParser();
  assert.equal(p.quota, null);
  assert.equal(p.push(FIXTURE), "");
  assert.deepEqual(p.quota, { fiveHour: { utilization: 0.08, resetsAt: RESET_5H }, sevenDay: { utilization: 0.66, resetsAt: RESET_7D } });
  // claude.createParser exposes it too.
  const c = claude.createParser();
  c.push(FIXTURE);
  assert.deepEqual(c.quota, p.quota);
});

test("parser: a malformed / unknown-shape rate_limit_event leaves quota unchanged, never throws; a later one replaces it", () => {
  const p = createStreamParser();
  p.push(FIXTURE);
  const before = p.quota;
  for (const bad of [
    { type: "rate_limit_event" },
    { type: "rate_limit_event", rate_limit_info: null },
    { type: "rate_limit_event", rate_limit_info: { unifiedWindows: "x" } },
    { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: "8%", resetsAt: 1 } } } },
    { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 9, resetsAt: 1 } } } },
    { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 1e300 } } } },
    { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: "soon" } } } },
  ]) {
    assert.doesNotThrow(() => p.push(JSON.stringify(bad) + "\n"));
    assert.deepEqual(p.quota, before);
  }
  p.push(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.7, resetsAt: 1792357200 } } } }) + "\n");
  assert.deepEqual(p.quota, { sevenDay: { utilization: 0.7, resetsAt: RESET_7D } });
});

test("quotaFromRateLimitEvent / normalizeQuota / normalizeTrip: validated numbers only", () => {
  assert.equal(quotaFromRateLimitEvent(null), null);
  assert.equal(quotaFromRateLimitEvent({ rate_limit_info: { unifiedWindows: {} } }), null);
  assert.equal(normalizeQuota(null), null);
  assert.equal(normalizeQuota({ fiveHour: { utilization: -1, resetsAt: RESET_5H } }), null);
  assert.deepEqual(normalizeQuota({ fiveHour: { utilization: 0.1, resetsAt: RESET_5H, x: 1 }, asOf: "nope", y: 2 }), { fiveHour: { utilization: 0.1, resetsAt: RESET_5H } });
  assert.equal(normalizeTrip({ window: "weekly", utilization: 0.9, threshold: 0.9, resetsAt: RESET_7D }), null);
  assert.deepEqual(normalizeTrip({ window: "sevenDay", utilization: 0.9, threshold: 0.8, resetsAt: RESET_7D, z: 1 }), { window: "sevenDay", utilization: 0.9, threshold: 0.8, resetsAt: RESET_7D });
});

// --- quota.json ---

test("readQuota / writeQuota: round-trip, atomic (no temp left), absent or garbage → null", () => {
  const dir = tmp();
  assert.equal(readQuota(dir), null);
  const q = { sevenDay: { utilization: 0.66, resetsAt: RESET_7D }, asOf: "2026-10-18T12:00:00.000Z" };
  writeQuota(dir, q);
  assert.deepEqual(readQuota(dir), q);
  assert.deepEqual(fs.readdirSync(dir), ["quota.json"]);
  fs.writeFileSync(path.join(dir, "quota.json"), "{oops");
  assert.equal(readQuota(dir), null);
});

// --- readout ---

test("formatQuota: weekly first with its countdown, 5h, age; a passed reset reads as reset", () => {
  const now = T("2026-10-16T16:45:00.000Z");
  const q = { sevenDay: { utilization: 0.654, resetsAt: "2026-10-18T21:00:00.000Z" }, fiveHour: { utilization: 0.08, resetsAt: "2026-10-16T18:10:00.000Z" }, asOf: "2026-10-16T16:42:00.000Z" };
  assert.equal(formatQuota(q, now), "weekly 65% · resets in 2d 4h · 5h 8% (as of 3m ago)");
  assert.equal(formatQuota(q, T("2026-10-17T00:00:00.000Z")), "weekly 65% · resets in 1d 21h · 5h reset (as of 7h 18m ago)");
  assert.equal(formatQuota({ fiveHour: { utilization: 0.5, resetsAt: "2026-10-16T18:10:00.000Z" } }, now), "5h 50% · resets in 1h 25m");
  assert.equal(formatQuota(null, now), "");
  assert.equal(formatDuration(20_000), "<1m");
});

// --- evaluateQuota ---

const READING = { sevenDay: { utilization: 0.92, resetsAt: RESET_7D }, fiveHour: { utilization: 0.08, resetsAt: RESET_5H } };
const BEFORE = T("2026-10-18T12:00:00.000Z");

test("evaluateQuota: at/above a set threshold pauses; missing, stale, below or no config fail open", () => {
  assert.deepEqual(evaluateQuota(READING, { pauseAboveSevenDay: 0.9 }, BEFORE), { pause: true, window: "sevenDay", utilization: 0.92, threshold: 0.9, resetsAt: RESET_7D });
  assert.equal(evaluateQuota(READING, { pauseAboveSevenDay: 0.92 }, BEFORE).pause, true, "at the threshold counts");
  assert.equal(evaluateQuota(READING, { pauseAboveSevenDay: 0.95 }, BEFORE).pause, false, "below");
  assert.equal(evaluateQuota(READING, {}, BEFORE).pause, false, "no config");
  assert.equal(evaluateQuota(READING, undefined, BEFORE).pause, false, "no config");
  assert.equal(evaluateQuota(null, { pauseAboveSevenDay: 0.5 }, BEFORE).pause, false, "no reading");
  assert.equal(evaluateQuota({ fiveHour: READING.fiveHour }, { pauseAboveSevenDay: 0.5 }, BEFORE).pause, false, "window missing");
  assert.equal(evaluateQuota(READING, { pauseAboveSevenDay: 0.5 }, T(RESET_7D)).pause, false, "stale: the reset passed");
  // Both tripped → the one that resets last.
  const both = evaluateQuota(READING, { pauseAboveSevenDay: 0.5, pauseAboveFiveHour: 0.05 }, BEFORE);
  assert.equal(both.pause && both.window, "sevenDay");
});

// --- pacer ---

/** A fake clock + one-shot timers the test fires by hand. */
function clock(start = BEFORE) {
  let t = start;
  /** @type {Map<number, {fn: () => void, at: number}>} */
  const timers = new Map();
  let id = 0;
  return {
    now: () => t,
    setTimer: (/** @type {() => void} */ fn, /** @type {number} */ ms) => (timers.set(++id, { fn, at: t + ms }), id),
    clearTimer: (/** @type {number} */ i) => void timers.delete(i),
    timers,
    /** Advance to `to`, firing due timers. @param {number} to */
    advance(to) {
      t = to;
      for (const [i, x] of [...timers]) if (x.at <= t) (timers.delete(i), x.fn());
    },
  };
}

/** @param {{thresholds?: any, locked?: () => boolean}} [o] */
function pacerHarness({ thresholds = { pauseAboveSevenDay: 0.9 }, locked = () => false } = {}) {
  const c = clock();
  /** @type {any[]} */ const log = [];
  let paused = false;
  const pacer = createQuotaPacer({
    thresholds,
    pauseQueue: () => ((paused = true), log.push("pauseQueue")),
    resumeQueue: () => ((paused = false), log.push("resumeQueue")),
    isLocked: locked,
    onPause: (t) => log.push(["quota_pause", t]),
    onResume: (i) => log.push(["quota_resume", i]),
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  return { c, log, pacer, paused: () => paused };
}

test("pacer: above threshold → pause + quota_pause and one timer at resetsAt; the reset → quota_resume + queue resumed", () => {
  const h = pacerHarness();
  h.pacer.reading(READING);
  assert.equal(h.paused(), true);
  assert.deepEqual(h.log, ["pauseQueue", ["quota_pause", { window: "sevenDay", utilization: 0.92, threshold: 0.9, resetsAt: RESET_7D }]]);
  assert.equal(h.c.timers.size, 1);
  assert.equal([...h.c.timers.values()][0].at, T(RESET_7D));
  h.pacer.reading(READING); // same trip again: no second pause/event, still one timer
  assert.equal(h.log.length, 2);
  assert.equal(h.c.timers.size, 1);
  h.c.advance(T(RESET_7D) - 1);
  assert.equal(h.paused(), true);
  h.c.advance(T(RESET_7D));
  assert.equal(h.paused(), false);
  assert.deepEqual(h.log.slice(2), [["quota_resume", { window: "sevenDay", reason: "reset" }], "resumeQueue"]);
  assert.equal(h.pacer.state(), null);
});

test("pacer: a newer below-threshold reading resumes at once (reason below) and drops the timer", () => {
  const h = pacerHarness();
  h.pacer.reading(READING);
  h.pacer.reading({ sevenDay: { utilization: 0.5, resetsAt: RESET_7D } });
  assert.equal(h.paused(), false);
  assert.deepEqual(h.log.at(-2), ["quota_resume", { window: "sevenDay", reason: "below" }]);
  assert.equal(h.c.timers.size, 0);
});

test("pacer: missing / stale / no-config readings never pause", () => {
  for (const [thresholds, reading] of /** @type {const} */ ([
    [{}, READING],
    [{ pauseAboveFiveHour: 0.5 }, { sevenDay: READING.sevenDay }],
    [{ pauseAboveSevenDay: 0.5 }, { sevenDay: { utilization: 0.99, resetsAt: "2026-10-18T11:00:00.000Z" } }],
    [{ pauseAboveSevenDay: 0.5 }, null],
  ])) {
    const h = pacerHarness({ thresholds });
    h.pacer.reading(reading);
    assert.equal(h.paused(), false);
    assert.deepEqual(h.log, []);
  }
});

test("pacer: a newer reading tripping the later window switches the pause to it (no resume at the earlier reset)", () => {
  const h = pacerHarness({ thresholds: { pauseAboveSevenDay: 0.9, pauseAboveFiveHour: 0.9 } });
  h.pacer.reading({ fiveHour: { utilization: 0.95, resetsAt: RESET_5H }, sevenDay: { utilization: 0.5, resetsAt: RESET_7D } });
  assert.equal(h.pacer.state()?.window, "fiveHour");
  h.pacer.reading({ fiveHour: { utilization: 0.97, resetsAt: RESET_5H }, sevenDay: { utilization: 0.91, resetsAt: RESET_7D } });
  assert.equal(h.pacer.state()?.window, "sevenDay");
  assert.deepEqual(h.log.filter((x) => Array.isArray(x)).map((x) => x[0]), ["quota_pause", "quota_pause"]);
  h.c.advance(T(RESET_5H));
  assert.equal(h.paused(), true, "still held by the weekly window");
  h.c.advance(T(RESET_7D));
  assert.equal(h.paused(), false);
});

test("interplay: an operator pause then the quota reset → the queue stays paused", () => {
  const h = pacerHarness();
  h.pacer.reading(READING);
  h.pacer.operatorPause();
  h.c.advance(T(RESET_7D));
  assert.deepEqual(h.log.at(-1), ["quota_resume", { window: "sevenDay", reason: "reset" }]);
  assert.equal(h.paused(), true, "the reset must not undo the operator pause");
});

test("interplay: an operator resume during a quota pause overrides it until that window resets", () => {
  const h = pacerHarness();
  h.pacer.reading(READING);
  assert.equal(h.pacer.operatorResume(), RESET_7D);
  assert.deepEqual(h.log.at(-1), ["quota_resume", { window: "sevenDay", reason: "operator" }]);
  assert.equal(h.c.timers.size, 0);
  h.pacer.reading({ sevenDay: { utilization: 0.97, resetsAt: RESET_7D } }); // same window, still above
  assert.equal(h.pacer.state(), null, "not re-paused in the overridden window");
  // The next window does.
  h.c.advance(T(RESET_7D) + 1000);
  const next = "2026-10-25T21:00:00.000Z";
  h.pacer.reading({ sevenDay: { utilization: 0.95, resetsAt: next } });
  assert.equal(h.pacer.state()?.resetsAt, next);
});

test("interplay: operator resume scopes the override to the tripped window — fiveHour", () => {
  const h = pacerHarness({ thresholds: { pauseAboveFiveHour: 0.9 } });
  h.pacer.reading({ fiveHour: { utilization: 0.95, resetsAt: RESET_5H } });
  assert.equal(h.pacer.operatorResume(), RESET_5H);
  h.pacer.reading({ fiveHour: { utilization: 0.97, resetsAt: RESET_5H } }); // same window, still above: no re-pause before its reset
  assert.equal(h.pacer.state(), null);
});

test("interplay: operator resume during a fiveHour trip does not suppress a sevenDay crossing", () => {
  const h = pacerHarness({ thresholds: { pauseAboveSevenDay: 0.9, pauseAboveFiveHour: 0.9 } });
  h.pacer.reading({ fiveHour: { utilization: 0.95, resetsAt: RESET_5H }, sevenDay: { utilization: 0.5, resetsAt: RESET_7D } });
  assert.equal(h.pacer.state()?.window, "fiveHour");
  assert.equal(h.pacer.operatorResume(), RESET_5H);
  h.pacer.reading({ fiveHour: { utilization: 0.1, resetsAt: RESET_5H }, sevenDay: { utilization: 0.91, resetsAt: RESET_7D } });
  assert.equal(h.pacer.state()?.window, "sevenDay", "sevenDay was not tripped at resume time, so it still pauses on crossing");
});

test("interplay: both windows tripped — operator resume overrides each until its own reset, neither re-pausing before then", () => {
  const h = pacerHarness({ thresholds: { pauseAboveSevenDay: 0.9, pauseAboveFiveHour: 0.9 } });
  h.pacer.reading({ fiveHour: { utilization: 0.95, resetsAt: RESET_5H }, sevenDay: { utilization: 0.91, resetsAt: RESET_7D } });
  assert.equal(h.pacer.state()?.window, "sevenDay", "the later-resetting trip is the one reported");
  assert.equal(h.pacer.operatorResume(), RESET_7D);
  // Both still read above threshold: neither re-pauses before its own reset.
  h.pacer.reading({ fiveHour: { utilization: 0.96, resetsAt: RESET_5H }, sevenDay: { utilization: 0.93, resetsAt: RESET_7D } });
  assert.equal(h.pacer.state(), null);
  // Past fiveHour's override end, a fresh fiveHour window (new resetsAt) pauses again even
  // though sevenDay's override (until the later RESET_7D) is still active.
  h.c.advance(T(RESET_5H) + 1000);
  const next5h = "2026-10-25T18:10:00.000Z";
  h.pacer.reading({ fiveHour: { utilization: 0.97, resetsAt: next5h }, sevenDay: { utilization: 0.93, resetsAt: RESET_7D } });
  assert.equal(h.pacer.state()?.window, "fiveHour");
});

test("interplay: while a restart/decommission lock holds the queue, the quota reset does not resume it", () => {
  const h = pacerHarness({ locked: () => true });
  h.pacer.reading(READING);
  h.c.advance(T(RESET_7D));
  assert.ok(!h.log.includes("resumeQueue"));
});

test("pacer + real queue: a running agent is never cancelled; waiting jobs start at the reset", async () => {
  const c = clock();
  /** @type {string[]} */ const started = [];
  /** @type {(() => void)[]} */ const finish = [];
  const queue = createQueue(2, (job) => {
    started.push(job.ref);
    return new Promise((r) => finish.push(() => r({ kind: job.kind, name: job.ref, code: 0, url: "" })));
  });
  const log = console.log;
  console.log = () => {};
  try {
    queue.enqueue({ kind: "pipeline", ref: "a", stepId: "code", dedupKey: "a" });
    const pacer = createQuotaPacer({ thresholds: { pauseAboveSevenDay: 0.9 }, pauseQueue: queue.pause, resumeQueue: queue.resume, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    pacer.reading(READING);
    queue.enqueue({ kind: "pipeline", ref: "b", stepId: "code", dedupKey: "b" });
    assert.deepEqual(started, ["a"]);
    assert.deepEqual(queue.state(), { active: 1, queued: 1 }, "a keeps running, b waits");
    c.advance(T(RESET_7D));
    assert.deepEqual(started, ["a", "b"]);
    for (const f of finish) f();
    await queue.onActiveIdle();
  } finally {
    console.log = log;
  }
});

// --- engine control + ops interplay (audit lines) ---

function controlHarness({ thresholds = { pauseAboveSevenDay: 0.9 } } = {}) {
  const dir = tmp();
  const c = clock();
  const cfg = /** @type {any} */ ({ name: "t", provider: "github", stateDir: dir, dataDir: dir, quota: thresholds, pipeline: [{ id: "code" }] });
  const queue = createQueue(1, () => new Promise(() => {}));
  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const beats = [];
  let pulls = 0;
  const heartbeat = { update: (/** @type {any} */ p) => beats.push(p) };
  const emit = (/** @type {string} */ e, /** @type {string} */ _r, /** @type {string} */ _s, /** @type {any} */ x) => events.push([e, x]);
  const pacer = createQuotaControl({ cfg, queue, heartbeat, emit, pull: async () => void pulls++, isLocked: () => false, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  const ops = createOps({
    cfg, store: createStore(dir), adapter: /** @type {any} */ ({}), forge: null, queue, heartbeat, emit, pacer,
    cancelRun: () => false, intake: () => 0, pull: async () => void pulls++, isLocked: () => false,
  });
  const audit = () => fs.readFileSync(path.join(dir, "control-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { c, queue, pacer, ops, events, beats, audit, pulls: () => pulls };
}

test("engine quota control: quota_pause / quota_resume reach the heartbeat, events and control-audit.jsonl", () => {
  const log = console.log;
  console.log = () => {};
  try {
    const h = controlHarness();
    h.pacer.reading(READING);
    assert.equal(h.queue.isPaused(), true);
    const trip = { window: "sevenDay", utilization: 0.92, threshold: 0.9, resetsAt: RESET_7D };
    assert.deepEqual(h.beats.at(-1), { quotaPaused: trip });
    assert.deepEqual(h.events.at(-1), ["quota_pause", trip]);
    h.c.advance(T(RESET_7D));
    assert.equal(h.queue.isPaused(), false);
    assert.equal(h.pulls(), 1, "a release pulls the backlog");
    assert.deepEqual(h.beats.at(-1), { quotaPaused: null });
    assert.deepEqual(h.events.at(-1), ["quota_resume", { window: "sevenDay", reason: "reset" }]);
    const lines = h.audit();
    assert.deepEqual(lines.map((l) => [l.cmd, l.actor, l.ok]), [["quota_pause", "quota", true], ["quota_resume", "quota", true]]);
    assert.deepEqual(lines[0].args, trip);
  } finally {
    console.log = log;
  }
});

test("ops interplay: operator pause survives the quota reset; operator resume overrides a quota pause", async () => {
  const log = console.log;
  console.log = () => {};
  try {
    const h = controlHarness();
    h.pacer.reading(READING);
    await h.ops.pause({ actor: "t" });
    h.c.advance(T(RESET_7D));
    assert.equal(h.queue.isPaused(), true, "manual pause wins over the quota reset");

    const g = controlHarness();
    g.pacer.reading(READING);
    const r = await g.ops.resume({ actor: "t" });
    assert.equal(r.paused, false);
    assert.match(r.note, /quota pause overridden until/);
    assert.equal(g.queue.isPaused(), false);
    g.pacer.reading({ sevenDay: { utilization: 0.99, resetsAt: RESET_7D } });
    assert.equal(g.queue.isPaused(), false, "not re-paused in the same window");
    assert.deepEqual(g.audit().map((l) => l.cmd), ["quota_pause", "quota_resume", "resume"]);
  } finally {
    console.log = log;
  }
});

// --- config ---

test("quotaErrors: each key optional, a number in (0, 1]; unknown keys rejected", () => {
  assert.deepEqual(quotaErrors(undefined), []);
  assert.deepEqual(quotaErrors({}), []);
  assert.deepEqual(quotaErrors({ pauseAboveSevenDay: 0.9, pauseAboveFiveHour: 1 }), []);
  assert.equal(quotaErrors("x").length, 1);
  assert.equal(quotaErrors({ pauseAboveSevenDay: 0 }).length, 1);
  assert.equal(quotaErrors({ pauseAboveSevenDay: 1.2 }).length, 1);
  assert.equal(quotaErrors({ pauseAboveFiveHour: "0.9" }).length, 1);
  assert.match(quotaErrors({ pauseAt: 0.9 })[0], /unknown key "pauseAt"/);
});

test("validateRawConfig: a bad quota block is a config error", () => {
  const raw = { name: "x", repoPath: "/tmp", tracker: { type: "github", pipeline: [{ id: "code", sourceLabel: "a", successLabel: "b" }] }, quota: { pauseAboveSevenDay: 2 } };
  const v = validateRawConfig(raw);
  assert.equal(v.ok, false);
  assert.ok(/** @type {any} */ (v).errors.some((/** @type {string} */ e) => /quota\.pauseAboveSevenDay/.test(e)));
});
