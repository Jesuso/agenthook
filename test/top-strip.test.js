import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse } from "../bin/agenthook.js";
import { top } from "../src/commands/top.js";
import { renderStrip, renderTop } from "../src/top.js";
import { NOW, iso, visible, emptyUpTick, makeOut, pump, start } from "./_top-helpers.js";

const HIDE = "\u001b[?25l"; // strip start: hide the cursor only (no alternate screen)
const SHOW = "\u001b[?25h"; // strip restore: show the cursor (+ line break, the prompt lands below)

/** 3 needs-you (held) + 4 running — the ticket's 7-row overflow case. */
const sevenTick = () => ({
  profile: "dev",
  up: true,
  slots: { max: 4, active: 4, queued: 1 },
  held: [
    { id: "AH-1", ref: "h1", step: "review", title: "First held ticket", since: iso(NOW - 60e3) },
    { id: "AH-2", ref: "h2", step: "review", since: iso(NOW - 120e3) },
    { id: "AH-3", ref: "h3", step: "review", since: iso(NOW - 180e3) },
  ],
  running: [
    { ref: "r1", step: "code", ageS: 60 },
    { ref: "r2", step: "code", ageS: 120 },
    { ref: "r3", step: "code", ageS: 180 },
    { ref: "r4", step: "code", ageS: 240 },
  ],
  events: [],
  cursor: 0,
});

test("renderStrip: 7 rows (3 needs-you + 4 running) — at most `lines` lines, header first (renderTop's line 0)", () => {
  const t = sevenTick();
  const ref = renderTop(t, { width: 80 });
  for (const [lines, expect] of [[2, 2], [3, 3], [6, 6]]) {
    const out = renderStrip(t, { lines, width: 80, now: NOW });
    assert.equal(out.length, expect, `lines=${lines} → ${expect} lines, got ${out.length}`);
    assert.equal(out[0], ref[0], `lines=${lines}: line 0 is renderTop's header`);
  }
});

test("renderStrip: the overflow line — +K more with the hidden needs-you/running split, at N=3 and N=2", () => {
  const t = sevenTick();
  const three = renderStrip(t, { lines: 3, width: 80, now: NOW });
  assert.equal(three[1], renderTop(t, { width: 80, now: NOW })[1], "the first row is the first held row, identical to renderTop's");
  assert.equal(visible(three[2]).join(""), "  +6 more · 2 needs you · 4 running");
  const two = renderStrip(t, { lines: 2, width: 80, now: NOW });
  assert.equal(visible(two[1]).join(""), "  +7 more · 3 needs you · 4 running");
});

test("renderStrip: everything fits — no +K more line and no queued line (the header carries the count)", () => {
  const t = sevenTick();
  const out = renderStrip(t, { lines: 8, width: 80, now: NOW });
  assert.equal(out.length, 8, "header + all 7 rows");
  assert.ok(!out.slice(1).some((l) => visible(l).includes("more")), "no overflow line");
  assert.ok(!out.slice(1).some((l) => visible(l).includes("queued")), "no queued line — only the header mentions it");
});

test("renderStrip: needs-you rows come before running rows; no line longer than `width` (color on)", () => {
  const t = {
    profile: "dev",
    up: true,
    slots: { max: 4, active: 2, queued: 0 },
    held: [{ id: "AH-9", step: "review", title: "A held one", since: iso(NOW - 60e3) }],
    prWaiting: [{ id: "PR-4", ref: "12", at: iso(NOW - 30e3) }],
    running: [
      { ref: "r1", step: "code", ageS: 60 },
      { ref: "r2", step: "code", ageS: 120 },
    ],
  };
  const out = renderStrip(t, { lines: 8, width: 40, now: NOW, color: true });
  const vis = out.map((l) => visible(l).join(""));
  assert.equal(vis[1], "  HELD AH-9 review 1m A held one");
  assert.match(vis[2], /^  PR PR-4 PR/);
  assert.match(vis[3], /^  RUN r1 code/);
  assert.ok(
    vis.findIndex((l) => l.includes("HELD")) < vis.findIndex((l) => l.includes("PR PR-4")) &&
      vis.findIndex((l) => l.includes("PR PR-4")) < vis.findIndex((l) => l.includes("RUN r1")),
    "needs-you before running",
  );
  for (const l of vis) assert.ok(l.length <= 40, `line longer than width 40: "${l}"`);
});

test("renderStrip: up:false or lines=1 — the header alone", () => {
  const down = { ...sevenTick(), up: false };
  const ref = renderTop(down, { width: 80 });
  assert.deepEqual(renderStrip(down, { lines: 5, width: 80 }), ref);
  assert.deepEqual(renderStrip(sevenTick(), { lines: 1, width: 80 }), [renderTop(sevenTick(), { width: 80 })[0]]);
});

test("top-loop strip: no alternate screen, home or full clear; h-line frames; move-back repaints; restore once", async () => {
  const s = await start({ lines: 3, seq: [sevenTick] });
  const early = await Promise.race([s.p, new Promise((res) => setTimeout(() => res("still"), 50))]);
  assert.equal(early, "still", "the loop is still running (parked in the wait)");
  const buf = s.out.text();
  assert.ok(buf.startsWith(HIDE), "hide-cursor only on start — no alternate screen");
  for (const seq of ["\u001b[?1049h", "\u001b[?1049l", "\u001b[2J", "\u001b[H"]) assert.ok(!buf.includes(seq), `the buffer must not contain ${JSON.stringify(seq)}`);
  const frame = s.out.stripFrames().at(-1).split("\n");
  assert.equal(frame.length, 3, "the frame is exactly h=3 lines");
  // the 1 s repaint repainted in place: \r, up h-1, erase to end of screen
  s.timers.fire();
  await pump();
  let buf2 = s.out.text();
  assert.ok(buf2.includes("\r\u001b[2A\u001b[J"), "the later paint starts with \\r\\e[2A\\e[J");
  assert.equal(buf2.split("\u001b[J").length - 1, 1, "one move-back prefix after one repaint");
  for (const f of s.out.stripFrames()) assert.equal(f.split("\n").length, 3, "every frame has exactly h lines");
  // resize redraws
  s.out.emitResize();
  await pump();
  s.input.key(0x71);
  await s.p;
  const done = s.out.text();
  assert.equal(done.split(SHOW).length - 1, 1, "quitting shows the cursor exactly once");
  assert.ok(done.endsWith(SHOW + "\n"), "the strip stays in scrollback — a line break lands the prompt below it");
  assert.ok(!done.includes("\u001b[?1049l"), "still no alternate screen on quit");
});

test("top-loop strip: a frame with fewer rows than the strip height pads to exactly h lines; the repaint moves up h-1", async () => {
  // The tick has no rows (an empty-up profile), so the h=5 frame is header + 4 padding lines —
  // the padding is what keeps the next paint's move-back from climbing past the strip.
  const s = await start({ lines: 5, seq: [emptyUpTick] });
  const first = s.out.stripFrames().at(-1).split("\n");
  assert.equal(first.length, 5, "the frame is exactly h=5 lines (header + padding)");
  assert.ok(first[0].length > 0, "line 0 is the header");
  assert.deepEqual(first.slice(1), ["", "", "", ""], "the extra lines are empty padding");
  s.timers.fire(); // the 1 s from-cache repaint: over the h=5 frame it must move up h-1 = 4
  await pump();
  const buf = s.out.text();
  assert.ok(buf.includes("\r\u001b[4A\u001b[J"), "the next paint starts with \\r\\e[4A\\e[J (previous height 5)");
  assert.equal(buf.split("\u001b[J").length - 1, 1, "one move-back prefix after one repaint");
  const f2 = s.out.stripFrames().at(-1).split("\n");
  assert.equal(f2.length, 5, "the repaint is padded to exactly h lines too");
  assert.deepEqual(f2, first, "the repaint is the same padded frame");
  s.input.key(0x71);
  await s.p;
  assert.equal(s.out.text().split(SHOW).length - 1, 1, "quitting shows the cursor exactly once");
});

test("top-loop strip: a pane shorter than N clamps to the pane height; a resize repaints at the new size", async () => {
  const out = makeOut({ rows: 2, columns: 80 });
  const s = await start({ lines: 5, seq: [sevenTick], out });
  const first = s.out.stripFrames().at(-1).split("\n");
  assert.equal(first.length, 2, "h = min(lines, out.rows) = 2");
  assert.equal(visible(first[1]).join(""), "  +7 more · 3 needs you · 4 running", "at h=2 the strip is header + the full overflow line");
  out.rows = 8;
  out.columns = 40;
  out.emitResize();
  await pump();
  assert.ok(s.out.text().includes("\r\u001b[1A\u001b[J"), "the paint right after the resize moves up prevH-1 = 1 (the previous height, not the new one)");
  const next = s.out.stripFrames().at(-1).split("\n");
  assert.equal(next.length, 5, "the resize repaints at h = min(5, 8) = 5");
  for (const l of next) assert.ok(visible(l).length <= 39, `line off the last column (columns-1): "${l}"`);
  s.timers.fire(); // one more repaint over the h=5 frame: up prevH-1 = 4
  await pump();
  assert.ok(s.out.text().includes("\r\u001b[4A\u001b[J"), "the paint after the resized frame moves up prevH-1 = 4 (the previous height 5)");
  s.input.key(0x71);
  await s.p;
});

test("parse: --lines takes a value", () => {
  assert.deepEqual(parse(["--lines", "3", "dev"]), { lines: "3", _: ["dev"] });
});

test("top: --lines validation — 1, abc, 2.5, true and a missing value print the error and exit 1", async () => {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  const prevCode = process.exitCode;
  try {
    for (const v of ["1", "abc", "2.5", true]) {
      errors.length = 0;
      process.exitCode = 0;
      await top({ lines: v });
      assert.equal(process.exitCode, 1, `--lines ${JSON.stringify(v)} exits 1`);
      assert.ok(errors.some((e) => e.includes("--lines needs a whole number ≥ 2")), `--lines ${JSON.stringify(v)} prints the error: ${errors}`);
    }
    errors.length = 0;
    process.exitCode = 0;
    await top(parse(["--lines"])); // `--lines` with no value, through the real parse path
    assert.equal(process.exitCode, 1, "a value-less --lines exits 1");
    assert.ok(errors.some((e) => e.includes("--lines needs a whole number ≥ 2")), "a value-less --lines prints the error");
    errors.length = 0;
    process.exitCode = 0;
    await top({ lines: "3" }); // a valid N passes the validation (and then fails on profile discovery in this sandbox)
    assert.ok(!errors.some((e) => e.includes("--lines needs a whole number")), "--lines 3 does not trip the --lines validation");
  } finally {
    console.error = orig;
    process.exitCode = prevCode ?? 0;
  }
});

test("cli: --once --lines 3 cuts 4 held rows to 3 lines, no alternate screen", async () => {
  // A piped (non-TTY) stdout goes through the one-shot strip path with a real profile in a
  // fresh registry root (the only profile, so the name-less pick resolves it). The profile
  // holds 4 items, so `renderTop` alone prints 5 lines — only honoring `--lines` gets 3.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-topstrip-home-"));
  const dir = path.join(home, "topstrip");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name: "topstrip", maxConcurrent: 2, tracker: "github" }));
  fs.writeFileSync(path.join(dir, "server.pid"), String(process.pid));
  const heldAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "held.json"), JSON.stringify({ a: { stepId: "review", heldAt }, b: { stepId: "review", heldAt }, c: { stepId: "review", heldAt }, d: { stepId: "review", heldAt } }));
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "agenthook.js");
  const child = spawn(process.execPath, [bin, "top", "--once", "--lines", "3"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENTHOOK_HOME: home } });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (err += String(d)));
  const code = await new Promise((resolve) => child.on("close", resolve));
  const lines = out.trim() ? out.trimEnd().split("\n") : [];
  assert.equal(code, 0, `--once --lines 3 exits 0, got ${code} (stderr: ${err})`);
  assert.equal(lines.length, 3, `exactly 3 lines (4 held would print 5 without --lines), got ${lines.length}: ${lines}`);
  assert.equal(lines[2], "  +3 more · 3 needs you · 0 running", `the overflow line: ${lines}`);
  for (const bad of ["\u001b[?1049h", "\u001b[?1049l", "\u001b[2J", "\u001b[H"]) assert.ok(!out.includes(bad), `no ${JSON.stringify(bad)} in the one-shot strip`);
});

test("cli: --lines 1 exits 1 with the error", async () => {
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "agenthook.js");
  const child = spawn(process.execPath, [bin, "top", "--lines", "1"], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += String(d)));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 1, `--lines 1 exits 1, got ${code}`);
  assert.ok(err.includes("--lines needs a whole number ≥ 2"), `stderr: ${err}`);
});
