import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/commands/tick.js";

test("digest: one header line, RUN/WAIT/HELD rows, board, PRs, events, cursor", () => {
  const out = digest({
    profile: "p", up: true, paused: true,
    slots: { max: 3, active: 1, queued: 1, free: 1 },
    running: [{ ref: "7", id: "ID-7", title: "Seven", step: "code", ageS: 600 }],
    queue: [{ ref: "8", step: "triage" }],
    held: [{ ref: "9", step: "code", why: "which db?" }],
    board: [{ step: "code", resting: [{ ref: "1", id: "ID-1" }], backlog: [{ ref: "2" }] }],
    prsError: "no forge",
    prs: [{ n: 4, ref: "7", ci: "failure", conflict: true, state: "dirty" }],
    events: [{ ts: "2026-01-01T10:20:30.000Z", e: "run_end", ref: "7", step: "code", outcome: "fail", reason: "boom" }],
    cursor: 42,
  });
  const lines = out.split("\n");
  assert.equal(lines[0], "p up PAUSED slots 1/3 run, 1 queued, 1 free");
  assert.ok(lines.includes('  RUN  ID-7 "Seven" code 10m'));
  assert.ok(lines.includes("  WAIT 8 triage"));
  assert.ok(lines.includes("  HELD 9 code — which db?"));
  assert.ok(lines.includes("  board code: 1 resting, 1 backlog [ID-1]"));
  assert.ok(lines.includes("  PR #4 7 ci=failure CONFLICT dirty"));
  assert.ok(lines.includes("  prs: no forge"));
  assert.ok(lines.includes("  ev 10:20:30 run_end 7/code → fail (boom)"));
  assert.equal(lines.at(-1), "  cursor 42");
});
