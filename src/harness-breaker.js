// The health/quota breaker for a harness-routed queue (src/queue.js): per-harness
// up/down/probing state, the unharnessed quota gate, and the one-shot deadline timer
// that wakes the queue at a quota reopen or a health cooldown's end.
// Extracted so the breaker's own invariants (reopen ordering, no onChange from a
// passive read) can be tested without dragging in queue routing/waiters.
import { DEFAULT_COOLDOWN_MINUTES, cooldownFor } from "./dispatch/harness.js";

/** One harness's breaker entry: down until `until` (ms epoch), then probing; `strikes` doubles the next cooldown.
 * `cause` is `health` (a failing backend) or `quota` (a closed subscription, reopening to `up` at `until`).
 * @typedef {{until: number, strikes: number, reason: string, cause?: 'health'|'quota'}} HarnessHealth */

/**
 * @param {{now: () => number, setTimer: (fn: () => void, ms: number) => NodeJS.Timeout, clearTimer: (t: NodeJS.Timeout) => void,
 *   cooldowns: Record<string, number|undefined>, isHarness: (name: string) => boolean,
 *   health?: Record<string, {until: string, strikes: number, reason: string, cause?: 'health'|'quota'}>,
 *   unharnessedUntil?: string|null,
 *   onHealth?: (down: Record<string, {until: string, strikes: number, reason: string, cause: 'health'|'quota'}>, unharnessedUntil: string|null) => void,
 *   onHarnessDown?: (name: string, info: {reason: string, until: string, cause: 'health'|'quota', window?: 'sevenDay'|'fiveHour', utilization?: number, threshold?: number}) => void,
 *   onHarnessUp?: (name: string, info: {cause: 'health'|'quota'}) => void,
 *   onChange: () => void}} opts
 *   `cooldowns` is the same object the caller mutates on reload (read live, never copied). `isHarness`
 *   is a live predicate over the caller's current harness set (not a snapshot at construction).
 *   `onChange` is called synchronously by the timer fire, `closeForQuota` (when it changed anything)
 *   and `reset` (when an entry existed) — never by `settle` or `prune`, whose caller reports/pumps
 *   itself at its own moment.
 */
export function createHarnessBreaker({ now, setTimer, clearTimer, cooldowns, isHarness, health: healthSeed, unharnessedUntil: gateSeed, onHealth, onHarnessDown, onHarnessUp, onChange }) {
  /** @type {Map<string, HarnessHealth>} harness name → its breaker entry (absent = up) */
  const health = new Map();
  for (const [name, h] of Object.entries(healthSeed ?? {})) {
    const until = Date.parse(h?.until);
    if (isHarness(name) && Number.isFinite(until)) health.set(name, { until, strikes: Number.isInteger(h.strikes) && h.strikes > 0 ? h.strikes : 1, reason: String(h.reason ?? ""), ...(h?.cause ? { cause: h.cause } : { cause: "health" }) });
  }
  /** The unharnessed gate's deadline (ms epoch) while the shared group is quota-closed; null = open. */
  /** @type {number|null} */
  let unharnessedUntil = null;
  if (typeof gateSeed === "string" && Number.isFinite(Date.parse(gateSeed))) unharnessedUntil = Date.parse(gateSeed);

  /** @param {string} name @returns {'up'|'down'|'probing'} */
  const stateOf = (name) => {
    const h = health.get(name);
    if (!h) return "up";
    if (now() < h.until) return "down";
    return h.cause === "quota" ? "up" : "probing";
  };
  /** Health entries already woken once at their `until` — in memory only, never persisted. A
   * re-trip replaces the entry object (see `settle`), so it wakes again at its new `until`. */
  const woken = new WeakSet();
  /** The earliest deadline (a quota entry's `until`, the unharnessed gate, or a not-yet-woken
   * health entry's `until`), or null when none is set. */
  const nextDeadline = () => {
    let d = Infinity;
    for (const [, h] of health) {
      if (h.cause === "quota") {
        if (h.until < d) d = h.until;
      } else if (!woken.has(h) && h.until < d) {
        d = h.until;
      }
    }
    if (unharnessedUntil !== null && unharnessedUntil < d) d = unharnessedUntil;
    return d === Infinity ? null : d;
  };
  const persistHealth = () => {
    /** @type {Record<string, {until: string, strikes: number, reason: string, cause: 'health'|'quota'}>} */
    const down = {};
    for (const [name, h] of health) down[name] = { until: new Date(h.until).toISOString(), strikes: h.strikes, reason: h.reason, cause: h.cause ?? "health" };
    try {
      onHealth?.(down, unharnessedUntil === null ? null : new Date(unharnessedUntil).toISOString());
    } catch (e) {
      console.error(`[harness] health write failed (continuing): ${e.message}`);
    }
  };
  // The deadline timer: one unref'd one-shot at the earliest of a quota reopen, the unharnessed
  // gate, or a health cooldown's end (a deadline, never a poll), clamped like src/shared/quota.js
  // MAX_TIMER_MS and re-armed when it fires before the deadline.
  const MAX_TIMER_MS = 2 ** 31 - 1;
  /** @type {NodeJS.Timeout|undefined} */
  let deadlineTimer;
  /** (Re-)arm the deadline timer at the earliest deadline; no-op when none is set. Call once at boot. */
  const arm = () => {
    if (deadlineTimer !== undefined) clearTimer(deadlineTimer);
    deadlineTimer = undefined;
    const d = nextDeadline();
    if (d === null) return;
    deadlineTimer = setTimer(onDeadline, Math.min(Math.max(0, d - now()), MAX_TIMER_MS));
    deadlineTimer?.unref?.();
  };
  function onDeadline() {
    deadlineTimer = undefined;
    const d = nextDeadline();
    if (d === null) return;
    if (d > now()) return arm(); // a clamped long wait fired early: re-arm for the remainder
    /** @type {string[]} */
    const opened = [];
    for (const [name, h] of [...health]) {
      if (h.cause === "quota" && h.until <= now()) {
        health.delete(name);
        opened.push(name);
      }
    }
    let gateOpened = false;
    if (unharnessedUntil !== null && unharnessedUntil <= now()) {
      unharnessedUntil = null;
      gateOpened = true;
    }
    // Health entries wake once per `until` — they stay in the map (still `probing`), just marked
    // woken so they don't keep re-arming a 0 ms loop while nothing has settled them.
    let woke = false;
    for (const [, h] of health) {
      if (h.cause !== "quota" && !woken.has(h) && h.until <= now()) {
        woken.add(h);
        woke = true;
      }
    }
    if (opened.length || gateOpened) {
      persistHealth();
      for (const name of opened) {
        console.log(`[harness] ${name} quota window reset — back up`);
        onHarnessUp?.(name, { cause: "quota" });
      }
    }
    if (opened.length || gateOpened || woke) onChange();
    arm(); // any later deadline still ahead
  }

  return {
    /** @param {string} name @returns {'up'|'down'|'probing'} */
    stateOf,
    /** @param {string} name  raw breaker entry (for `harnessState`'s until/reason/cause), or undefined when up. */
    entry: (name) => health.get(name),
    /** True while the unharnessed quota gate holds (its deadline hasn't passed yet). */
    gateClosed: () => unharnessedUntil !== null && now() < unharnessedUntil,
    /**
     * A settle on `name`: a health signal opens (or re-opens) its breaker, a healthy settle closes a
     * probing one. A trip from a run that started before the harness went down changes nothing.
     * Never calls `onChange` — the caller reports/pumps at its own moment.
     * @param {string} name @param {{reason: string}|undefined} signal
     */
    settle(name, signal) {
      if (!isHarness(name)) return; // a harness removed by a reload never re-trips
      const h = stateOf(name);
      const cur = health.get(name);
      if (signal && h !== "down") {
        const strikes = cur ? cur.strikes + 1 : 1;
        const cd = cooldowns[name] ?? DEFAULT_COOLDOWN_MINUTES;
        const until = now() + cooldownFor(cd, strikes) * 60000;
        health.set(name, { until, strikes, reason: signal.reason, cause: "health" });
        persistHealth();
        arm(); // wake the queue once this cooldown ends, even if nothing else pumps meanwhile
        console.warn(`[harness] ${name} down until ${new Date(until).toISOString()} (${signal.reason})`);
        onHarnessDown?.(name, { reason: signal.reason, until: new Date(until).toISOString(), cause: "health" });
      } else if (!signal && h === "probing") {
        health.delete(name);
        persistHealth();
        console.log(`[harness] ${name} up again`);
        onHarnessUp?.(name, { cause: "health" });
      }
    },
    /**
     * Close a subscription group for quota: every named harness gets a `cause:"quota"` entry, and
     * `unharnessed` also sets the queue-level gate. Never shortens a longer health-down or a later
     * quota closure, and an identical closure is a no-op. Fires `onChange` and re-arms when changed.
     * @param {string[]} names
     * @param {{until: number, reason: string, unharnessed?: boolean, window?: 'sevenDay'|'fiveHour', utilization?: number, threshold?: number}} opts
     */
    closeForQuota(names, { until, reason, unharnessed = false, window, utilization, threshold }) {
      let changed = false;
      for (const name of names) {
        const cur = health.get(name);
        if (cur && cur.cause !== "quota" && cur.until > until) continue; // a longer health-down stands
        if (cur?.cause === "quota" && cur.until >= until) continue; // never shorten a quota closure, nor re-emit on a slightly different reading
        health.set(name, { until, strikes: cur?.strikes ?? 0, reason, cause: "quota" });
        console.log(`[harness] ${name} closed for quota until ${new Date(until).toISOString()}`);
        onHarnessDown?.(name, { reason, until: new Date(until).toISOString(), cause: "quota", ...(window ? { window, utilization, threshold } : {}) });
        changed = true;
      }
      if (unharnessed && (unharnessedUntil === null || until > unharnessedUntil)) {
        unharnessedUntil = until;
        changed = true;
      }
      if (changed) {
        persistHealth();
        arm();
        onChange();
      }
    },
    /**
     * Close `name`'s breaker now (the `harness_reset` op): drop its entry, persist, report
     * `onHarnessUp` (with the entry's `cause`), then `onChange`. `reset:false` (and null cause/until)
     * when it was up, with no side effect.
     * @param {string} name @returns {{reset: boolean, cause: 'health'|'quota'|null, until: number|null}}
     */
    reset(name) {
      const entry = health.get(name);
      if (!entry) return { reset: false, cause: null, until: null };
      health.delete(name);
      persistHealth();
      arm();
      onHarnessUp?.(name, { cause: entry.cause ?? "health" });
      onChange();
      return { reset: true, cause: entry.cause ?? "health", until: entry.until };
    },
    /** Drop entries for harnesses no longer configured (`isHarness` now false for them), then persist unconditionally. Never calls `onChange`. */
    prune() {
      for (const name of [...health.keys()]) if (!isHarness(name)) health.delete(name);
      persistHealth();
      arm();
    },
    /** (Re-)arm the deadline timer — call once at boot to pick up a persisted quota closure or health cooldown. */
    arm,
    /** Disarm the deadline timer (shutdown). */
    stop() {
      if (deadlineTimer !== undefined) clearTimer(deadlineTimer);
      deadlineTimer = undefined;
    },
  };
}
