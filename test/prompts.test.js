import { test } from "node:test";
import assert from "node:assert/strict";
import { stepPrompt } from "../src/prompts.js";

const task = { ref: "1", name: "T", url: "http://x/1", description: "body" };
const meta = {
  platform: "GitHub", taskNoun: "issue", trigger: "@agent",
  commentHowTo: "post a comment",
  readCommentsHowTo: "gh issue view <number> --comments",
};
const ctx = { worktree: "/w", branch: "b", verdictFile: "/v.json" };
const step = (kind) => ({ id: kind, kind });

for (const kind of ["triage", "implement"]) {
  test(`${kind} prompt tells agent to read comments when set`, () => {
    const p = stepPrompt(task, meta, step(kind), ctx);
    assert.match(p, /FIRST read its newest comments \(gh issue view <number> --comments\)/);
    assert.match(p, /do not hold again on it/);
  });
  test(`${kind} prompt omits read-comments line when unset`, () => {
    const p = stepPrompt(task, { ...meta, readCommentsHowTo: undefined }, step(kind), ctx);
    assert.doesNotMatch(p, /newest comments/);
  });
}

test("review prompt unchanged by readCommentsHowTo", () => {
  const a = stepPrompt(task, meta, step("review"), ctx);
  const b = stepPrompt(task, { ...meta, readCommentsHowTo: undefined }, step("review"), ctx);
  assert.equal(a, b);
});
