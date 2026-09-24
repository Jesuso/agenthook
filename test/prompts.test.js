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

test("stepPrompt renders findings block only when ctx.findings set", () => {
  const withF = stepPrompt(task, meta, step("implement"), { findings: { fromStep: "review", text: "FIX-ME-XYZ" } });
  assert.match(withF, /Review findings from the "review" stage/);
  assert.match(withF, /FIX-ME-XYZ/);
  const without = stepPrompt(task, meta, step("implement"), {});
  assert.doesNotMatch(without, /Review findings from/);
  assert.doesNotMatch(without, /gh pr review list/);
});

// --- the `@agent` resume section (ctx.resumeComment): appended, delimited, to every kind ---
for (const kind of ["triage", "implement", "review"]) {
  test(`stepPrompt(${kind}) appends the delimited human reply when resumeComment is set`, () => {
    const plain = stepPrompt(task, meta, step(kind), ctx);
    const resumed = stepPrompt(task, meta, step(kind), { ...ctx, resumeComment: "  @agent use Postgres 16  " });
    assert.ok(!plain.includes("HUMAN REPLY"), "no reply section without resumeComment");
    assert.match(resumed, /=== HUMAN REPLY \(resume\) ===\n[\s\S]*\n@agent use Postgres 16\n=== END HUMAN REPLY ===/);
    assert.ok(resumed.indexOf("=== END HUMAN REPLY ===") < resumed.indexOf("=== VERDICT (required) ==="));
    assert.equal(resumed.replace(/\n\n=== HUMAN REPLY \(resume\) ===[\s\S]*?=== END HUMAN REPLY ===/, ""), plain);
  });
}

test("stepPrompt(triage) hold line says the owner's trigger reply resumes the stage", () => {
  const p = stepPrompt(task, meta, step("triage"), { verdictFile: "/v.json" });
  assert.match(p, /owner's "@agent …" reply comment resumes this stage/);
  assert.match(p, /Do NOT start the comment with "@agent"/);
});
