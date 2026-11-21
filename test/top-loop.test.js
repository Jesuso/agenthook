import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { runTop, TOP_WAIT_MS, PAINT_MS } from "../src/top-loop.js";
import { topReadData } from "../src/commands/top.js";
import { registryDir } from "../src/config.js";

const ENTER = "\u001b[?1049h\u001b[?25l";
const RESTORE = "\u001b[?25h\u001b[?1049l";
const FRAME = "\u001b[H\u001b[2J";

const NOW = Date.parse("2025-06-01T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

/** A tick the renderer can draw: up, one held row. */
const heldTick = () => ({
  profile: "dev",
  up: true,
  slots: { max: 4, active: 1, queued: 2 },
  held: [{ id: "AH-12", ref: "h1", step: "review", title: "Waiting on the design answer", since: iso(NOW - 5 * 60e3) }],
  running: [{ ref: "r1", step: "code", ageS: 300 }],
  events: [],
  cursor: 0,
});

const emptyUpTick = () => ({ profile: "dev", up: true, slots: { max: 4, active: 0, queued: 0 }, running: [], held: [], events: [], cursor: 0 });
const downTick = () => ({ profile: "dev", up: false, slots: { max: 4, active: 0, queued: 0 }, running: [], held: [], events: [], cursor: 0 });

/** @param {string} s */
const visible = (s) => [...s.replace(/\u001b\[[0-9;?]*m/g, "")];

/** A fake terminal: records every write, exposes columns/rows, emits 'resize'. */
function makeOut({ columns = 60, rows = 20, isTTY = true } = {}) {
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
    frames: () => buf.split(FRAME).slice(1), // one entry per drawn frame
    on: (/** @type {string} */ e, /** @type {Function} */ f) => ee.on(e, f),
    removeListener: (/** @type {string} */ e, /** @type {Function} */ f) => ee.removeListener(e, f),
    listenerCount: (/** @type {string} */ e) => ee.listenerCount(e),
    emitResize: () => ee.emit("resize"),
  };
}

/** A fake key stream (not a TTY — no raw mode). */
function makeInput() {
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
function makeNextEvent() {
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
function makeTimers() {
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
const pump = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/** Start the loop with a readData that returns `seq` payloads in order (last one repeats). */
async function start({ seq, out, input, ne, timers, now, signal } = {}) {
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
    ...(signal ? { signal } : {}),
  });
  await pump();
  return { p, out: o, input: i, ne: n, timers: t, reads: c, data: readData };
}

test("top-loop: constants — the wait round is bounded (~10 s) and the repaint is 1 s", () => {
  assert.ok(TOP_WAIT_MS >= 5_000 && TOP_WAIT_MS <= 15_000, `TOP_WAIT_MS=${TOP_WAIT_MS}`);
  assert.equal(PAINT_MS, 1000);
});

test("top-loop: start — enters the alternate screen, hides the cursor, draws the first tick, then waits", async () => {
  const s = await start({ seq: [heldTick] });
  const early = await Promise.race([s.p, new Promise((res) => setTimeout(() => res("still"), 50))]);
  assert.equal(early, "still", "the loop is still running (parked in the wait)");
  const buf = s.out.text();
  assert.ok(buf.startsWith(ENTER), "alternate screen + hidden cursor first");
  assert.equal(s.out.frames().length, 1, "one frame drawn at start");
  const frame = s.out.frames()[0].split("\n");
  assert.equal(visible(frame[0]).join(""), "dev up · agents 1/4 · 2 queued · 1 needs you");
  assert.match(visible(frame[1]).join(""), /^\s*HELD AH-12 review 5m/);
  assert.equal(s.ne.calls.length, 1, "parked in the event-bus wait");
  assert.equal(s.ne.calls[0].ms, TOP_WAIT_MS, "the wait round is bounded");
  assert.equal(s.timers.slot.ms, PAINT_MS);
  // quit so the process can exit
  s.input.key(0x71);
  await s.p;
});

test("top-loop: a bus event — readData is called again and the new payload is drawn", async () => {
  const s = await start({ seq: [emptyUpTick, heldTick] });
  assert.ok(!s.out.frames().at(-1).includes("HELD"), "first frame has no held row");
  s.ne.wake(false); // an event landed
  await pump();
  assert.equal(s.reads.n, 2, "the event re-read the data");
  const frame = s.out.frames().at(-1).split("\n");
  assert.ok(frame.some((l) => visible(l).join("").includes("HELD AH-12 review 5m")), "the redrawn frame shows the new row");
  assert.equal(s.ne.calls.length, 2, "back in the wait for the next event");
  s.input.key(0x71);
  await s.p;
});

test("top-loop: the 1 s repaint — N fires write N frames from cached data, no readData, no nextEvent", async () => {
  const s = await start({ seq: [heldTick] });
  const before = { reads: s.reads.n, waits: s.ne.calls.length, frames: s.out.frames().length };
  for (let i = 0; i < 4; i++) s.timers.fire();
  await pump();
  assert.equal(s.out.frames().length, before.frames + 4, "each timer fire is one repaint");
  assert.equal(s.reads.n, before.reads, "the repaint never re-reads");
  assert.equal(s.ne.calls.length, before.waits, "the repaint never touches the bus");
  // a fresh now() advances the elapsed time in the repaint
  let t = NOW;
  const s2 = await start({ seq: [heldTick], now: () => (t += 60_000) });
  assert.ok(s2.out.frames().at(-1).split("\n").some((l) => visible(l).join("").includes("HELD AH-12 review 6m")), "first draw uses the fresh clock");
  s2.timers.fire();
  await pump();
  assert.ok(s2.out.frames().at(-1).split("\n").some((l) => visible(l).join("").includes("HELD AH-12 review 7m")), "the repaint recomputes elapsed time from the fresh clock");
  s2.input.key(0x71);
  await s2.p;
  s.input.key(0x71);
  await s.p;
});

test("top-loop: resize — the next frame has no visible line longer than the new width", async () => {
  const s = await start({ seq: [heldTick] });
  s.out.columns = 30;
  s.out.emitResize();
  await pump();
  const frame = s.out.frames().at(-1);
  assert.ok(frame, "resize drew a frame");
  for (const l of frame.split("\n")) assert.ok(visible(l).length <= 30, `line too long: ${l}`);
  s.input.key(0x71);
  await s.p;
});

/** A fake AbortSignal that tracks its abort listeners (AbortSignal itself does not expose a count). */
class FakeSignal {
  constructor() {
    this.aborted = false;
    this.listeners = new Set();
  }
  addEventListener(_ev, f) {
    this.listeners.add(f);
  }
  removeEventListener(_ev, f) {
    this.listeners.delete(f);
  }
  abort() {
    this.aborted = true;
    for (const f of [...this.listeners]) f();
  }
}

test("top-loop: quit on q, Ctrl-C, SIGINT, SIGTERM and signal abort — restore once, input paused, listeners and interval removed", async () => {
  const sigintBefore = process.listenerCount("SIGINT");
  const sigtermBefore = process.listenerCount("SIGTERM");
  const cases = [
    ["q key", async (s, /** @type {any} */ sig) => s.input.key(0x71)],
    ["Ctrl-C byte", async (s, /** @type {any} */ sig) => s.input.key(0x03)],
    ["SIGINT", async (s, /** @type {any} */ sig) => process.emit("SIGINT")],
    ["SIGTERM", async (s, /** @type {any} */ sig) => process.emit("SIGTERM")],
    ["signal abort", async (s, /** @type {any} */ sig) => sig.abort()],
  ];
  for (const [name, fire] of cases) {
    const sig = new FakeSignal();
    const s = await start({ seq: [heldTick], signal: sig });
    await fire(s, sig);
    await s.p;
    const buf = s.out.text();
    assert.equal(buf.split(RESTORE).length - 1, 1, `${name}: the restore sequence is written exactly once`);
    assert.equal(s.input.listenerCount("data"), 0, `${name}: key listener removed`);
    assert.equal(s.input.calls.pause, 1, `${name}: the input stream was paused (a resumed stdin keeps the process alive)`);
    assert.equal(s.out.listenerCount("resize"), 0, `${name}: resize listener removed`);
    assert.equal(process.listenerCount("SIGINT"), sigintBefore, `${name}: SIGINT handler removed`);
    assert.equal(process.listenerCount("SIGTERM"), sigtermBefore, `${name}: SIGTERM handler removed`);
    assert.deepEqual(s.timers.cleared, ["I1"], `${name}: the interval was cleared`);
    assert.equal(sig.listeners.size, 0, `${name}: the abort listener was removed`);
  }
});

test("top-loop: readData throwing — restore first, error to stderr, exit code 1, no hang", async () => {
  const out = makeOut();
  const input = makeInput();
  const ne = makeNextEvent();
  const timers = makeTimers();
  const errors = [];
  const orig = console.error;
  let sawRestoreBefore = null;
  console.error = (...a) => {
    sawRestoreBefore = out.text().includes(RESTORE);
    errors.push(a.join(" "));
  };
  const prevCode = process.exitCode;
  try {
    const p = runTop({
      out,
      input,
      readData: async () => {
        throw new Error("state dir unreadable");
      },
      nextEvent: ne,
      setInterval: timers.setInt,
      clearInterval: timers.clearInt,
    });
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res("HANG"), 200))]);
    assert.notEqual(r, "HANG", "the loop does not hang on a readData error");
    assert.equal(r.ok, false);
    assert.equal(sawRestoreBefore, true, "the terminal was restored before the error came out");
    assert.equal(ne.calls.length, 0, "the error happened before the first wait");
    assert.equal(out.text().split(RESTORE).length - 1, 1);
    assert.equal(input.calls.pause, 1, "the error path pauses the input too");
    assert.ok(errors.some((e) => e.includes("state dir unreadable")), `stderr got the error: ${errors}`);
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = orig;
    process.exitCode = prevCode ?? 0;
  }
});

test("top-loop: a no-event round — exactly one readData, and a down receiver renders 'down' without crashing", async () => {
  const s = await start({ seq: [emptyUpTick, downTick] });
  assert.match(visible(s.out.frames().at(-1).split("\n")[0]).join(""), /dev up/);
  s.ne.wake(true); // the round timed out with no event
  await pump();
  assert.equal(s.reads.n, 2, "the timeout round re-read local state exactly once");
  const header = visible(s.out.frames().at(-1).split("\n")[0]).join("");
  assert.match(header, /dev down/, `the down receiver renders down in the header: ${header}`);
  assert.equal(s.ne.calls.length, 2, "still alive, waiting again");
  s.input.key(0x71);
  await s.p;
});

test("top-loop: draw never throws a frame past the terminal height", async () => {
  const out = makeOut({ rows: 3 });
  const many = () => ({
    profile: "dev",
    up: true,
    slots: { max: 4, active: 4, queued: 9 },
    held: Array.from({ length: 12 }, (_, i) => ({ id: `AH-${i}`, step: "review", since: iso(NOW - i * 60e3) })),
    running: Array.from({ length: 6 }, (_, i) => ({ ref: `r${i}`, step: "code", ageS: 60 * i })),
    events: [],
    cursor: 0,
  });
  const s = await start({ seq: [many], out });
  await pump();
  const lines = s.out.frames().at(-1).split("\n");
  assert.ok(lines.length <= 3, `cut to out.rows lines: ${lines.length}`);
  s.input.key(0x71);
  await s.p;
});

test("top: the process exits by itself within 2 s of q — real runTop, piped stdin", async (t) => {
  // The #795 rework repro without a pty: the real loop with piped stdin as the input. A
  // resumed stdin keeps the event loop alive, so on the broken quit path this child hangs
  // and the 2 s deadline below fails it. One profile in a fresh registry root: it is the
  // only up profile, so the helper's name-less pick resolves it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-topexit-home-"));
  const dir = path.join(home, "topexit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name: "topexit", maxConcurrent: 2, tracker: "github" }));
  fs.writeFileSync(path.join(dir, "server.pid"), String(process.pid));
  const prevHome = process.env.AGENTHOOK_HOME;
  process.env.AGENTHOOK_HOME = home;
  try {
    const helper = path.join(path.dirname(new URL(import.meta.url).pathname), "_top-exit-helper.js");
    const child = spawn(process.execPath, [helper], { stdio: ["pipe", "pipe", "pipe"] });
    let seen = "";
    child.stdout.on("data", (d) => {
      seen += String(d);
    });
    const t0 = Date.now();
    while (!seen.includes(ENTER) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    assert.ok(seen.includes(ENTER), "the child entered the alternate screen");
    child.stdin.write("q");
    const code = await new Promise((resolve) => {
      const to = setTimeout(() => resolve("TIMEOUT"), 2000);
      child.on("close", (c) => {
        clearTimeout(to);
        resolve(c);
      });
    });
    if (code !== 0) child.kill("SIGKILL");
    assert.equal(code, 0, `the child exited by itself with 0, got: ${code}`);
    assert.ok(seen.includes(RESTORE), "the child wrote the restore sequence before exiting");
  } finally {
    process.env.AGENTHOOK_HOME = prevHome;
  }
});

test("topReadData: the loop's data source is local-only — an up receiver gets no board/PR live read", async () => {
  // A live profile (this process's pid in server.pid) with no control socket: if board/prs
  // were requested, readTick would catch the live() failures as boardError/prsError.
  const dir = path.join(registryDir, "topnolive");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name: "topnolive", maxConcurrent: 2, tracker: "github" }));
  fs.writeFileSync(path.join(dir, "server.pid"), String(process.pid));
  const t = await topReadData("topnolive", null);
  assert.equal(t.profile, "topnolive");
  assert.equal(t.up, true);
  assert.ok(!("board" in t) && !("boardError" in t), "no board read and no board error — live('board') was never attempted");
  assert.ok(!("prs" in t) && !("prsError" in t), "no PR read and no PR error — live('prs') was never attempted");
});
