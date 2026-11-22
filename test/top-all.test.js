import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { registryDir } from "../src/config.js";
import { topMultiRead } from "../src/commands/top.js";
import { allLayout, detailAll, orderProfiles, renderAll, renderTop, selectableAll } from "../src/top.js";
import { NOW, iso, visible, makeOut, makeInput, makeNextEvent, makeTimers, pump, start } from "./_top-helpers.js";

/** One profile's tick: up, nothing in it — override per test. */
const tick = (profile, over = {}) => ({
  profile,
  up: true,
  slots: { max: 2, active: 0, queued: 0 },
  held: [],
  failed: [],
  prWaiting: [],
  running: [],
  events: [],
  cursor: 0,
  ...over,
});

const held = (ref, i = 0) => ({ id: `AH-${i + 1}`, ref, step: "review", since: iso(NOW - 60e3 * (i + 1)) });
const run = (ref, over = {}) => ({ ref, step: "code", ageS: 60, ...over });

test("orderProfiles: needs-you first, then running-only, then the rest — stable inside each group", () => {
  const a = tick("a", { held: [held("h")] });
  const b = tick("b", { running: [run("r")] });
  const c = tick("c");
  const d = tick("d", { prWaiting: [{ id: "PR-1", ref: "12", at: iso(NOW) }] });
  const e = tick("e", { running: [run("r2")] });
  assert.deepEqual(orderProfiles([b, a, e, c, d]).map((t) => t.profile), ["a", "d", "b", "e", "c"]);
  // the input order itself is untouched when it already matches the groups
  assert.deepEqual(orderProfiles([a, b, c]).map((t) => t.profile), ["a", "b", "c"]);
  // a held row outranks a running one even later in the input
  assert.deepEqual(orderProfiles([b, a]).map((t) => t.profile), ["a", "b"]);
});

test("renderAll: one block per profile in orderProfiles order — each block is that profile's renderTop lines", () => {
  const a = tick("a", { held: [held("h1")], running: [run("r1")], slots: { max: 2, active: 1, queued: 3 } });
  const b = tick("b", { running: [run("r2")] });
  const out = renderAll([b, a], { width: 80, now: NOW });
  // a has needs-you → its block comes first, and it is exactly renderTop(a); b's block follows
  assert.deepEqual(out, [...renderTop(a, { width: 80, now: NOW }), ...renderTop(b, { width: 80, now: NOW })]);
});

test("renderAll: a down profile with no needs-you is its header alone; with needs-you it shows those rows and no running", () => {
  const down = tick("d", { up: false, held: [], running: [run("r")] });
  assert.deepEqual(renderAll([down], { width: 80, now: NOW }), renderTop(down, { width: 80, now: NOW })); // header only
  const downNeeds = tick("d", { up: false, held: [held("h1"), held("h2")], running: [run("r")] });
  const out = visibleLines(renderAll([downNeeds], { width: 80, now: NOW }));
  assert.equal(out.length, 3, "header + the two HELD rows — the running row is not shown while down");
  assert.ok(out[0].startsWith("d down"));
  assert.ok(out[1].startsWith("  HELD") && out[2].startsWith("  HELD"));
  assert.ok(!out.some((l) => l.includes("RUN")));
});

test("renderAll height: everything fits → render it all (no collapse, no overflow line)", () => {
  const a = tick("a", { held: [held("h")] });
  const b = tick("b");
  const out = renderAll([a, b], { width: 80, now: NOW, height: 3 });
  assert.deepEqual(out, [...renderTop(a, { width: 80, now: NOW }), ...renderTop(b, { width: 80, now: NOW })]);
});

test("renderAll height: idle blocks collapse to their header first (the queued count stays in the header)", () => {
  const a = tick("a", { held: [held("h")] }); // 2 lines
  const b = tick("b", { slots: { max: 2, active: 0, queued: 5 } }); // idle with a queued line → 2 lines
  const c = tick("c"); // 1 line
  const out = visibleLines(renderAll([a, b, c], { width: 80, now: NOW, height: 4 }));
  assert.deepEqual(out, [
    "a up · agents 0/2 · 0 queued · 1 needs you",
    "  HELD AH-1 review 1m",
    "b up · agents 0/2 · 5 queued · 0 needs you",
    "c up · agents 0/2 · 0 queued · 0 needs you",
  ], "at height 4 the idle blocks collapse to their headers and nothing is hidden");
});

test("renderAll height: still too tall → whole trailing blocks become `  +K more profiles`; never more than height lines", () => {
  const a = tick("a", { held: [held("h")] }); // 2 lines, not idle
  const b = tick("b", { running: [run("r")] }); // 2 lines, not idle
  const c = tick("c", { running: [run("r2")] }); // 2 lines, not idle
  const three = visibleLines(renderAll([a, b, c], { width: 80, now: NOW, height: 3 }));
  assert.deepEqual(three, ["a up · agents 0/2 · 0 queued · 1 needs you", "  HELD AH-1 review 1m", "  +2 more profiles"]);
  assert.ok(three.length <= 3);
  // a shorter height: the first block alone no longer fits budget+1… it fits (2 ≤ 3) → still shown whole
  const two = visibleLines(renderAll([a, b, c], { width: 80, now: NOW, height: 2 }));
  assert.deepEqual(two, ["a up · agents 0/2 · 0 queued · 1 needs you", "  +2 more profiles"]);
  // prefix of whole blocks: at height 5 budget is 4 — a + b whole, only c hides behind the +1 line
  const five = visibleLines(renderAll([a, b, c], { width: 80, now: NOW, height: 5 }));
  assert.deepEqual(five, [
    "a up · agents 0/2 · 0 queued · 1 needs you",
    "  HELD AH-1 review 1m",
    "b up · agents 0/2 · 0 queued · 0 needs you",
    "  RUN r code 1m",
    "  +1 more profiles",
  ]);
});

test("renderAll height: an oversize first block is cut to height − 1, not hidden", () => {
  const a = tick("a", { held: [held("h1", 0), held("h2", 1), held("h3", 2), held("h4", 3)] }); // 5 lines
  const b = tick("b", { held: [held("h")] });
  const out = visibleLines(renderAll([a, b], { width: 80, now: NOW, height: 4 }));
  assert.deepEqual(out, [
    "a up · agents 0/2 · 0 queued · 4 needs you",
    "  HELD AH-1 review 1m",
    "  HELD AH-2 review 2m",
    "  +1 more profiles",
  ], "cut to height − 1 = 3 lines, the rest counted in K");
  assert.equal(out.length, 4);
});

test("selectableAll: the on-screen rows across profiles, tagged with their profile, in order — cut and hidden rows excluded", () => {
  const a = tick("a", { held: [held("h1"), held("h2")], running: [run("r1")] });
  const b = tick("b", { up: false, held: [held("h3")] });
  const sels = selectableAll(allLayout([a, b], {}));
  assert.deepEqual(
    sels.map((s) => [s.profile, s.kind, s.entry.ref]),
    [
      ["a", "held", "h1"],
      ["a", "held", "h2"],
      ["a", "running", "r1"],
      ["b", "held", "h3"],
    ],
  );
  // a whole-block prefix: a (4 lines: header + 2 held + 1 running) fits budget 4; b → the +1 line
  const lay = allLayout([a, b], { height: 5 });
  assert.deepEqual(lay.blocks.map((x) => x.shown), [true, false]);
  assert.equal(lay.blocks[0].cut, undefined);
  assert.deepEqual(
    selectableAll(lay).map((s) => [s.profile, s.kind]),
    [
      ["a", "held"],
      ["a", "held"],
      ["a", "running"],
    ],
  );
  const lay2 = allLayout([a, b], { height: 3 }); // budget 2: a (3) alone exceeds → cut to 2 lines
  assert.equal(lay2.blocks[0].cut, 2);
  assert.deepEqual(selectableAll(lay2).map((s) => s.kind), ["held"]);
});

test("detailAll: prefixes the profile name and keeps the running harness/model parts; empty out of range", () => {
  const a = tick("a", { held: [held("h1", 1)] });
  const b = tick("b", { running: [run("r1", { harness: "claude", model: "opus" })] });
  const lay = allLayout([a, b], {});
  assert.equal(visible(detailAll(lay, 0, { width: 80 })).join(""), "  a · AH-2 · review");
  assert.equal(visible(detailAll(lay, 1, { width: 80 })).join(""), "  b · r1 · code · harness claude · model opus");
  assert.equal(detailAll(lay, 2, { width: 80 }), "");
});

test("renderAll: rows stay glance-only — harness/model never on the rows (the detail line is their only home)", () => {
  const a = tick("a", { running: [run("r1", { harness: "claude", model: "opus" })] });
  const out = visibleLines(renderAll([a], { width: 80, now: NOW }));
  assert.equal(out[1], "  RUN r1 code 1m");
  assert.ok(!out.some((l) => l.includes("harness") || l.includes("claude") || l.includes("opus")));
});

// ---------------------------------------------------------------- live loop (multi mode)

/** p1: one held + one running; p2: one running with the SAME ref — the key must stay distinct. */
const p1 = () => tick("p1", { held: [held("h1")], running: [run("r1")] });
const p2 = () => tick("p2", { running: [run("r1")] });

/** A frame buffer as visible lines (ANSI stripped). @param {string} s */
const frameLines = (s) => visible(s).join("").split("\n");

test("top-loop multi: one wait round per re-read, j/k moves across profiles, Enter follows the row's profile", async () => {
  /** @type {{ref: string, stateKey: string|undefined}[]} */
  const follows = [];
  const s = await start({
    multi: true,
    seq: [
      () => [p1(), p2()],
      () => [p1(), p2()], // after the follow settles: p1's r1 row is STILL there — the key must skip it
      () => [p1(), p2()], // the wake's re-read
    ],
    follow: async (ref, o, stateKey) => {
      follows.push({ ref, stateKey });
    },
  });
  const frame0 = frameLines(s.out.frames().at(-1));
  assert.ok(frame0.some((l) => l.startsWith("p1 up")) && frame0.some((l) => l.startsWith("p2 up")), "both profile headers on screen");
  assert.ok(frame0.some((l) => l.startsWith("> ") && l.includes("HELD")), "the first held row is selected");
  assert.equal(s.ne.calls.length, 1, "one event wait (over every profile) per round");
  assert.equal(s.reads.n, 1, "no data read on the 1 s repaint — only on wakes");
  // j → p1's running row (same profile), j again → p2's r1: crosses the profile boundary
  s.input.key(0x6a); // j
  await pump();
  s.input.key(0x6a); // j
  await pump();
  const frame1 = frameLines(s.out.frames().at(-1));
  assert.equal(frame1.filter((l) => l.startsWith("> ")).length, 1, "exactly one selected row");
  assert.ok(frame1.some((l) => l.startsWith("  p2 · r1 · code")), "the detail line is p2's r1 (the same ref in p1 is not selected)");
  // Enter follows p2's r1 — the row's profile goes as the state key
  s.input.key(0x0d); // Enter
  await pump();
  assert.deepEqual(follows, [{ ref: "r1", stateKey: "p2" }]);
  await pump(); // the follow settled: one fresh read, dashboard back (the wait round is still parked)
  assert.equal(s.reads.n, 2);
  const frame2 = frameLines(s.out.frames().at(-1));
  assert.ok(frame2.some((l) => l.startsWith("  p2 · r1 · code")), "the selection survived the re-read by profile+ref+kind (p1's own r1 row is still there)");
  // an event in any profile wakes the round and triggers the re-read
  s.ne.wake();
  await pump();
  assert.equal(s.reads.n, 3);
  assert.equal(s.ne.calls.length, 2, "one wait per round — the round only restarts on a wake");
  s.input.key(0x71); // q
  const r = await s.p;
  assert.deepEqual(r, { ok: true });
});

test("top-loop multi strip: --lines N frame per the fit rules, in-place repaint, q quits", async () => {
  const s = await start({ multi: true, lines: 4, seq: [() => [tick("aa", { held: [held("h")] }), tick("bb")]] });
  const frame = frameLines(s.out.stripFrames().at(-1));
  assert.equal(frame.length, 4, "the frame is exactly h=4 lines");
  assert.ok(frame[0].startsWith("aa up") && frame[1].startsWith("  HELD") && frame[2].startsWith("bb up"), "one block per profile, needs-you first");
  s.timers.fire(); // the 1 s from-cache repaint repainted in place
  await pump();
  assert.ok(s.out.text().includes("\r\u001b[3A\u001b[J"), "the repaint moves up prevH − 1 = 3");
  assert.equal(s.out.text().split("\u001b[J").length - 1, 1, "one move-back prefix after one repaint");
  assert.ok(!s.out.text().includes("\u001b[?1049h"), "no alternate screen in strip mode");
  s.input.key(0x71);
  await s.p;
  assert.equal(s.out.text().split("\u001b[?25h").length - 1, 1, "quitting shows the cursor exactly once");
});

// ---------------------------------------------------------------- command + CLI

/** Plant a profile state dir under the isolated test registry root. */
function plant(key, { held = 0, pid = true } = {}) {
  const dir = path.join(registryDir, key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name: key, maxConcurrent: 2, tracker: "github" }));
  if (pid) fs.writeFileSync(path.join(dir, "server.pid"), String(process.pid));
  if (held > 0) {
    const at = new Date().toISOString();
    fs.writeFileSync(path.join(dir, "held.json"), JSON.stringify(Object.fromEntries(Array.from({ length: held }, (_, i) => [`x${i + 1}`, { stepId: "review", heldAt: at }]))));
  }
  return dir;
}

test("topMultiRead: every selected profile, re-resolved, local state only (no board/PR/epics)", async () => {
  const a = plant("mma");
  const b = plant("mmb", { held: 2 });
  const c = plant("mmc", { pid: false }); // down
  try {
    const { entries, ticks } = await topMultiRead({ _: ["mma", "mmb"] });
    assert.deepEqual(entries.map((e) => e.stateKey), ["mma", "mmb"], "names in the order given");
    assert.equal(ticks.length, 2);
    assert.deepEqual(ticks.map((t) => t.profile), ["mma", "mmb"]);
    for (const t of ticks) {
      assert.equal(t.board, undefined, "no board read");
      assert.equal(t.prs, undefined, "no PR read");
      assert.equal(t.epics, undefined, "no epics read");
    }
    assert.equal(ticks[1].held.length, 2, "held rows come from local state");
    const all = await topMultiRead({ all: true });
    assert.deepEqual(all.ticks.map((t) => t.profile), ["mma", "mmb", "mmc"], "--all = every non-ghost profile");
    assert.equal(all.ticks[2].up, false, "down profiles are included too");
    assert.equal(all.ticks[2].held.length, 0);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
    fs.rmSync(c, { recursive: true, force: true });
  }
});

test("cli: --all --once renders one block per profile, the needs-you one first; --lines N fits the output", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-topall-home-"));
  const dirs = [];
  const plantHome = (key, held) => {
    const dir = path.join(home, key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name: key, maxConcurrent: 2, tracker: "github" }));
    fs.writeFileSync(path.join(dir, "server.pid"), String(process.pid));
    if (held > 0) {
      const at = new Date().toISOString();
      fs.writeFileSync(path.join(dir, "held.json"), JSON.stringify({ x1: { stepId: "review", heldAt: at } }));
    }
    dirs.push(dir);
    return dir;
  };
  plantHome("aaa", 0); // idle, first in registry order
  plantHome("bbb", 1); // needs-you, later in registry order
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "agenthook.js");
  const run = (argv) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, "top", ...argv], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENTHOOK_HOME: home } });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (err += String(d)));
      child.on("close", (code) => resolve({ code, out, err }));
    });
  try {
    const full = await run(["--all", "--once"]);
    const lines = full.out.trimEnd().split("\n");
    assert.equal(full.code, 0, `--all --once exits 0 (stderr: ${full.err})`);
    assert.equal(lines.length, 3, `two blocks (one block per profile), got: ${lines}`);
    assert.ok(lines[0].startsWith("bbb up") && lines[0].includes("1 needs you"), `the needs-you profile comes first: ${lines[0]}`);
    assert.ok(lines[1].startsWith("  HELD"), `bbb's held row follows its header: ${lines[1]}`);
    assert.ok(lines[2].startsWith("aaa up"), `the idle profile's block (header only) last: ${lines[2]}`);
    for (const bad of ["\u001b[?1049h", "\u001b[?1049l", "\u001b[2J", "\u001b[H"]) assert.ok(!full.out.includes(bad), `no ${JSON.stringify(bad)} in the one-shot multi view`);
    const strip = await run(["--all", "--once", "--lines", "3"]);
    const sLines = strip.out.trimEnd().split("\n");
    assert.equal(strip.code, 0, `--lines 3 exits 0 (stderr: ${strip.err})`);
    assert.equal(sLines.length, 3, `respects N: ${sLines}`);
    assert.ok(sLines[0].startsWith("bbb up") && sLines[1].startsWith("  HELD") && sLines[2].startsWith("aaa up"), `all three lines fit: ${sLines}`);
    const tight = await run(["--all", "--once", "--lines", "2"]);
    const tLines = tight.out.trimEnd().split("\n");
    assert.equal(tight.code, 0, `--lines 2 exits 0 (stderr: ${tight.err})`);
    assert.equal(tLines.length, 2, `fits N=2: ${tLines}`);
    assert.ok(tLines[0].startsWith("bbb up") && tLines[1].startsWith("  +1 more profiles"), `the idle block hides behind the overflow line: ${tLines}`);
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** @param {string[]} lines */
function visibleLines(lines) {
  return lines.map((l) => visible(l).join(""));
}
