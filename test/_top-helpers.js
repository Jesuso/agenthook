// Shared fakes for the `agenthook top` loop tests (test/top-loop.test.js full-screen mode,
// test/top-strip.test.js strip mode) — imported after each file's `./_setup.js` so the
// AGENTHOOK_HOME isolation runs first.
import { EventEmitter } from "node:events";
import { runTop } from "../src/top-loop.js";

export const FRAME = "\u001b[H\u001b[2J"; // the full-screen mode's home + full-clear, one per drawn frame

export const NOW = Date.parse("2025-06-01T12:00:00Z");
export const iso = (ms) => new Date(ms).toISOString();

/** A tick the renderer can draw: up, one held row. */
export const heldTick = () => ({
  profile: "dev",
  up: true,
  slots: { max: 4, active: 1, queued: 2 },
  held: [{ id: "AH-12", ref: "h1", step: "review", title: "Waiting on the design answer", since: iso(NOW - 5 * 60e3) }],
  running: [{ ref: "r1", step: "code", ageS: 300 }],
  events: [],
  cursor: 0,
});

export const emptyUpTick = () => ({ profile: "dev", up: true, slots: { max: 4, active: 0, queued: 0 }, running: [], held: [], events: [], cursor: 0 });
export const downTick = () => ({ profile: "dev", up: false, slots: { max: 4, active: 0, queued: 0 }, running: [], held: [], events: [], cursor: 0 });

/** @param {string} s */
export const visible = (s) => [...s.replace(/\u001b\[[0-9;?]*m/g, "")];

/** A fake terminal: records every write, exposes columns/rows, emits 'resize'. */
export function makeOut({ columns = 60, rows = 20, isTTY = true } = {}) {
  const ee = new EventEmitter();
  let buf = "";
  return {
    isTTY,
    columns,
    rows,
    write: (/** @type {string} */ s) => {
      buf += s;
      return true;
    },
    text: () => buf,
    frames: () => buf.split(FRAME).slice(1), // one entry per drawn frame (full-screen mode)
    /** One entry per painted frame in strip mode — the buffer with the strip's hide-cursor
     * stripped and each repaint's move-back prefix (\r + up + erase-below) removed. */
    stripFrames: () => buf.split(/\r(?:\u001b\[[0-9]+A)?\u001b\[J/).map((c, i) => (i === 0 ? c.replace("\u001b[?25l", "") : c).replace(/\u001b\[\?25h\n$/, "")),
    on: (/** @type {string} */ e, /** @type {Function} */ f) => ee.on(e, f),
    removeListener: (/** @type {string} */ e, /** @type {Function} */ f) => ee.removeListener(e, f),
    listenerCount: (/** @type {string} */ e) => ee.listenerCount(e),
    emitResize: () => ee.emit("resize"),
  };
}

/** A fake key stream (not a TTY — no raw mode). */
export function makeInput() {
  const ee = new EventEmitter();
  /** @type {{resume: number, pause: number}} */
  const calls = { resume: 0, pause: 0 };
  return {
    isTTY: false,
    on: (/** @type {string} */ e, /** @type {Function} */ f) => ee.on(e, f),
    removeListener: (/** @type {string} */ e, /** @type {Function} */ f) => ee.removeListener(e, f),
    listenerCount: (/** @type {string} */ e) => ee.listenerCount(e),
    resume: () => {
      calls.resume += 1;
    },
    pause: () => {
      calls.pause += 1;
    },
    calls,
    key: (/** @type {number} */ b) => ee.emit("data", Buffer.from([b])),
  };
}

/** A fake event-bus wait: parks until `wake()` (or the abort signal fires). */
export function makeNextEvent() {
  /** @type {{ms: number|null}[]} */
  const calls = [];
  /** @type {{resolve: Function, signal: AbortSignal}[]} */
  const waiters = [];
  /** @param {AbortSignal} signal @param {number} ms */
  const fn = (signal, ms) => {
    calls.push({ ms });
    return new Promise((resolve) => {
      if (signal.aborted) return resolve({ timedOut: true });
      const w = { resolve, signal };
      waiters.push(w);
      signal.addEventListener("abort", () => resolve({ timedOut: true }), { once: true });
    });
  };
  fn.calls = calls;
  fn.waiting = () => waiters.length;
  /** @param {boolean} [timedOut] */
  fn.wake = (timedOut = false) => {
    while (waiters.length) waiters.shift().resolve({ timedOut });
  };
  return fn;
}

/** A fake 1 s timer: capture the callback, `fire` it on demand. */
export function makeTimers() {
  /** @type {{id: string|null, fn: Function|null, ms: number|null}} */
  const slot = { id: null, fn: null, ms: null };
  const cleared = [];
  return {
    setInt: (/** @type {Function} */ f, /** @type {number} */ ms) => {
      slot.id = "I1";
      slot.fn = f;
      slot.ms = ms;
      return slot.id;
    },
    clearInt: (/** @type {unknown} */ id) => cleared.push(id),
    slot,
    cleared,
    fire: () => slot.fn(),
  };
}

/** Let the loop get from startup to its parked wait. */
export const pump = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/** Start the loop with a readData that returns `seq` payloads in order (last one repeats). */
export async function start({ seq, out, input, ne, timers, now, signal, lines } = {}) {
  const o = out ?? makeOut();
  const i = input ?? makeInput();
  const n = ne ?? makeNextEvent();
  const t = timers ?? makeTimers();
  const c = { n: 0 };
  const readData = async () => {
    c.n += 1;
    const f = (seq && seq[c.n - 1]) || emptyUpTick;
    return f();
  };
  const p = runTop({
    out: o,
    input: i,
    readData,
    nextEvent: n,
    now: now ?? (() => NOW),
    setInterval: t.setInt,
    clearInterval: t.clearInt,
    ...(lines !== undefined ? { lines } : {}),
    ...(signal ? { signal } : {}),
  });
  await pump();
  return { p, out: o, input: i, ne: n, timers: t, reads: c, data: readData };
}
