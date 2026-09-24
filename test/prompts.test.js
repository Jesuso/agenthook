// Prompt builder — pure-unit coverage: the `@agent` resume section (ctx.resumeComment)
// is appended, delimited, to every step kind, and the prompt is unchanged without it.
import test from "node:test";
import assert from "node:assert/strict";
import { stepPrompt } from "../src/prompts.js";

const task = /** @type {any} */ ({ ref: "42", name: "Add a flag", description: "desc", url: "https://x/42" });
const meta = /** @type {any} */ ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "post a comment" });
const kinds = /** @type {const} */ (["triage", "implement", "review"]);

for (const kind of kinds) {
  test(`stepPrompt(${kind}) appends the delimited human reply when resumeComment is set`, () => {
    const step = /** @type {any} */ ({ id: kind, kind });
    const ctx = { worktree: "/wt", branch: "agent/42", verdictFile: "/v.json" };
    const plain = stepPrompt(task, meta, step, ctx);
    const resumed = stepPrompt(task, meta, step, { ...ctx, resumeComment: "  @agent use Postgres 16  " });
    assert.ok(!plain.includes("HUMAN REPLY"), "no reply section without resumeComment");
    assert.match(resumed, /=== HUMAN REPLY \(resume\) ===\n[\s\S]*\n@agent use Postgres 16\n=== END HUMAN REPLY ===/);
    // the verdict contract stays the last section
    assert.ok(resumed.indexOf("=== END HUMAN REPLY ===") < resumed.indexOf("=== VERDICT (required) ==="));
    // only the reply block is added — everything else is byte-identical
    assert.equal(resumed.replace(/\n\n=== HUMAN REPLY \(resume\) ===[\s\S]*?=== END HUMAN REPLY ===/, ""), plain);
  });
}

test("stepPrompt(triage) hold line says the owner's trigger reply resumes the stage", () => {
  const p = stepPrompt(task, meta, /** @type {any} */ ({ id: "triage", kind: "triage" }), { verdictFile: "/v.json" });
  assert.match(p, /owner's "@agent …" reply comment resumes this stage/);
  assert.match(p, /Do NOT start the comment with "@agent"/);
});
