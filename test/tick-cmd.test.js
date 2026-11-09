import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { digest, formatTokens } from "../src/commands/tick.js";

test("digest: one header line, RUN/WAIT/HELD rows, board, PRs, events, cursor", () => {
  const out = digest({
    profile: "p", up: true, paused: true,
    slots: { max: 3, active: 1, queued: 1, free: 1 },
    running: [{ ref: "7", id: "ID-7", title: "Seven", step: "code", ageS: 600 }],
    queue: [{ ref: "8", step: "triage" }],
    held: [{ ref: "9", step: "code", why: "which db?" }],
    board: [{ step: "code", resting: [{ ref: "1", id: "ID-1" }], backlog: [{ ref: "2" }] }],
    prsError: "no forge",
    prs: [{ n: 4, ref: "7", ci: "failure", conflict: true, state: "dirty", mine: true }, { n: 5, ref: "8", ci: "success", mine: false }],
    events: [{ ts: "2026-01-01T10:20:30.000Z", e: "run_end", ref: "7", step: "code", outcome: "fail", reason: "boom" }],
    cursor: 42,
  });
  const lines = out.split("\n");
  assert.equal(lines[0], "p up PAUSED slots 1/3 run, 1 queued, 1 free");
  assert.ok(lines.includes('  RUN  ID-7 "Seven" code 10m'));
  assert.ok(lines.includes("  WAIT 8 triage"));
  assert.ok(lines.includes("  HELD 9 code — which db?"));
  assert.ok(lines.includes("  board code: 1 resting, 1 backlog [ID-1]"));
  assert.ok(lines.includes("  PR #4 7 ci=failure CONFLICT dirty mine"));
  assert.ok(lines.includes("  PR #5 8 ci=success not-mine"));
  assert.ok(lines.includes("  prs: no forge"));
  assert.ok(lines.includes("  ev 10:20:30 run_end 7/code → fail (boom)"));
  assert.equal(lines.at(-1), "  cursor 42");
});

test("digest: RUN row appends · harness only when the row has one (#630)", () => {
  const out = digest({
    profile: "p", up: true,
    slots: { max: 2, active: 2, queued: 0, free: 0 },
    running: [
      { ref: "7", id: "ID-7", step: "code", ageS: 600, model: "m", harness: "qwen" },
      { ref: "8", step: "code", ageS: 300 },
    ],
    queue: [], held: [], events: [], cursor: 1,
  });
  const lines = out.split("\n");
  assert.ok(lines.includes("  RUN  ID-7 code 10m · qwen"));
  assert.ok(lines.includes("  RUN  8 code 5m"), "no harness → text unchanged");
});

test("digest: one line per down or probing harness (#621); an up harness adds none", () => {
  const out = digest({
    profile: "p", up: true,
    slots: { max: 3, active: 0, queued: 1, free: 2, harnesses: {
      "local-qwen": { active: 0, max: 1, state: "down", until: "2026-11-08T14:32:00.000Z", reason: "spawn failed: ENOENT" },
      deepseek: { active: 1, max: 1, state: "probing", until: "2026-11-08T12:00:00.000Z", reason: "exited 1 with no output after 2s" },
      opus: { active: 0, max: null, state: "up" },
    } },
    running: [], queue: [], held: [], events: [], cursor: 1,
  });
  const lines = out.split("\n");
  assert.ok(lines.includes("  harness local-qwen: down until 14:32Z (spawn failed: ENOENT)"));
  assert.ok(lines.includes("  harness deepseek: probing (exited 1 with no output after 2s)"));
  assert.equal(lines.filter((l) => l.includes("harness")).length, 2);
});

test("formatTokens: K below 1M rounded to an integer, M (dropping a trailing .0) at or above", () => {
  assert.equal(formatTokens(54000), "54K");
  assert.equal(formatTokens(54321), "54K");
  assert.equal(formatTokens(200000), "200K");
  assert.equal(formatTokens(1000000), "1M");
  assert.equal(formatTokens(1200000), "1.2M");
});

test("digest: RUN row appends · ctx used/max only when both are known (#658)", () => {
  const out = digest({
    profile: "p", up: true,
    slots: { max: 2, active: 2, queued: 0, free: 0 },
    running: [
      { ref: "7", id: "ID-7", step: "code", ageS: 600, model: "m", harness: "qwen", ctx: 54000, ctxMax: 200000 },
      { ref: "8", step: "code", ageS: 300, ctx: 1000 },
      { ref: "9", step: "code", ageS: 300, ctxMax: 200000 },
    ],
    queue: [], held: [], events: [], cursor: 1,
  });
  const lines = out.split("\n");
  assert.ok(lines.includes("  RUN  ID-7 code 10m · qwen · ctx 54K/200K"));
  assert.ok(lines.includes("  RUN  8 code 5m"), "ctx alone, no ctxMax → no gauge");
  assert.ok(lines.includes("  RUN  9 code 5m"), "ctxMax alone, no ctx → no gauge");
});
