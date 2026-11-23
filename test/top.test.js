import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderTop } from "../src/top.js";
import { readStatus } from "../src/agent-api.js";
import { readProfile } from "../src/heartbeat.js";

const NOW = Date.parse("2025-06-01T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

/** A full local tick: one of each needs-you item, one running, two queued. */
function fullTick() {
  return {
    profile: "dev",
    up: true,
    slots: { max: 4, active: 1, queued: 2 },
    running: [{ ref: "r1", step: "code", ageS: 300, model: "claude-opus", harness: "h1", ctx: 90000, costUsd: 1.5 }],
    queue: [{ ref: "q1", step: "code" }, { ref: "q2", step: "review" }],
    held: [{ id: "AH-12", ref: "h1", step: "review", title: "Waiting on the design review answer", since: iso(NOW - 5 * 60e3), why: "blocked on a decision", harness: "h1" }],
    failed: [{ ref: "f1", step: "code", at: iso(NOW - 65 * 60e3), why: "gate failed", model: "claude-opus" }],
    prWaiting: [{ ref: "p1", step: "review", pr: "https://github.com/acme/web/pull/7", kind: "openOnDone", at: iso(NOW - 2 * 24 * 3600e3) }],
    events: [],
    cursor: 0,
  };
}

/** Visible length in code points (ANSI stripped). @param {string} s */
const visible = (s) => [...s.replace(/\u001b\[[0-9;?]*m/g, "")].length;

const emptyUp = () => ({ profile: "dev", up: true, slots: { max: 4, active: 0, queued: 0 }, running: [], queue: [], held: [], events: [], cursor: 0 });

test("renderTop: empty up profile is exactly one header line (up, 0 queued, 0 needs you)", () => {
  const lines = renderTop(emptyUp(), { width: 80, now: NOW });
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "dev up · agents 0/4 · 0 queued · 0 needs you");
});

test("renderTop: running-only → header + one RUN row per agent, no needs-you rows or queued line", () => {
  const t = emptyUp();
  t.running = [
    { ref: "a", step: "code", ageS: 60 },
    { ref: "b", step: "review", ageS: null, title: "Second agent" },
  ];
  t.slots = { max: 4, active: 2, queued: 0 };
  const lines = renderTop(t, { width: 80, now: NOW });
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^  RUN a code 1m$/);
  assert.match(lines[2], /^  RUN b review - Second agent$/);
  assert.ok(!lines.some((l) => /HELD|FAIL|PR /.test(l)));
});

test("renderTop: row order is held → failed → PR → running, then the queued line", () => {
  const t = fullTick();
  const lines = renderTop(t, { width: 200, now: NOW });
  const markers = lines.slice(1, -1).map((l) => l.trimStart().split(" ")[0]);
  assert.deepEqual(markers, ["HELD", "FAIL", "PR", "RUN"]);
  assert.equal(lines.at(-1), "  2 queued");
  // header counts the three needs-you items
  assert.match(lines[0], /3 needs you/);
  // glance rule: no why, cost, model, harness or ctx on any row
  assert.ok(!lines.join("\n").includes("blocked on a decision"));
  assert.ok(!lines.join("\n").includes("gate failed"));
  assert.ok(!lines.join("\n").includes("claude-opus"));
  assert.ok(!lines.join("\n").includes("h1 keeps"));
  assert.ok(!lines.join("\n").includes("90000"));
  assert.ok(!lines.join("\n").includes("1.5"));
  // no PR URL in the row (the glance rule shows nothing beyond the marker)
  assert.ok(!lines.join("\n").includes("github.com"));
});

test("renderTop: elapsed — Nm under the hour, NhMMm under the day, Nd after, '-' when missing", () => {
  const t = fullTick();
  t.held[0].since = iso(NOW - 5 * 60e3); // 5m
  t.failed[0].at = iso(NOW - 65 * 60e3); // 1h05m
  t.prWaiting[0].at = iso(NOW - 2 * 24 * 3600e3); // 2d
  t.held.push({ ref: "h2", step: "code" }); // no since → '-'
  t.prWaiting.push({ ref: "p2", step: "review" }); // no at → no age token on a PR row (not "-")
  t.prWaiting.push({ ref: "p3", step: "review", at: "not-a-date", title: "Bad ts" }); // an unparseable at is the same
  const lines = renderTop(t, { width: 200, now: NOW });
  assert.match(lines[1], /^  HELD AH-12 review 5m /);
  assert.match(lines[2], /^  HELD h2 code -$/);
  assert.match(lines[3], /^  FAIL f1 code 1h05m$/);
  assert.match(lines[4], /^  PR p1 review 2d$/);
  assert.equal(lines[5], "  PR p2 review", "a PR row with no at leaves the age token out");
  assert.match(lines[6], /^  PR p3 review Bad ts$/);
  assert.ok(!lines[5].includes(" - ") && !lines[6].includes(" - "), "no dash age token on the PR rows");
  // a held row with no since still prints "-" (the PR-row exception is PR rows only)
  assert.match(lines[2], / -/);
});

test("renderTop: a PR row whose step is missing shows PR as the step", () => {
  const t = fullTick();
  delete t.prWaiting[0].step;
  t.held = [];
  t.failed = [];
  const lines = renderTop(t, { width: 200, now: NOW });
  assert.match(lines[1], /^  PR p1 PR 2d/);
});

test("renderTop: every line fits the width (visible code points) at 40 and 200; long title truncated at 40, complete at 200", () => {
  const t = fullTick();
  const longTitle = "A very long title that goes on and on and on about the thing being done today";
  t.held[0].title = longTitle;
  for (const width of [40, 200]) {
    const lines = renderTop(t, { width, now: NOW });
    assert.ok(lines.every((l) => visible(l) <= width), `width ${width}: ${JSON.stringify(lines.map(visible))}`);
  }
  const narrow = renderTop(t, { width: 40, now: NOW });
  const wide = renderTop(t, { width: 200, now: NOW });
  assert.match(narrow[1], /…$/);
  assert.ok(!narrow[1].includes(longTitle));
  assert.ok(wide[1].includes(longTitle));
  assert.ok(!wide[1].includes("…"));
});

test("renderTop: a fixed part alone that overflows truncates the whole visible line with …", () => {
  const t = emptyUp();
  t.held = [{ ref: "a-very-long-ref-that-does-not-fit-anywhere-near-40-columns", step: "review" }];
  const lines = renderTop(t, { width: 40, now: NOW });
  assert.ok(lines.every((l) => visible(l) <= 40));
  assert.match(lines[1], /…$/);
});

test("renderTop: color:false has no ESC; color:true stripped of ANSI equals color:false", () => {
  const t = fullTick();
  const plainLines = renderTop(t, { width: 80, now: NOW, color: false });
  assert.ok(!plainLines.join("\n").includes("\u001b"));
  const colored = renderTop(t, { width: 80, now: NOW, color: true });
  assert.deepEqual(colored.map((l) => l.replace(/\u001b\[[0-9;?]*m/g, "")), plainLines);
  assert.ok(colored[0].includes("\u001b[1m")); // the header is tinted
});

test("renderTop: up:false with entries on disk → the header alone, reading down", () => {
  const t = fullTick();
  t.up = false;
  t.slots = { max: 4, active: 0, queued: 0 }; // readStatus zeroes these when the receiver is down
  const lines = renderTop(t, { width: 80, now: NOW });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^dev down · agents 0\/4 · 0 queued · 3 needs you$/);
});

// --- readStatus.prWaiting -----------------------------------------------------------

function reg() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-top-"));
}

const runStart = { event: "run_start", ref: "42", step: "code", ts: "2025-05-30T10:00:00Z" };
const runEnd = { event: "run_end", ref: "42", step: "code", outcome: "advance", ts: "2025-05-31T10:00:00Z" };
const doneEvent = { event: "board_done", via: "flag", ref: "42", step: "review", ts: "2025-06-01T10:00:00Z" };
const runEvents = [runStart, runEnd, doneEvent]; // a lone board_done never makes a row

/** A profile dir with a heartbeat (this process's pid = up) plus the state files buildRows reads. */
function profileDir(r, key, { hb = {}, refmeta = {}, events = [] }) {
  const dir = path.join(r, key);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name: key, maxConcurrent: 3, tracker: "github", queue: { active: 0, queued: 0 }, ...hb }));
  fs.writeFileSync(path.join(dir, "server.pid"), String(process.pid));
  fs.writeFileSync(path.join(dir, "running.json"), "{}");
  fs.writeFileSync(path.join(dir, "queue.json"), "[]");
  fs.writeFileSync(path.join(dir, "held.json"), "{}");
  fs.writeFileSync(path.join(dir, "refmeta.json"), JSON.stringify(refmeta));
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
  return readProfile(key, r);
}

test("readStatus: prWaiting lists the PR rows on a forge profile, omitted otherwise", () => {
  const r = reg();
  // Forge profile with a done row whose PR is still open (prNeeds: openOnDone).
  const forge = profileDir(r, "forge", {
    hb: { forge: true, repository: "acme/web" },
    refmeta: { 42: { title: "Ship the thing", pr: 7 } },
    events: runEvents,
  });
  const s = readStatus(forge);
  assert.deepEqual(s.prWaiting, [
    { ref: "42", title: "Ship the thing", step: "review", pr: "https://github.com/acme/web/pull/7", kind: "openOnDone", at: "2025-06-01T10:00:00Z" },
  ]);

  // Same state without a forge: the key is absent.
  const plain = profileDir(r, "plain", {
    hb: { repository: "acme/web" },
    refmeta: { 42: { title: "Ship the thing", pr: 7 } },
    events: runEvents,
  });
  assert.ok(!("prWaiting" in readStatus(plain)));

  // Forge profile with no row whose prNeeds is set: also omitted.
  const quiet = profileDir(r, "quiet", {
    hb: { forge: true, repository: "acme/web" },
    refmeta: { 43: { title: "Nothing to wait on" } },
  });
  assert.ok(!("prWaiting" in readStatus(quiet)));

  // A mergedOpen row (the board is still open, so the row's finishedAt is null) — its at is
  // the merged event's ts, so the top renderer shows a real age instead of "-".
  const merged = profileDir(r, "merged", {
    hb: { forge: true, repository: "acme/web" },
    refmeta: { 55: { title: "Shipped, board open", pr: 9 } },
    events: [
      { event: "run_start", ref: "55", step: "code", ts: "2025-05-30T10:00:00Z" },
      { event: "run_end", ref: "55", step: "code", outcome: "advance", ts: "2025-05-30T11:00:00Z" },
      { event: "run_start", ref: "55", step: "code", ts: "2025-05-31T10:00:00Z" }, // a re-run: the board is known open
      { event: "merged", ref: "55", ts: "2025-06-02T09:00:00Z" },
    ],
  });
  assert.deepEqual(readStatus(merged).prWaiting, [
    { ref: "55", title: "Shipped, board open", step: "code", pr: "https://github.com/acme/web/pull/9", kind: "mergedOpen", at: "2025-06-02T09:00:00Z" },
  ]);
});

test("readStatus: a prWaiting row without a finishedAt (and no merge) falls back to the ref's newest event ts", () => {
  const r = reg();
  // An awaitingMerge row: the board is known open (a re-run), the PR is open — no board_done and
  // no merged event, so finishedAt and the merge ts are both absent. Its at is the tail's newest ts.
  const awaiting = profileDir(r, "awaiting", {
    hb: { forge: true, repository: "acme/web" },
    refmeta: { 61: { title: "Open PR, board still open", pr: 11 } },
    events: [
      { event: "run_start", ref: "61", step: "code", ts: "2025-05-30T10:00:00Z" },
      { event: "run_end", ref: "61", step: "code", outcome: "advance", ts: "2025-05-30T11:00:00Z" },
      { event: "run_start", ref: "61", step: "code", ts: "2025-05-31T09:00:00Z" }, // the re-run: the board is known open
    ],
  });
  assert.deepEqual(readStatus(awaiting).prWaiting, [
    { ref: "61", title: "Open PR, board still open", step: "code", pr: "https://github.com/acme/web/pull/11", kind: "awaitingMerge", at: "2025-05-31T09:00:00Z" },
  ]);
  // No event carries a ts → at stays null (the renderer drops the age token).
  const noTs = profileDir(r, "nots", {
    hb: { forge: true, repository: "acme/web" },
    refmeta: { 62: { title: "No timestamps", pr: 12 } },
    events: [
      { event: "run_start", ref: "62", step: "code" },
      { event: "run_end", ref: "62", step: "code", outcome: "advance" },
      { event: "run_start", ref: "62", step: "code" },
    ],
  });
  assert.deepEqual(readStatus(noTs).prWaiting, [
    { ref: "62", title: "No timestamps", step: "code", pr: "https://github.com/acme/web/pull/12", kind: "awaitingMerge", at: null },
  ]);
});
