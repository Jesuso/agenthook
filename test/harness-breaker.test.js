import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Direct unit tests for the health/quota breaker (src/harness-breaker.js), extracted out of
// src/queue.js (#874). These exercise the breaker's own interface — no queue, no routing.
import test from "node:test";
import assert from "node:assert/strict";
import { createHarnessBreaker } from "../src/harness-breaker.js";
import { DEFAULT_COOLDOWN_MINUTES, cooldownFor } from "../src/dispatch/harness.js";

const T0 = Date.parse("2026-11-08T12:00:00Z");
const MIN = 60000;

/** A fake clock + one-shot timers fired by hand (same style as test/quota-harness.test.js). */
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

/** A breaker over a fixed harness set ("A", "B" by default), recording its callbacks. */
function harness(names = ["A", "B"], seed = {}) {
  const c = clock();
  /** @type {any[]} */ const events = [];
  /** @type {any} */ let persisted = null;
  let changes = 0;
  const live = new Set(names);
  const b = createHarnessBreaker({
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    cooldowns: seed.cooldowns ?? {},
    isHarness: (name) => live.has(name),
    health: seed.health,
    unharnessedUntil: seed.unharnessedUntil,
    onHealth: (down, gate) => (persisted = { down, gate }),
    onHarnessDown: (n, i) => events.push(["down", n, i]),
    onHarnessUp: (n, i) => events.push(["up", n, i]),
    onChange: () => changes++,
  });
  return { b, c, events, live, persisted: () => persisted, changes: () => changes };
}

test("a health trip marks the harness down, strikes double the cooldown, then a healthy settle on the probing harness brings it up", () => {
  const { b, c, events } = harness();
  b.settle("A", { reason: "timeout" });
  assert.equal(b.stateOf("A"), "down");
  assert.equal(b.entry("A").strikes, 1);
  const firstUntil = b.entry("A").until;
  assert.equal(firstUntil, T0 + cooldownFor(DEFAULT_COOLDOWN_MINUTES, 1) * MIN);
  // A second trip while still down changes nothing (the `h !== "down"` guard).
  b.settle("A", { reason: "timeout again" });
  assert.equal(b.entry("A").strikes, 1, "a trip while already down is a no-op");
  c.advance(firstUntil); // now probing
  assert.equal(b.stateOf("A"), "probing");
  b.settle("A", { reason: "still failing" }); // strikes again, doubled cooldown
  assert.equal(b.entry("A").strikes, 2);
  assert.equal(b.entry("A").until, c.now() + cooldownFor(DEFAULT_COOLDOWN_MINUTES, 2) * MIN);
  c.advance(b.entry("A").until);
  assert.equal(b.stateOf("A"), "probing");
  b.settle("A", undefined); // a healthy run while probing
  assert.equal(b.stateOf("A"), "up");
  assert.deepEqual(events.at(-1), ["up", "A", { cause: "health" }]);
});

test("closeForQuota reads down then up (never probing) on the reopen timer, and never adds strikes", () => {
  const { b, c, events } = harness();
  const until = T0 + 10 * MIN;
  b.closeForQuota(["A"], { until, reason: "quota: weekly 92% ≥ 90%" });
  assert.equal(b.entry("A").strikes, 0);
  assert.equal(b.stateOf("A"), "down");
  b.arm();
  c.advance(until);
  assert.equal(b.stateOf("A"), "up", "a quota entry reopens straight to up, never probing");
  assert.deepEqual(events.at(-1), ["up", "A", { cause: "quota" }]);
});

test("closeForQuota never shortens a longer health-down, nor a later quota closure", () => {
  const { b } = harness();
  b.settle("A", { reason: "x" }); // health-down for DEFAULT_COOLDOWN_MINUTES
  const healthUntil = b.entry("A").until;
  b.closeForQuota(["A"], { until: healthUntil - MIN, reason: "quota (shorter)" });
  assert.equal(b.entry("A").until, healthUntil, "the longer health-down stands");
  assert.equal(b.entry("A").cause, "health");

  const first = T0 + 20 * MIN;
  b.closeForQuota(["B"], { until: first, reason: "quota 1" });
  assert.equal(b.entry("B").until, first);
  b.closeForQuota(["B"], { until: first - MIN, reason: "quota earlier" });
  assert.equal(b.entry("B").until, first, "never shortened to an earlier quota closure");
  const later = first + MIN;
  b.closeForQuota(["B"], { until: later, reason: "quota later" });
  assert.equal(b.entry("B").until, later, "a later quota closure still extends it");
});

test("the reopen timer fires onHarnessUp + onChange and re-arms on an early (clamped) fire", () => {
  const { b, c, events, changes } = harness();
  const until = T0 + 10 * MIN;
  b.closeForQuota(["A"], { until, reason: "quota" });
  assert.equal(changes(), 1, "closeForQuota fired onChange once");
  // Simulate the clamp firing early: re-arm manually before the deadline and advance to it.
  b.arm();
  c.advance(T0 + 5 * MIN); // before `until` — nothing should open yet
  assert.equal(b.stateOf("A"), "down");
  assert.equal(changes(), 1, "an early/no-op tick doesn't fire onChange again");
  c.advance(until);
  assert.equal(b.stateOf("A"), "up");
  assert.deepEqual(events.at(-1), ["up", "A", { cause: "quota" }]);
  assert.equal(changes(), 2, "the real reopen fired onChange once more");
});

test("reset: {reset:false, cause:null, until:null} when up, the entry's own cause/until when it existed", () => {
  const { b, events } = harness();
  assert.deepEqual(b.reset("A"), { reset: false, cause: null, until: null });
  b.settle("A", { reason: "x" });
  const until = b.entry("A").until;
  const r = b.reset("A");
  assert.deepEqual(r, { reset: true, cause: "health", until });
  assert.equal(b.stateOf("A"), "up");
  assert.deepEqual(events.at(-1), ["up", "A", { cause: "health" }]);
});

test("prune drops entries for harnesses no longer configured, and persists even when nothing changed", () => {
  const { b, live, persisted } = harness();
  b.settle("A", { reason: "x" });
  b.settle("B", { reason: "y" });
  live.delete("A"); // "A" is no longer a configured harness
  b.prune();
  assert.equal(b.entry("A"), undefined, "A's entry is dropped");
  assert.ok(b.entry("B"), "B's entry survives");
  assert.ok(persisted().down.B, "persisted after prune");
  assert.equal(persisted().down.A, undefined);
});

test("settle and prune never call onChange — only the timer fire, closeForQuota, and reset do", () => {
  const { b, c, changes } = harness();
  b.settle("A", { reason: "x" });
  assert.equal(changes(), 0, "settle alone never fires onChange");
  b.prune();
  assert.equal(changes(), 0, "prune alone never fires onChange");
  b.closeForQuota(["B"], { until: T0 + MIN, reason: "quota" });
  assert.equal(changes(), 1);
  b.reset("B");
  assert.equal(changes(), 2);
  c.advance(T0 + MIN); // nothing armed (closeForQuota armed, but B was already reset) — no extra fire expected beyond what's armed
  assert.ok(changes() >= 2);
});
