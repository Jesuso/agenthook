// doctor — pure-unit coverage (no network): the pipeline-binding scan that flags
// `init` TODO_* placeholders and empty bindings before they silently no-op a run.
import test from "node:test";
import assert from "node:assert/strict";
import { unfilledBindings } from "../src/commands/doctor.js";

test("unfilledBindings: clean pipeline has no offenders", () => {
  const pipeline = [
    { id: "code", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:blocked" },
    { id: "review", sourceLabel: "agent:review", successLabel: "agent:qc", failureLabel: "agent:blocked" },
  ];
  assert.deepEqual(unfilledBindings(pipeline), []);
});

test("unfilledBindings: flags TODO_* placeholders from init scaffold", () => {
  const pipeline = [
    { id: "code", sourceLabel: "TODO_SOURCE_LABEL", successLabel: "TODO_REVIEW_LABEL", failureLabel: "TODO_BLOCKED_LABEL" },
  ];
  assert.deepEqual(unfilledBindings(pipeline), [
    "code.sourceLabel",
    "code.successLabel",
    "code.failureLabel",
  ]);
});

test("unfilledBindings: flags empty/whitespace bindings", () => {
  const pipeline = [
    { id: "code", sourceSectionGid: "12", successSectionGid: "", failureSectionGid: "   " },
  ];
  assert.deepEqual(unfilledBindings(pipeline), ["code.successSectionGid", "code.failureSectionGid"]);
});

test("unfilledBindings: covers asana/jira/github binding names", () => {
  const pipeline = [
    { id: "a", sourceSectionGid: "TODO_X", successStatus: "TODO_Y", failureLabel: "TODO_Z", holdSectionGid: "TODO_W" },
  ];
  assert.deepEqual(unfilledBindings(pipeline), [
    "a.sourceSectionGid",
    "a.successStatus",
    "a.failureLabel",
    "a.holdSectionGid",
  ]);
});

test("unfilledBindings: ignores non-binding keys and absent optional bindings", () => {
  const pipeline = [
    { id: "code", kind: "implement", instructionsFile: "TODO_not_a_binding.md", createsWorktree: true, sourceLabel: "agent:code", successLabel: "agent:review" },
  ];
  // instructionsFile starts with TODO_ but is not a source*/success*/failure*/hold* binding; absent failureLabel is fine.
  assert.deepEqual(unfilledBindings(pipeline), []);
});

test("unfilledBindings: tolerates null/empty pipeline", () => {
  assert.deepEqual(unfilledBindings(null), []);
  assert.deepEqual(unfilledBindings([]), []);
});
