// `agenthook top` live loop — keeps the terminal open and redraws the glance view (src/top.js
// `renderTop`) from the profile's event bus. Full mode (default) enters the alternate screen
// and hides the cursor, and adds row selection over the selectable rows (`selectable`: the
// `>` prefix, a detail line for the selected row, `j`/`k`/arrows to move, `?` for the key
// help) and an Enter follow: on a running row it clears the screen and tails the injected
// `follow` (the production command tails that ref's run log, #797) until the user presses
// `q`/Ctrl-C (aborts only the follow) or it settles (one fresh `readData`, back to the
// dashboard); on any other row it shows the row's one-line hint (`hintLine`). Strip mode
// (`lines: N` — #796) instead repaints at most N lines in place on the normal screen (no
// alternate screen, no home/full-clear: cursor-up + erase-below between paints, a blank line
// and the cursor back on restore) and has no keys but `q`/Ctrl-C. It draws the first local-only
// tick, then waits in bounded rounds (at most TOP_WAIT_MS, the same
// pattern `watch --actionable` uses for liveness) on an injected `nextEvent` — event-driven,
// no polling. Each wake, and each no-event round (the round that notices the receiver going
// down or coming back: no event is ever written for either), re-reads the local state once via
// `readData` and redraws. Once per second it repaints from the CACHED data with a fresh clock
// (elapsed times advance; the repaint does no I/O). Terminal resizes redraw at the new size;
// `q`, Ctrl-C, SIGINT, SIGTERM or an aborted `signal` quit — the cursor and the main screen are
// restored exactly once, every listener is removed, and the loop resolves. Every side effect
// is injected (out/input/readData/nextEvent/clock/timers/signal/follow); the only process
// contact is the SIGINT/SIGTERM handlers, the stderr error print and the `exit`-hook safety net.
import { allLayout, cut, helpLines, hintLine, multiFrame, selectable, selectableAll, singleFrame, stripFrame } from "./top.js";

/** Max ms a no-event wait round runs before re-reading local state (bounded like watch's liveness round). */
export const TOP_WAIT_MS = 10_000;

/** Does the selectable row `r` (single- or multi-mode entry) match the selection key `k`? The
 * profile is part of the key only in multi mode (a single-mode key has no `profile`). */
/** @param {import('./top.js').SelectableEntry | (import('./top.js').SelectableEntry & {profile: string})} r @param {{profile?: string, ref: string, kind: string}} k */
function keyMatches(r, k) {
  if (r.kind !== k.kind || r.entry.ref !== k.ref) return false;
  return k.profile === undefined || ("profile" in r && r.profile === k.profile);
}

/** The row's profile state key — present on multi-mode entries only. @param {import('./top.js').SelectableEntry | (import('./top.js').SelectableEntry & {profile: string})} r */
function profileOf(r) {
  return "profile" in r ? r.profile : undefined;
}

/** Ms between the from-cache repaints that advance elapsed times. */
export const PAINT_MS = 1000;

/** Enter the alternate screen and hide the cursor. */
const ENTER = "\u001b[?1049h\u001b[?25l";

/** Show the cursor and leave the alternate screen. */
const RESTORE = "\u001b[?25h\u001b[?1049l";

/** Clear the alternate screen and home the cursor — the frame prefix every full-mode screen
 * shares through `draw`'s `paint`, one definition instead of the literal spelled out four
 * times. The follow banner (`startFollow`) keeps its own pre-existing order below it on
 * purpose: byte-identical to the opposite order would make its write indistinguishable from a
 * drawn frame to anything scanning the stream for this prefix (e.g. a test asserting no
 * dashboard frame was drawn while following) — same visible effect, kept separate. */
const CLEAR = "\u001b[H\u001b[2J";

/** Strip mode: hide the cursor on the normal screen (no alternate screen). */
const STRIP_ENTER = "\u001b[?25l";

/** Strip mode restore: show the cursor and drop a line so the strip stays in scrollback and the prompt lands below it. */
const STRIP_RESTORE = "\u001b[?25h\n";

/**
 * The live loop. `out` is the writable target (columns/rows + a `'resize'` event — a real
 * `process.stdout` or a fake); `input` the key stream (raw mode only when it is a TTY);
 * `readData()` the local-only tick payload (the caller keeps board/PR reads off) — one payload
 * per profile when `multi: true` (the multi-profile view, #798);
 * `nextEvent(signal, timeoutMs)` the bounded event-bus wait — it must settle on an event, on
 * the timeout, or the moment `signal` aborts. Resolves `{ok:false}` after restoring the
 * terminal, printing the error to stderr and setting `process.exitCode = 1` when
 * `readData`/rendering throws; a clean quit resolves `{ok:true}` with exit code untouched.
 * @param {{
 *   out: {isTTY?: boolean, columns?: number, rows?: number, write: (s: string) => unknown, on: (e: string, f: (...a: Array<unknown>) => void) => unknown, removeListener: (e: string, f: (...a: Array<unknown>) => void) => unknown},
 *   input: {isTTY?: boolean, setRawMode?: (b: boolean) => void, on: (e: string, f: (...a: Array<unknown>) => void) => unknown, removeListener: (e: string, f: (...a: Array<unknown>) => void) => unknown, resume: () => unknown, pause?: () => unknown},
 *   readData: () => Promise<Parameters<typeof import('./top.js').renderTop>[0] | Parameters<typeof import('./top.js').renderAll>[0]>,
 *   nextEvent: (signal: AbortSignal, timeoutMs: number) => Promise<unknown>,
 *   now?: () => number,
 *   setInterval?: (f: () => void, ms: number) => unknown,
 *   clearInterval?: (id: unknown) => void,
 *   signal?: AbortSignal,
 *   lines?: number,
 *   multi?: boolean,
 *   follow?: (ref: string, o: {signal: AbortSignal, write: (s: string) => unknown}, stateKey?: string) => Promise<void>,
 * }} o
 * @returns {Promise<{ok: boolean}>}
 */
export async function runTop(o) {
  const { out, input, readData, nextEvent } = o;
  const now = o.now ?? Date.now;
  const setInt = o.setInterval ?? globalThis.setInterval;
  const clearInt = o.clearInterval ?? globalThis.clearInterval;
  const color = !!out.isTTY && !process.env.NO_COLOR;
  /** Multi-profile mode (#798): `readData` returns one tick per profile and the frame is the
   * `renderAll` view (one block per profile) instead of `renderTop`'s single-profile view. */
  const multi = o.multi === true;

  /** Aborts the pending wait so a quit/error never leaves the loop parked in `nextEvent`. */
  const ac = new AbortController();
  let quitting = false;
  /** @type {Error|null} */
  let failed = null;
  /** @type {NodeJS.Timeout|string|number|null} */
  let interval = null;
  /** @type {Parameters<typeof import('./top.js').renderTop>[0] | Parameters<typeof import('./top.js').renderAll>[0] | null} */
  let data = null;
  let restored = false;
  /** Strip mode (`lines` set): repaint in place on the normal screen — no alternate screen, no
   * home/full-clear. `prevH` is the height of the frame last written (0 before the first paint). */
  const strip = typeof o.lines === "number";
  const stripN = o.lines ?? 0;
  let prevH = 0;
  /** Full mode only (#797, multi #798): the selected row, keyed by ref + kind (+ the profile
   * state key in multi mode, so the same ref in two profiles cannot collide) — rows may move
   * under it between reads. `selIdx` the last index it resolved to (clamped into the new row
   * count when the row vanished); -1 with no rows.
   * @type {{profile?: string, ref: string, kind: string}|null} */
  let selKey = null;
  let selIdx = -1;
  /** The shown hint line (Enter on a non-running row, or a follow error) — cleared by any move.
   * @type {string|null} */
  let hint = null;
  let showHelp = false;

  /** The cached tick as a single-profile payload (single-mode call sites; `data` is non-null there). */
  const tickData = () =>
    /** @type {Parameters<typeof import('./top.js').renderTop>[0]} */ (data);
  /** The cached ticks as the multi-profile payload (multi-mode call sites; `data` is non-null there). */
  const tickAll = () =>
    /** @type {Parameters<typeof import('./top.js').renderAll>[0]} */ (data);
  /** The number of always-visible bottom lines under the multi full-mode frame: the detail line
   * (the selection exists when the frame is built) + the hint + the (single) help line. */
  const bottomN = () => 1 + (hint ? 1 : 0) + (showHelp ? helpLines().length : 0);
  /** The multi frame's layout at the current terminal size — `draw` and the selection share it,
   * so the selectable rows always match what is on screen. */
  const frameLayout = () => {
    const ticks = tickAll();
    if (strip) return allLayout(ticks, { strip: true, height: Math.max(1, Math.min(stripN, out.rows || stripN)) });
    return allLayout(ticks, { height: Math.max(0, (out.rows || 24) - bottomN()) });
  };
  /** True while a follow (Enter on a running row) owns the screen — no dashboard draws. */
  let following = false;
  /** @type {AbortController|null} aborts only the current follow */
  let followAc = null;
  /** Tail writer while following (the injected `follow`'s `write`). @param {string} s */
  const followWrite = (s) => out.write(s);

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

  /** Write a full-mode frame: home + clear + the lines. One definition, shared by every
   * full-mode screen, so a clear-and-write is never spelled out twice. @param {string[]} lines */
  const paint = (lines) => out.write(CLEAR + lines.join("\n"));

  /** The next paint. Full mode: picks the screen's pure builder (`top.js` `singleFrame` /
   * `multiFrame`) and paints it — header, the selectable rows (the selected one `> `-marked,
   * scrolled just enough to keep it on screen), the queued line, the detail line, the hint
   * (when shown) and the key help (when toggled); the bottom lines stay visible and the whole
   * thing is cut to the terminal's size. No rows (or a down receiver) falls back to the plain
   * `renderTop` lines. Nothing draws while a follow owns the screen. Strip mode: the strip
   * frame (`top.js` `stripFrame`, padded to its height `h`), repainted in place — the first
   * paint writes it as is, each later one first moves back over the previous paint (`\r`, up
   * `prevH-1` lines, erase to end of screen). From cached data only. */
  const draw = () => {
    if (data === null || following) return;
    if (strip) {
      const h = Math.max(1, Math.min(stripN, out.rows || stripN));
      const frame = stripFrame(multi ? tickAll() : tickData(), { multi, height: h, width: (out.columns || 80) - 1, now: now(), color });
      if (prevH > 0) out.write("\r" + (prevH > 1 ? `\u001b[${prevH - 1}A` : "") + "\u001b[J");
      out.write(frame.join("\n"));
      prevH = h;
      return;
    }
    const width = out.columns || 80;
    const rowsH = out.rows || 24;
    const lines = multi
      ? multiFrame(tickAll(), { selected: selIdx, layout: frameLayout(), hint, showHelp, width, rows: rowsH, now: now(), color })
      : singleFrame(tickData(), { selected: selIdx, hint, showHelp, width, rows: rowsH, now: now(), color });
    paint(lines);
  };

  /** The selectable rows for the current mode — needs-you then running, over `selectableAll`
   * (multi) or `selectable` (single); shared by resync, move and act so the three never drift. */
  const selectableRows = () => (multi ? selectableAll(frameLayout()) : selectable(tickData()));

  /** Set the selection to `rows[idx]`: `selIdx` plus `selKey` (ref + kind + the profile state
   * key in multi mode) so the row can be re-found after the next read.
   * @param {ReturnType<typeof selectableRows>} rows @param {number} idx */
  const selectAt = (rows, idx) => {
    selIdx = idx;
    const found = /** @type {{kind: string, entry: {ref: string}, profile?: string}} */ (rows[idx]);
    selKey = { ref: found.entry.ref, kind: found.kind, ...(found.profile !== undefined ? { profile: found.profile } : {}) };
  };

  /** Re-find the selected row in a fresh tick: it survives as long as its ref + kind (+ profile
   * in multi mode) are still present (even when rows above it appear or disappear); a vanished
   * row clamps the old index into the new range, and no rows drops the selection (and with it
   * the detail line). */
  const resyncSelection = () => {
    if (!data) return;
    const rows = selectableRows();
    if (!rows.length) {
      selKey = null;
      selIdx = -1;
      return;
    }
    let idx = -1;
    const k = selKey;
    if (k) idx = rows.findIndex((r) => keyMatches(r, k));
    if (idx === -1) idx = Math.max(0, Math.min(selIdx, rows.length - 1));
    selectAt(rows, idx);
  };

  /** Move the selection by `d` (±1), clamped at both ends (no wrap). Clears any shown hint.
   * Multi mode moves across profile boundaries over `selectableAll`. @param {number} d */
  const move = (d) => {
    if (strip || following || !data) return;
    const rows = selectableRows();
    if (!rows.length) return;
    let idx = -1;
    const k = selKey;
    if (k) idx = rows.findIndex((r) => keyMatches(r, k));
    if (idx === -1) idx = Math.max(0, selIdx);
    idx = Math.max(0, Math.min(rows.length - 1, idx + d));
    selectAt(rows, idx);
    hint = null;
    safe(draw);
  };

  /** Enter on the selected row: a running row follows (the injected `follow` — the dashboard
   * pauses for it; in multi mode the row's profile state key goes as the third argument), any
   * other row shows its hint line and nothing else. */
  const act = () => {
    if (strip || following || !data || selIdx < 0) return;
    const sel = selectableRows()[selIdx];
    if (!sel) return;
    if (sel.kind !== "running") {
      hint = hintLine(sel, { width: out.columns || 80 });
      safe(draw);
      return;
    }
    if (typeof o.follow !== "function") return;
    /** @type {string} */
    const ref = sel.entry.ref;
    /** @type {string|undefined} */
    const step = sel.entry.step;
    safe(() => {
      startFollow(ref, step, profileOf(sel));
    });
  };

  /** Read a fresh tick, resync the selection onto it and redraw — the three steps every poll
   * round (and the follow settle) runs in sequence. Callers keep their own error handling: this
   * throws straight through on a `readData`/render failure. */
  const refresh = async () => {
    data = await readData();
    resyncSelection();
    draw();
  };

  /** The follow (full mode): clear the screen, the banner, then the injected `follow`'s tail.
   * While it runs the dashboard draws are suppressed; `q`/Ctrl-C aborts only this follow. On
   * settle (resolve, abort or error) the data is re-read once and the dashboard redrawn — an
   * error shows as the hint line and top keeps running. Quitting/SIGINT during it is handled
   * by `stop` aborting this controller too.
   * @param {string} ref @param {string|undefined} step @param {string|undefined} stateKey the row's profile (multi mode)
   */
  const startFollow = async (ref, step, stateKey) => {
    following = true;
    followAc = new AbortController();
    try {
      // the trailing newline is on purpose: the first tail line would otherwise land on the banner's line
      // opposite byte order from CLEAR — see its comment
      out.write("\u001b[2J\u001b[H" + (step ? `following ${ref} ${step} — q/Ctrl-C back to top\n` : `following ${ref} — q/Ctrl-C back to top\n`));
      await o.follow?.(ref, { signal: followAc.signal, write: followWrite }, stateKey);
    } catch (e) {
      // indented and cut like a hint line: a long message (e.g. an fs error with a path)
      // must not push the frame past `out.rows`
      if (!quitting && !failed) hint = cut(`  ${String(e?.message || e)}`, out.columns || 80);
    } finally {
      following = false;
      followAc = null;
      if (!quitting && !failed) {
        try {
          await refresh();
        } catch (e) {
          die(e);
        }
      }
    }
  };

  const stop = () => {
    if (quitting || failed) return;
    quitting = true;
    ac.abort();
    if (followAc) followAc.abort();
  };

  /** An error from a timer/resize callback — outside the main try — ends the loop. @param {Error} e */
  const die = (e) => {
    if (quitting || failed) return;
    failed = e;
    ac.abort();
    if (followAc) followAc.abort();
  };

  /** @param {() => void} f a draw path that may throw (the repaint + resize callbacks) */
  const safe = (f) => {
    try {
      f();
    } catch (e) {
      die(e);
    }
  };

  /** Redraw at the new size; a throwing render ends the loop through the error path. In multi
   * mode the shown rows depend on the terminal size (the fit rules), so the selection is
   * re-clamped to a visible row before the redraw. */
  const onResize = () => safe(() => {
    if (multi) resyncSelection();
    draw();
  });

  /** @param {unknown} buf a key chunk (a Buffer from a raw TTY stream, or a string). `q`/Ctrl-C
   * quit (or, while a follow owns the screen, abort only the follow). Full mode adds `j`/`k`,
   * the arrows (`ESC [ A/B`), Enter and the `?` help toggle; strip mode has none of those. */
  const onKey = (buf) => {
    const c = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
    let i = 0;
    while (i < c.length) {
      const b = c[i];
      if (b === 0x1b && c[i + 1] === 0x5b) { // ESC [ … — only the arrows are acted on
        const seq = c[i + 2];
        if (seq === 0x41) move(-1); // up
        else if (seq === 0x42) move(1); // down
        i += 3;
        continue;
      }
      i += 1;
      if (b === 0x71 || b === 0x03) {
        if (following) followAc?.abort();
        else stop();
        return;
      }
      if (strip || following) continue;
      if (b === 0x6a) move(1); // j
      else if (b === 0x6b) move(-1); // k
      else if (b === 0x0d || b === 0x0a) act(); // Enter (CR or LF)
      else if (b === 0x3f) {
        showHelp = !showHelp;
        // the help lines change the multi frame's height — re-clamp the selection to a visible row
        if (multi) resyncSelection();
        safe(draw);
      }
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
    await refresh(); // the first draw selects index 0 when there are rows
    interval = /** @type {NodeJS.Timeout|string|number} */ (setInt(() => safe(draw), PAINT_MS));
    while (!quitting && !failed && !(o.signal?.aborted)) {
      await nextEvent(ac.signal, TOP_WAIT_MS);
      if (quitting || failed || o.signal?.aborted) break;
      await refresh();
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
