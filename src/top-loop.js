// `agenthook top` live loop — keeps the terminal open and redraws the glance view (src/top.js
// `renderTop`) from the profile's event bus. Full mode (default) enters the alternate screen
// and hides the cursor; strip mode (`lines: N` — #796) instead repaints at most N lines in
// place on the normal screen (no alternate screen, no home/full-clear: cursor-up + erase-below
// between paints, a blank line and the cursor back on restore). It draws the first local-only
// tick, then waits in bounded rounds (at most TOP_WAIT_MS, the same
// pattern `watch --actionable` uses for liveness) on an injected `nextEvent` — event-driven,
// no polling. Each wake, and each no-event round (the round that notices the receiver going
// down or coming back: no event is ever written for either), re-reads the local state once via
// `readData` and redraws. Once per second it repaints from the CACHED data with a fresh clock
// (elapsed times advance; the repaint does no I/O). Terminal resizes redraw at the new size;
// `q`, Ctrl-C, SIGINT, SIGTERM or an aborted `signal` quit — the cursor and the main screen are
// restored exactly once, every listener is removed, and the loop resolves. Every side effect
// is injected (out/input/readData/nextEvent/clock/timers/signal); the only process contact is
// the SIGINT/SIGTERM handlers, the stderr error print and the `exit`-hook safety net.
import { renderTop, renderStrip } from "./top.js";

/** Max ms a no-event wait round runs before re-reading local state (bounded like watch's liveness round). */
export const TOP_WAIT_MS = 10_000;

/** Ms between the from-cache repaints that advance elapsed times. */
export const PAINT_MS = 1000;

/** Enter the alternate screen and hide the cursor. */
const ENTER = "\u001b[?1049h\u001b[?25l";

/** Show the cursor and leave the alternate screen. */
const RESTORE = "\u001b[?25h\u001b[?1049l";

/** Strip mode: hide the cursor on the normal screen (no alternate screen). */
const STRIP_ENTER = "\u001b[?25l";

/** Strip mode restore: show the cursor and drop a line so the strip stays in scrollback and the prompt lands below it. */
const STRIP_RESTORE = "\u001b[?25h\n";

/**
 * The live loop. `out` is the writable target (columns/rows + a `'resize'` event — a real
 * `process.stdout` or a fake); `input` the key stream (raw mode only when it is a TTY);
 * `readData()` the local-only tick payload (the caller keeps board/PR reads off);
 * `nextEvent(signal, timeoutMs)` the bounded event-bus wait — it must settle on an event, on
 * the timeout, or the moment `signal` aborts. Resolves `{ok:false}` after restoring the
 * terminal, printing the error to stderr and setting `process.exitCode = 1` when
 * `readData`/rendering throws; a clean quit resolves `{ok:true}` with exit code untouched.
 * @param {{
 *   out: {isTTY?: boolean, columns?: number, rows?: number, write: (s: string) => unknown, on: (e: string, f: (...a: Array<unknown>) => void) => unknown, removeListener: (e: string, f: (...a: Array<unknown>) => void) => unknown},
 *   input: {isTTY?: boolean, setRawMode?: (b: boolean) => void, on: (e: string, f: (...a: Array<unknown>) => void) => unknown, removeListener: (e: string, f: (...a: Array<unknown>) => void) => unknown, resume: () => unknown, pause?: () => unknown},
 *   readData: () => Promise<Parameters<typeof renderTop>[0]>,
 *   nextEvent: (signal: AbortSignal, timeoutMs: number) => Promise<unknown>,
 *   now?: () => number,
 *   setInterval?: (f: () => void, ms: number) => unknown,
 *   clearInterval?: (id: unknown) => void,
 *   signal?: AbortSignal,
 *   lines?: number,
 * }} o
 * @returns {Promise<{ok: boolean}>}
 */
export async function runTop(o) {
  const { out, input, readData, nextEvent } = o;
  const now = o.now ?? Date.now;
  const setInt = o.setInterval ?? globalThis.setInterval;
  const clearInt = o.clearInterval ?? globalThis.clearInterval;
  const color = !!out.isTTY && !process.env.NO_COLOR;

  /** Aborts the pending wait so a quit/error never leaves the loop parked in `nextEvent`. */
  const ac = new AbortController();
  let quitting = false;
  /** @type {Error|null} */
  let failed = null;
  /** @type {NodeJS.Timeout|string|number|null} */
  let interval = null;
  /** @type {Parameters<typeof renderTop>[0]|null} */
  let data = null;
  let restored = false;
  /** Strip mode (`lines` set): repaint in place on the normal screen — no alternate screen, no
   * home/full-clear. `prevH` is the height of the frame last written (0 before the first paint). */
  const strip = typeof o.lines === "number";
  const stripN = o.lines ?? 0;
  let prevH = 0;

  /** Show the cursor (+ leave the alternate screen in full mode) — once, even across the `exit` hook. */
  const restore = () => {
    if (restored) return;
    restored = true;
    if (input.isTTY && typeof input.setRawMode === "function") {
      try {
        input.setRawMode(false);
      } catch {
        /* already closed */
      }
    }
    out.write(strip ? STRIP_RESTORE : RESTORE);
  };

  /** The next paint. Full mode: home + clear + the renderer's lines, cut to the terminal's size.
   * Strip mode: the strip frame (padded to its height `h`), repainted in place — the first paint
   * writes it as is, each later one first moves back over the previous paint (`\r`, up `prevH-1`
   * lines, erase to end of screen). From cached data only. */
  const draw = () => {
    if (data === null) return;
    if (strip) {
      const h = Math.max(1, Math.min(stripN, out.rows || stripN));
      const frame = renderStrip(data, { lines: h, width: (out.columns || 80) - 1, now: now(), color });
      while (frame.length < h) frame.push("");
      if (prevH > 0) out.write("\r" + (prevH > 1 ? `\u001b[${prevH - 1}A` : "") + "\u001b[J");
      out.write(frame.join("\n"));
      prevH = h;
      return;
    }
    const lines = renderTop(data, { width: out.columns || 80, now: now(), color });
    out.write("\u001b[H\u001b[2J" + lines.slice(0, out.rows || 24).join("\n"));
  };

  const stop = () => {
    if (quitting || failed) return;
    quitting = true;
    ac.abort();
  };

  /** An error from a timer/resize callback — outside the main try — ends the loop. @param {Error} e */
  const die = (e) => {
    if (quitting || failed) return;
    failed = e;
    ac.abort();
  };

  /** @param {() => void} f a draw path that may throw (the repaint + resize callbacks) */
  const safe = (f) => {
    try {
      f();
    } catch (e) {
      die(e);
    }
  };

  /** Redraw at the new size; a throwing render ends the loop through the error path. */
  const onResize = () => safe(draw);

  /** @param {unknown} buf a key chunk (a Buffer from a raw TTY stream, or a string) */
  const onKey = (buf) => {
    const c = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
    for (const b of c) if (b === 0x71 || b === 0x03) {
      stop();
      return;
    }
  };

  if (o.signal) {
    if (o.signal.aborted) stop();
    else o.signal.addEventListener("abort", stop, { once: true });
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Last resort — restore even if the process dies before the finally runs (guarded by the
  // same once-flag, so it writes at most once).
  process.once("exit", restore);
  if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(true);
  input.on("data", onKey);
  input.resume();
  out.on("resize", onResize);

  let ok = true;
  try {
    out.write(strip ? STRIP_ENTER : ENTER);
    data = await readData();
    draw();
    interval = /** @type {NodeJS.Timeout|string|number} */ (setInt(() => safe(draw), PAINT_MS));
    while (!quitting && !failed && !(o.signal?.aborted)) {
      await nextEvent(ac.signal, TOP_WAIT_MS);
      if (quitting || failed || o.signal?.aborted) break;
      data = await readData();
      draw();
    }
  } catch (e) {
    failed = failed ?? e;
    ok = false;
  } finally {
    if (interval !== null) clearInt(interval);
    input.removeListener("data", onKey);
    // A resumed stdin keeps the event loop alive: pause it or the process never exits after a quit.
    if (typeof input.pause === "function") input.pause();
    out.removeListener("resize", onResize);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (o.signal) o.signal.removeEventListener("abort", stop);
    process.removeListener("exit", restore);
    if (failed) {
      restore();
      console.error(`agenthook top: ${String(failed?.message || failed)}`);
      process.exitCode = 1;
    } else {
      restore();
    }
  }
  return { ok };
}
