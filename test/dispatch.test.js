// Dispatch argv builder — pure-unit coverage (no real `claude` spawn): the per-step
// --model / --effort passthrough and the invalid-effort fallback (warn + omit).
import test from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs } from "../src/dispatch.js";

test("buildClaudeArgs: no model/effort -> just the prompt", () => {
  const args = buildClaudeArgs({ prompt: "hi" });
  assert.deepEqual(args, ["-p", "hi"]);
});

test("buildClaudeArgs: effort set -> --effort after the prompt", () => {
  const args = buildClaudeArgs({ prompt: "hi", effort: "low" });
  assert.deepEqual(args, ["-p", "hi", "--effort", "low"]);
});

test("buildClaudeArgs: --effort pushed after --model", () => {
  const args = buildClaudeArgs({ prompt: "hi", model: "claude-opus-4-8", effort: "high" });
  assert.deepEqual(args, ["-p", "hi", "--model", "claude-opus-4-8", "--effort", "high"]);
});

test("buildClaudeArgs: every valid effort level is accepted", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(buildClaudeArgs({ prompt: "p", effort: level }), ["-p", "p", "--effort", level]);
  }
});

test("buildClaudeArgs: invalid effort dropped with a warn, no --effort flag", () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const args = buildClaudeArgs({ prompt: "hi", effort: "turbo" });
    assert.deepEqual(args, ["-p", "hi"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /invalid effort "turbo"/);
  } finally {
    console.warn = orig;
  }
});

test("buildClaudeArgs: fullAuto adds --dangerously-skip-permissions last", () => {
  const args = buildClaudeArgs({ prompt: "hi", model: "m", effort: "max", fullAuto: true });
  assert.deepEqual(args, ["-p", "hi", "--model", "m", "--effort", "max", "--dangerously-skip-permissions"]);
});
