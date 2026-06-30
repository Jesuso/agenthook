// `agenthook run` guard — pure-unit coverage (no network/store): entryBlock refuses
// to re-inject a ref that's already mid-flow (resting in a pipeline stage, or carrying
// a running job), unless --force. One ref = one in-flight flow (the worktree + running.json
// are per-ref, so a second concurrent entry would race the first — the #19 incident).
import test from "node:test";
import assert from "node:assert/strict";
import { entryBlock } from "../src/commands/run.js";

test("entryBlock: a clean backlog item is allowed (null)", () => {
  assert.equal(entryBlock("42", { stage: null, running: null }), null);
  assert.equal(entryBlock("42", {}), null);
});

test("entryBlock: an item resting in a pipeline stage is refused", () => {
  const msg = entryBlock("42", { stage: "agent:code", running: null });
  assert.match(String(msg), /^42 is already in the pipeline \(agent:code\)/);
  assert.match(String(msg), /--force/);
});

test("entryBlock: a running job refuses and names the step", () => {
  const msg = entryBlock("19", { stage: null, running: { stepId: "code", startedAt: "now" } });
  assert.match(String(msg), /\(running code\)/);
});

test("entryBlock: a running job with no stepId still refuses", () => {
  const msg = entryBlock("19", { running: /** @type {any} */ ({ startedAt: "now" }) });
  assert.match(String(msg), /\(running\)/);
});

test("entryBlock: stage AND running list both reasons", () => {
  const msg = entryBlock("19", { stage: "agent:review", running: { stepId: "code", startedAt: "now" } });
  assert.match(String(msg), /\(agent:review \/ running code\)/);
});

test("entryBlock: --force always allows, even when mid-flow", () => {
  assert.equal(entryBlock("19", { stage: "agent:code", running: { stepId: "code", startedAt: "now" }, force: true }), null);
});
