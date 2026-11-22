import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderTop, selectable, detailLine, hintLine, helpLines } from "../src/top.js";
import { tailFile } from "../src/commands/follow.js";
import { NOW, iso, emptyUpTick, visible, makeOut, makeInput, makeNextEvent, makeTimers, pump, start } from "./_top-helpers.js";

/** Show the cursor + leave the alternate screen (what the loop writes on restore). */
const RESTORE = "\u001b[?25h\u001b[?1049l";

/** A tick with one of every selectable kind (held → failed → PR → running, the selectable order). */
const selTick = () => ({
  profile: "dev",
  up: true,
  slots: { max: 4, active: 1, queued: 2 },
  held: [{ id: "AH-12", ref: "h1", step: "review", title: "Waiting", since: iso(NOW - 5 * 60e3) }],
  failed: [{ id: "AH-13", ref: "f1", step: "code", title: "It broke", at: iso(NOW - 60e3) }],
  prWaiting: [{ id: "AH-14", ref: "p1", pr: "https://gh/pull/1", at: iso(NOW - 60e3) }],
  running: [{ ref: "r1", step: "code", title: "Building", ageS: 30, harness: "claude", model: "opus" }],
});

const UP = (over = {}) => ({ profile: "dev", up: true, slots: { max: 4, active: 0, queued: 0 }, running: [], held: [], ...over });

// ---------------------------------------------------------------- the pure renderer

test("top: selectable — needs-you (held → failed → PR) then running, header/queued not selectable", () => {
  const sel = selectable(selTick());
  assert.deepEqual(
    sel.map((s) => [s.kind, s.entry.ref]),
    [
      ["held", "h1"],
      ["failed", "f1"],
      ["pr", "p1"],
      ["running", "r1"],
    ],
  );
  assert.deepEqual(selectable(emptyUpTick()), []);
});

test("top: renderTop without selected is the plain indent; with selected the marked row gets '>', the rest keep two spaces", () => {
  const plain = renderTop(selTick());
  assert.equal(plain.length, 6, "header + 4 rows + queued line");
  assert.ok(plain.slice(1, 5).every((l) => l.startsWith("  ")), "every row is two-space indented");
  const sel = renderTop(selTick(), { selected: 3 });
  assert.ok(sel[4].startsWith("> "), "the selected row (running) starts with '> '");
  assert.ok(sel.slice(1, 4).every((l) => l.startsWith("  ")), "the other rows keep the two-space indent");
  assert.equal(sel[0], plain[0], "the header is untouched");
  assert.equal(sel[5], plain[5], "the queued line is untouched");
  const color = renderTop(selTick(), { selected: 0, color: true });
  assert.ok(color[1].includes("\u001b[7m") && color[1].includes("\u001b[27m"), "with color the selected row is inverse video");
});

test("top: rows never show harness/model (the glance rule) — they only appear on the detail line", () => {
  const t = selTick();
  for (const l of renderTop(t, { selected: 3 })) assert.ok(!l.includes("claude") && !l.includes("opus"), `harness/model leaked into a row: ${l}`);
  assert.equal(detailLine(t, 3), "  r1 · code · harness claude · model opus · Building");
});

test("top: detailLine — id/ref, step, title; harness/model only for running (each part left out when absent); no cost/ctx/reason", () => {
  const t = selTick();
  assert.equal(detailLine(t, 0), "  AH-12 · review · Waiting");
  assert.equal(detailLine(t, 1), "  AH-13 · code · It broke");
  assert.equal(detailLine(t, 2), "  AH-14"); // the PR entry has no step and no title
  const noHarness = UP({ running: [{ ref: "r2", step: "code", ageS: 5 }] });
  assert.equal(detailLine(noHarness, 0), "  r2 · code", "absent harness/model are left out");
  assert.equal(detailLine(UP({ running: [{ ref: "r3", step: "code", ageS: 5, harness: "claude" }] }), 0), "  r3 · code · harness claude", "absent model is left out");
  const cut = detailLine(t, 3, { width: 20 });
  assert.equal([...visible(cut)].length, 20, "the detail line is cut to width");
  assert.ok(cut.endsWith("…"));
  assert.equal(detailLine(t, 99), "", "an out-of-range index gives no detail line");
});

test("top: hintLine — the per-kind hints name only commands that exist; running returns ''", () => {
  const [held, failed, pr] = selectable(selTick());
  assert.equal(hintLine(held), '  held — reply "@agent <answer>" on the ticket, or release it in agenthook ui');
  assert.equal(hintLine(failed, { width: 120 }), "  failed at code — retry: agenthook run AH-13 code --force (or Retry in agenthook ui)");
  assert.equal(hintLine(pr, { width: 120 }), "  PR awaiting you — https://gh/pull/1 · agenthook recheck AH-14 if it already merged/closed");
  const noPr = UP({ prWaiting: [{ ref: "p9", at: iso(NOW - 60e3) }] });
  assert.equal(hintLine(selectable(noPr)[0]), "  PR awaiting you — agenthook recheck p9 if it already merged/closed", "no URL, the ref is named");
  assert.equal(hintLine({ kind: "running", entry: { ref: "r1" } }), "");
  assert.equal([...visible(hintLine(failed, { width: 24 }))].length, 24, "the hint is cut to width");
});

test("top: helpLines — the short fixed key help", () => {
  assert.deepEqual(helpLines(), ["  j/k ↑/↓ move · Enter follow (running) / hint · ? help · q quit"]);
});

// ---------------------------------------------------------------- the live loop

/** A controllable fake follow: records its calls, writes two tail lines, settles on its
 * signal's abort or `resolve()` (a run_end). */
function makeFollow() {
  const calls = [];
  /** @type {(() => void)|null} */
  let resolveFn = null;
  const fn = async (ref, { signal, write }) => {
    calls.push({ ref, signal });
    write("line-one\n");
    write("line-two\n");
    await new Promise((res) => {
      if (signal.aborted) return res();
      resolveFn = res;
      signal.addEventListener("abort", res, { once: true });
    });
    resolveFn = null;
  };
  fn.calls = calls;
  fn.resolve = () => resolveFn && resolveFn();
  return fn;
}

const lastFrame = (s) => visible(s.out.frames().at(-1) ?? "").join("");

test("top-loop: j/k and the arrows move the selection, clamped at both ends (no wrap)", async () => {
  const s = await start({ seq: [() => UP({ held: [{ id: "AH-1", ref: "h1", since: iso(NOW - 60e3) }], running: [{ ref: "r1", step: "code", ageS: 30 }] })] });
  assert.ok(lastFrame(s).includes("> HELD AH-1"), "the first draw selects index 0");
  s.input.key(0x6a); // j
  await pump();
  assert.ok(lastFrame(s).includes("> RUN r1"), "j moves down");
  s.input.key(0x6a);
  await pump();
  assert.ok(lastFrame(s).includes("> RUN r1"), "j on the last row is a no-op (no wrap)");
  s.input.bytes([0x1b, 0x5b, 0x41]); // up arrow
  await pump();
  assert.ok(lastFrame(s).includes("> HELD AH-1"), "the up arrow moves up");
  s.input.bytes([0x1b, 0x5b, 0x41]);
  await pump();
  assert.ok(lastFrame(s).includes("> HELD AH-1"), "up on the first row is a no-op (no wrap)");
  s.input.key(0x6b); // k on the first row: a no-op too
  await pump();
  assert.ok(lastFrame(s).includes("> HELD AH-1"));
  s.input.key(0x71);
  await s.p;
});

test("top-loop: the selection follows its ref across redraws; a vanished row clamps; no rows drops the selection", async () => {
  const tA = () => UP({ held: [{ id: "AH-1", ref: "h1", step: "review", since: iso(NOW - 60e3) }], running: [{ ref: "r1", step: "code", ageS: 30 }] });
  const tB = () => UP({ held: [{ id: "AH-2", ref: "h2", since: iso(NOW - 60e3) }, { id: "AH-1", ref: "h1", step: "review", since: iso(NOW - 60e3) }], running: [{ ref: "r1", step: "code", ageS: 30 }] });
  const s = await start({ seq: [tA, tB, () => UP({ held: [{ id: "AH-1", ref: "h1", step: "review", since: iso(NOW - 60e3) }] })], now: () => NOW });
  s.input.key(0x6a); // select the running row (index 1)
  await pump();
  assert.ok(lastFrame(s).includes("> RUN r1"));
  s.ne.wake(false); // redraw: a row appeared above
  await pump();
  assert.ok(lastFrame(s).includes("> RUN r1"), "the selection survived a row appearing above it");
  assert.ok(lastFrame(s).includes("  r1 · code"), "the detail line follows it");
  s.ne.wake(true); // redraw: the running row vanished
  await pump();
  assert.ok(lastFrame(s).includes("> HELD AH-1"), "the vanished selection clamped to the only remaining row");
  const s2 = await start({ seq: [tA, emptyUpTick], now: () => NOW });
  s2.input.key(0x6a);
  await pump();
  s2.ne.wake(true); // redraw: no rows at all
  await pump();
  const frame = lastFrame(s2);
  assert.equal(frame.split("\n").length, 1, "no rows — the frame is the header alone");
  assert.ok(!frame.includes("> "), "no rows — no selection");
  assert.ok(!frame.includes("AH-1"), "no rows — no detail line");
  s.input.key(0x71);
  s2.input.key(0x71);
  await s.p;
  await s2.p;
});

test("top-loop: Enter on a non-running row shows the hint; the follow and readData are not called because of it", async () => {
  const follow = makeFollow();
  const s = await start({ seq: [selTick, selTick], follow, out: makeOut({ columns: 120 }) });
  s.input.key(0x0d); // Enter on the held row (index 0)
  await pump();
  const frame = lastFrame(s);
  assert.ok(frame.includes('held — reply "@agent <answer>" on the ticket, or release it in agenthook ui'), "the held hint line");
  assert.ok(frame.includes("  AH-12 · review · Waiting"), "the detail line stays above it");
  assert.equal(follow.calls.length, 0, "the follow was not called");
  assert.equal(s.reads.n, 1, "Enter does not re-read");
  s.input.key(0x6a); // move to failed
  await pump();
  assert.ok(!lastFrame(s).includes("release it"), "a move clears the shown hint");
  s.input.key(0x0d);
  await pump();
  assert.ok(lastFrame(s).includes("failed at code — retry: agenthook run AH-13 code --force"), "the failed hint line");
  s.input.key(0x6a); // move to the PR row
  await pump();
  s.input.key(0x0d);
  await pump();
  assert.ok(lastFrame(s).includes("PR awaiting you — https://gh/pull/1 · agenthook recheck AH-14"), "the PR hint line names the URL");
  assert.equal(follow.calls.length, 0);
  s.input.key(0x71);
  await s.p;
});

test("top-loop: Enter on a running row follows it; the dashboard is frozen while it runs; q brings it back with one fresh read", async () => {
  const follow = makeFollow();
  const s = await start({ seq: [selTick], follow });
  s.input.key(0x6a);
  s.input.key(0x6a);
  s.input.key(0x6a); // down to the running row
  await pump();
  assert.ok(lastFrame(s).includes("> RUN r1"));
  const framesBefore = s.out.frames().length;
  s.input.key(0x0d); // Enter
  await pump();
  assert.equal(follow.calls.length, 1, "the injected follow was called");
  assert.equal(follow.calls[0].ref, "r1");
  const buf = s.out.text();
  assert.ok(buf.includes("following r1 code — q/Ctrl-C back to top"), "the one-line banner");
  assert.ok(buf.includes("line-one") && buf.includes("line-two"), "the follow's tail was written");
  // nothing draws the dashboard while the follow owns the screen
  s.timers.fire();
  await pump();
  s.ne.wake(false); // a bus event
  await pump();
  s.out.emitResize();
  await pump();
  assert.equal(s.out.frames().length, framesBefore, "no dashboard frame from the repaint, the bus event or the resize");
  // q during the follow aborts only the follow: one fresh readData, the dashboard back, top alive
  const readsBefore = s.reads.n;
  const waitsBefore = s.ne.calls.length;
  s.input.key(0x71);
  await pump();
  assert.equal(s.reads.n, readsBefore + 1, "one fresh readData when the follow ended");
  assert.equal(s.out.frames().length, framesBefore + 1, "the dashboard was redrawn");
  assert.ok(!lastFrame(s).includes("following r1"), "the banner is gone");
  s.ne.wake(true); // still alive: another round
  await pump();
  assert.equal(s.ne.calls.length, waitsBefore + 1, "top is parked in the wait again");
  s.input.key(0x71);
  await s.p;
});

test("top-loop: a follow that settles on its own (the run ended) brings the dashboard back the same way", async () => {
  const follow = makeFollow();
  const s = await start({ seq: [selTick], follow });
  s.input.key(0x6a);
  s.input.key(0x6a);
  s.input.key(0x6a);
  await pump();
  s.input.key(0x0d);
  await pump();
  const readsBefore = s.reads.n;
  follow.resolve(); // a run_end
  await pump();
  assert.equal(s.reads.n, readsBefore + 1);
  assert.ok(!lastFrame(s).includes("following r1"), "the dashboard is back");
  s.input.key(0x71);
  await s.p;
});

test("top-loop: a rejecting follow shows its message as the hint line and top keeps running", async () => {
  const s = await start({ seq: [selTick, selTick], follow: async () => {
    throw new Error("no run log for r1");
  } });
  s.input.key(0x6a);
  s.input.key(0x6a);
  s.input.key(0x6a);
  await pump();
  s.input.key(0x0d);
  await pump();
  assert.ok(lastFrame(s).includes("no run log for r1"), "the error is the hint line");
  s.input.key(0x6b); // a move still works — top kept running
  await pump();
  assert.ok(lastFrame(s).includes("> PR AH-14"), "the selection moved (the hint cleared with it)");
  s.input.key(0x71);
  const r = await s.p;
  assert.equal(r.ok, true, "a clean quit afterwards");
});

test("top-loop: ? toggles the key help on and off", async () => {
  const s = await start({ seq: [selTick] });
  assert.ok(!lastFrame(s).includes("? help"), "the help is hidden at start");
  s.input.key(0x3f);
  await pump();
  assert.ok(lastFrame(s).includes("j/k ↑/↓ move · Enter follow (running) / hint · ? help · q quit"), "the help line is shown");
  s.input.key(0x3f);
  await pump();
  assert.ok(!lastFrame(s).includes("? help"), "the second ? hides it again");
  s.input.key(0x71);
  await s.p;
});

test("top-loop: the row list scrolls to keep the selected row on screen; the bottom lines stay visible", async () => {
  const rows = () => UP({
    held: Array.from({ length: 5 }, (_, i) => ({ id: `AH-${i}`, ref: `h${i}`, since: iso(NOW - 60e3) })),
    running: [{ ref: "r9", step: "code", ageS: 30 }],
  });
  const s = await start({ seq: [rows], out: makeOut({ columns: 60, rows: 6 }) });
  for (let i = 0; i < 5; i++) s.input.key(0x6a); // down to the running row (index 5)
  await pump();
  const frame = lastFrame(s).split("\n");
  assert.ok(frame.length <= 6, "the frame fits the terminal height");
  assert.ok(frame.some((l) => l.includes("> RUN r9")), "the selected row is on screen");
  assert.ok(frame.some((l) => l.includes("  r9 · code")), "the detail line is on screen");
  assert.ok(!frame.some((l) => l.includes("> HELD AH-0")), "the far-away rows scrolled off");
  s.input.key(0x71);
  await s.p;
});

test("top-loop: strip mode has no keys but q/Ctrl-C — j/k, arrows, Enter and ? leave the strip unchanged", async () => {
  const follow = makeFollow();
  const s = await start({ seq: [selTick], lines: 8, follow });
  const before = s.out.stripFrames().join("\n");
  s.input.key(0x6a);
  s.input.key(0x6b);
  s.input.bytes([0x1b, 0x5b, 0x42]);
  s.input.key(0x0d);
  s.input.key(0x3f);
  await pump();
  assert.equal(s.out.stripFrames().length, 1, "no repaint from any of those keys");
  assert.equal(s.out.stripFrames().join("\n"), before, "the strip frame is byte-identical");
  assert.equal(follow.calls.length, 0, "no follow from Enter in strip mode");
  assert.ok(!s.out.text().includes("> "), "no selection mark in the strip");
  s.input.key(0x71);
  const r = await s.p;
  assert.equal(r.ok, true, "q still quits");
});

test("top-loop: SIGINT during a follow aborts it, restores the terminal exactly once, and top quits", async () => {
  const follow = makeFollow();
  const s = await start({ seq: [selTick], follow });
  s.input.key(0x6a);
  s.input.key(0x6a);
  s.input.key(0x6a);
  await pump();
  s.input.key(0x0d);
  await pump();
  assert.ok(follow.calls[0].signal.aborted === false, "the follow is still running");
  process.emit("SIGINT");
  const r = await s.p;
  assert.equal(r.ok, true, "the quit is clean");
  assert.equal(follow.calls[0].signal.aborted, true, "the follow was aborted");
  assert.equal(s.out.text().split(RESTORE).length - 1, 1, "the restore sequence is written exactly once");
  assert.equal(s.input.calls.pause, 1);
});

// ---------------------------------------------------------------- the shared tail helper

test("follow: tailFile prints the last N lines, streams appends, and resolves on abort (closing the watcher)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-tail-"));
  const file = path.join(dir, "log.txt");
  fs.writeFileSync(file, "l1\nl2\nl3\nl4\nl5\n");
  const ac = new AbortController();
  /** @type {string[]} */
  const out = [];
  const p = tailFile(file, { signal: ac.signal, write: (x) => out.push(x), initialLines: 3 });
  await pump();
  assert.deepEqual(out, ["l3\n", "l4\n", "l5\n"], "the last initialLines lines");
  fs.appendFileSync(file, "l6\n");
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(out, ["l3\n", "l4\n", "l5\n", "l6\n"], "appended lines stream in");
  ac.abort();
  await p; // resolves on the abort
  fs.rmSync(dir, { recursive: true, force: true });
});
