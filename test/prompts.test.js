import { test } from "node:test";
import assert from "node:assert/strict";
import { stepPrompt } from "../src/prompts.js";

const meta = { platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "gh issue comment" };
const task = { name: "t", url: "u", ref: "1", description: "d" };
const step = { id: "code", kind: "implement" };

test("stepPrompt renders findings block only when ctx.findings set", () => {
  const withF = stepPrompt(task, meta, step, { findings: { fromStep: "review", text: "FIX-ME-XYZ" } });
  assert.match(withF, /Review findings from the "review" stage/);
  assert.match(withF, /FIX-ME-XYZ/);
  const without = stepPrompt(task, meta, step, {});
  assert.doesNotMatch(without, /Review findings from/);
  assert.doesNotMatch(without, /gh pr review list/);
});
