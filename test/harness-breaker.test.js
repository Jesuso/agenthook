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
  /** @type {number[]} the `ms` passed to each setTimer call, in order */
  const delays = [];
  return {
    now: () => t,
    delays,
    setTimer: (/** @type {() => void} */ fn, /** @type {number} */ ms) => (delays.push(ms), timers.set(++id, { fn, at: t + ms }), id),
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
  const persistedAccessor = () => persisted;
  persistedAccessor.reset = () => (persisted = null);
  return { b, c, events, live, persisted: persistedAccessor, changes: () => changes };
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

test("closeForQuota never adds strikes, and a stale quota entry reads up (never probing) on a lazy read before the timer fires", () => {
  const { b, c, events } = harness();
  const until = T0 + 10 * MIN;
  b.closeForQuota(["A"], { until, reason: "quota: weekly 92% ≥ 90%" });
  assert.equal(b.entry("A").strikes, 0, "a quota entry never adds strikes");
  assert.equal(b.stateOf("A"), "down");
  // Seed a second breaker with the same still-quota-closed entry but never call .arm() on it, so
  // no timer is armed — stateOf must still read "up" (never "probing") once `until` passes, purely
  // from the cause check, with the stale entry still sitting in the map.
  const until2 = { until: new Date(until).toISOString(), strikes: 0, reason: "x", cause: "quota" };
  const lazy = harness(["A"], { health: { A: until2 } });
  lazy.c.advance(until);
  assert.equal(lazy.b.stateOf("A"), "up", "a quota entry reads up on a lazy read, never probing");
  assert.ok(lazy.b.entry("A"), "the stale entry stays in the map — no timer was armed to clear it");
  b.arm();
  c.advance(until); // now let the reopen timer actually fire on the first breaker
  assert.equal(b.entry("A"), undefined, "the timer clears the stale entry");
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
  const MAX_TIMER_MS = 2 ** 31 - 1;
  const until = T0 + MAX_TIMER_MS + 10 * MIN; // further out than the clamp can wait in one tick
  b.closeForQuota(["A"], { until, reason: "quota" });
  assert.equal(changes(), 1, "closeForQuota fired onChange once");
  assert.equal(c.delays.at(-1), MAX_TIMER_MS, "the first timer is clamped to MAX_TIMER_MS, not the full wait");
  // Advancing exactly to the clamped fire point should re-arm, not open — `until` is still ahead.
  c.advance(T0 + MAX_TIMER_MS);
  assert.equal(b.stateOf("A"), "down", "the clamped fire is still well before `until`");
  assert.equal(changes(), 1, "the clamped (early) fire doesn't open anything, so onChange doesn't fire again");
  assert.equal(c.delays.length, 2, "onDeadline re-armed a second timer for the remainder");
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
  // Now prune again with nothing left to remove — it must still persist unconditionally.
  persisted.reset();
  b.prune();
  assert.ok(persisted(), "prune persists even when no entry was dropped");
  assert.ok(persisted().down.B, "the surviving entry is still reported");
});

test("settle and prune never call onChange directly — only the deadline timer fire, closeForQuota, and reset do", () => {
  const { b, c, changes } = harness();
  b.settle("A", { reason: "x" });
  assert.equal(changes(), 0, "settle itself never fires onChange (health-down branch)");
  // settle armed a deadline timer at A's `until` so the queue wakes on its own; advancing to it is
  // the deadline timer firing, not settle — it fires onChange once for the health wake.
  c.advance(b.entry("A").until);
  assert.equal(b.stateOf("A"), "probing");
  assert.equal(changes(), 1, "the deadline timer's health wake fires onChange, not settle");
  b.settle("A", undefined);
  assert.equal(b.stateOf("A"), "up");
  assert.equal(changes(), 1, "settle itself never fires onChange (probing→up branch)");
  b.prune();
  assert.equal(changes(), 1, "prune alone never fires onChange");
  b.closeForQuota(["B"], { until: T0 + MIN, reason: "quota" });
  assert.equal(changes(), 2);
  b.reset("B");
  assert.equal(changes(), 3);
  c.advance(T0 + MIN); // B was already reset, so no timer is armed for it — no further fire
  assert.equal(changes(), 3, "nothing left to fire after B was reset ahead of its deadline");
});

test("a health trip arms a deadline timer at `until`; it wakes the queue once, never re-arms for that entry, and a re-trip wakes it again", () => {
  const { b, c, events, changes } = harness();
  b.settle("A", { reason: "worker unreachable" });
  const until = b.entry("A").until;
  assert.equal(c.delays.at(-1), until - T0, "settle armed the deadline timer at the health `until`");
  c.advance(until);
  assert.equal(changes(), 1, "onChange fired exactly once for the wake");
  assert.equal(b.stateOf("A"), "probing", "the entry still exists and reads probing");
  assert.ok(b.entry("A"), "the entry itself is not deleted by the wake");
  assert.equal(events.find(([kind]) => kind === "up"), undefined, "no harness_up is emitted for a mere wake");
  const timerCountAfterWake = c.delays.length;
  c.advance(until + 10 * MIN); // nothing else is pending — no re-arm loop for the woken entry
  assert.equal(c.delays.length, timerCountAfterWake, "no further timer was armed for the already-woken entry");
  assert.equal(changes(), 1, "still just the one onChange from the wake");
  // A re-trip while probing sets a fresh entry object with a doubled cooldown — it wakes again.
  b.settle("A", { reason: "still failing" });
  const until2 = b.entry("A").until;
  assert.ok(until2 > until, "the re-trip's cooldown is longer (strikes doubled)");
  c.advance(until2);
  assert.equal(changes(), 2, "the re-trip's fresh entry wakes onChange again at its own until");
  assert.equal(b.stateOf("A"), "probing");
});

test("arm() picks up a seeded health entry: a future `until` wakes at its deadline, a past `until` wakes once on the first fire after arm()", () => {
  const future = T0 + 10 * MIN;
  const seeded = harness(["A"], { health: { A: { until: new Date(future).toISOString(), strikes: 1, reason: "x", cause: "health" } } });
  seeded.b.arm();
  assert.equal(seeded.c.delays.at(-1), future - T0, "armed at the seeded future `until`");
  seeded.c.advance(future);
  assert.equal(seeded.changes(), 1, "the seeded future health entry wakes onChange at its deadline");
  assert.equal(seeded.b.stateOf("A"), "probing");

  const past = T0 - 5 * MIN;
  const seededPast = harness(["A"], { health: { A: { until: new Date(past).toISOString(), strikes: 1, reason: "x", cause: "health" } } });
  seededPast.b.arm();
  assert.equal(seededPast.c.delays.at(-1), 0, "a past `until` arms a 0 ms timer");
  seededPast.c.advance(T0);
  assert.equal(seededPast.changes(), 1, "the seeded past-due health entry wakes onChange once on the first fire");
  const delayCount = seededPast.c.delays.length;
  seededPast.c.advance(T0 + 60 * MIN);
  assert.equal(seededPast.changes(), 1, "never wakes a second time for the same entry");
  assert.equal(seededPast.c.delays.length, delayCount, "no further timer was armed for it");
});
