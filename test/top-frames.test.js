import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { allLayout, multiFrame, renderAll, renderStrip, renderTop, singleFrame, stripFrame } from "../src/top.js";
import { NOW, iso } from "./_top-helpers.js";

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

const downTick = () => ({ profile: "dev", up: false, slots: { max: 4, active: 0, queued: 0 }, running: [], held: [] });

const tick = (profile, over = {}) => ({ profile, up: true, slots: { max: 2, active: 0, queued: 0 }, held: [], failed: [], prWaiting: [], running: [], ...over });
const held = (ref, i = 0) => ({ id: `AH-${i + 1}`, ref, step: "review", since: iso(NOW - 60e3 * (i + 1)) });
const run = (ref, over = {}) => ({ ref, step: "code", ageS: 60, ...over });

// ---------------------------------------------------------------- stripFrame

test("stripFrame: single mode is renderStrip padded with blank lines to height", () => {
  const t = selTick();
  const frame = stripFrame(t, { height: 6, width: 80, now: NOW });
  assert.equal(frame.length, 6);
  assert.deepEqual(frame.slice(0, 2), renderStrip(t, { lines: 6, width: 80, now: NOW }).slice(0, 2));
  // down + height 1: just the header, padded to height
  const d = stripFrame(downTick(), { height: 3, width: 80, now: NOW });
  assert.equal(d.length, 3);
  assert.deepEqual(d.slice(1), ["", ""]);
});

test("stripFrame: multi mode is renderAll(strip:true) padded to height", () => {
  const a = tick("a", { held: [held("h")] });
  const b = tick("b");
  const frame = stripFrame([a, b], { multi: true, height: 5, width: 80, now: NOW });
  assert.equal(frame.length, 5);
  const expected = renderAll([a, b], { strip: true, height: 5, width: 80, now: NOW });
  assert.deepEqual(frame.slice(0, expected.length), expected);
  assert.ok(frame.slice(expected.length).every((l) => l === ""), "padded with blank lines");
});

// ---------------------------------------------------------------- multiFrame

test("multiFrame: no selection renders every block at the full row budget, no bottom lines", () => {
  const a = tick("a", { held: Array.from({ length: 8 }, (_, i) => held("h", i)) }); // header + 8 rows = 9 lines
  const b = tick("b", { running: [run("r")] });
  const frame = multiFrame([a, b], { selected: -1, width: 80, rows: 10, now: NOW });
  assert.deepEqual(frame, renderAll([a, b], { width: 80, now: NOW, height: 10 }).slice(0, 10));
  // a's 9 lines + b's block overflow 10 — the fit rules (idle collapse / `+K more profiles`) must
  // run at exactly `rows`, not some other budget
  assert.ok(frame.some((l) => l.includes("more profiles")), "overflow triggers at rows, not a looser budget");
});

test("multiFrame: a selection renders blocks at rows-minus-bottom and appends the detail line", () => {
  const a = tick("a", { held: [held("h")] });
  const b = tick("b", { running: [run("r")] });
  const layout = allLayout([a, b], { height: 10 - 1 }); // bottom = 1 (detail only, no hint/help)
  const frame = multiFrame([a, b], { selected: 0, layout, width: 80, rows: 10, now: NOW });
  assert.ok(frame[frame.length - 1].includes("held at review"), "the last line is the detail line");
  assert.ok(frame.length <= 10, "never exceeds rows");
});

test("multiFrame: with a hint and the help toggled on, both land in the bottom block (budget shrinks to match)", () => {
  const a = tick("a", { held: Array.from({ length: 8 }, (_, i) => held("h", i)) }); // header + 8 rows = 9 lines
  const layout = allLayout([a], { height: 10 - 3 }); // bottom = detail + hint + 1 help line
  const frame = multiFrame([a], { selected: 0, layout, hint: "  a hint", showHelp: true, width: 80, rows: 10, now: NOW });
  assert.ok(frame.includes("  a hint"), "the hint line is present");
  assert.ok(frame.some((l) => l.includes("j/k")), "the help line is present");
  // the blocks must be sized to rows - bottomCount (7), not some other budget: with 9 lines of
  // content and a budget too generous the blocks alone would overflow 10 and push the help line
  // (the last bottom line) off the end
  assert.ok(frame.length <= 10, "never exceeds rows");
  assert.equal(frame[frame.length - 1], "  j/k ↑/↓ move · Enter follow (running) / hint · ? help · q quit", "the help line survives at the very end");
});

// ---------------------------------------------------------------- singleFrame

test("singleFrame: a down profile falls back to renderTop's header-only lines regardless of selection", () => {
  const t = downTick();
  assert.deepEqual(singleFrame(t, { selected: 0, width: 80, rows: 20, now: NOW }), renderTop(t, { width: 80, now: NOW }));
});

test("singleFrame: no selection (selected: -1) falls back to the plain renderTop lines", () => {
  const t = selTick();
  assert.deepEqual(singleFrame(t, { selected: -1, width: 80, rows: 20, now: NOW }), renderTop(t, { width: 80, now: NOW }));
});

test("singleFrame: a selection past the visible window scrolls the row list to keep it on screen", () => {
  const t = {
    profile: "dev",
    up: true,
    slots: { max: 1, active: 0, queued: 0 },
    held: [],
    failed: [],
    prWaiting: [],
    running: Array.from({ length: 8 }, (_, i) => run(`r${i}`)),
  };
  // rows = header(1) + bottom(1 detail line) + avail rows; avail = rows - 1 - 1
  const frame = singleFrame(t, { selected: 7, width: 80, rows: 6, now: NOW }); // avail = 4
  assert.ok(frame.some((l) => l.includes("r7") && l.startsWith("> ")), "the selected row 7 is visible and marked");
  assert.ok(!frame.some((l) => l.includes("r0")), "scrolled past the earliest rows");
  assert.ok(frame.length <= 6, "never exceeds rows");
});

test("singleFrame: queued line, detail line, hint and help all land in the bottom, in that order", () => {
  const t = selTick();
  const frame = singleFrame(t, { selected: 3, hint: "  a hint", showHelp: true, width: 80, rows: 20, now: NOW });
  const queuedIdx = frame.findIndex((l) => l.includes("2 queued"));
  const detailIdx = frame.findIndex((l) => l.includes("r1 · code"));
  const hintIdx = frame.indexOf("  a hint");
  const helpIdx = frame.findIndex((l) => l.includes("j/k"));
  assert.ok(queuedIdx !== -1 && detailIdx !== -1 && hintIdx !== -1 && helpIdx !== -1, "all four bottom lines are present");
  assert.ok(queuedIdx < detailIdx && detailIdx < hintIdx && hintIdx < helpIdx, "queued, detail, hint, help in that order");
});
