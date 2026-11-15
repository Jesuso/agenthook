import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The executor axis (#682): which launcher a run picks — host or the profile's sandbox — chosen
// per run after the harness resolves. executorFor answers exactly what isSandboxed answered
// before this axis existed; the harness name never flips it (yet).
import test from "node:test";
import assert from "node:assert/strict";
import { createExecutors, executorFor } from "../src/dispatch/executor.js";

const spawnPaths = {
  verdictPathFor: (stepId, ref) => `/state/verdicts/${ref}-${stepId}.json`,
  sandboxVerdictPathFor: (stepId, ref) => `/state/verdicts/run-${ref}-${stepId}/verdict.json`,
};
const fakeSandbox = { wrap: async (o) => ({ ...o, id: "box-1", kill: async () => {}, done: async () => ({}) }), reap: async () => ({ containers: [], networks: [], runs: [] }) };

test("createExecutors: no sandbox configured -> only host", () => {
  const executors = createExecutors({ sandbox: null, spawnPaths });
  assert.deepEqual(Object.keys(executors), ["host"]);
  assert.equal(executors.host.name, "host");
});

test("createExecutors: a configured sandbox adds the sandbox executor, wrapping sandbox.wrap/reap verbatim", async () => {
  const executors = createExecutors({ sandbox: fakeSandbox, spawnPaths });
  assert.equal(executors.sandbox?.name, "sandbox");
  const run = await executors.sandbox.launch({ bin: "b", args: [], env: {} });
  assert.equal(run.id, "box-1");
  assert.deepEqual(await executors.sandbox.reap(), { containers: [], networks: [], runs: [] });
});

test("executorFor: sandbox exactly when a sandbox block is configured and the step did not opt out", () => {
  const executors = createExecutors({ sandbox: fakeSandbox, spawnPaths });
  assert.equal(executorFor({ sandbox: { type: "docker" } }, { id: "code" }, null, executors).name, "sandbox");
  assert.equal(executorFor({ sandbox: { type: "docker" } }, undefined, null, executors).name, "sandbox");
});

test("executorFor: host when no sandbox block is configured", () => {
  const executors = createExecutors({ sandbox: null, spawnPaths });
  assert.equal(executorFor({}, { id: "code" }, null, executors).name, "host");
  assert.equal(executorFor({ sandbox: { type: "docker" } }, { id: "code" }, null, { host: executors.host }).name, "host", "no sandbox executor built -> host even if cfg has a sandbox block");
});

test("executorFor: host when the step opts out with sandbox:false, even with a sandbox block configured", () => {
  const executors = createExecutors({ sandbox: fakeSandbox, spawnPaths });
  assert.equal(executorFor({ sandbox: { type: "docker" } }, { id: "code", sandbox: false }, null, executors).name, "host");
});

test("executorFor: a harnessed step under two harnesses never flips the executor — the harness name rides along unused", () => {
  const executors = createExecutors({ sandbox: fakeSandbox, spawnPaths });
  const cfg = { sandbox: { type: "docker" }, harnesses: { a: {}, b: {} } };
  for (const harnessName of ["a", "b", null, undefined]) {
    assert.equal(executorFor(cfg, { id: "code" }, harnessName, executors).name, "sandbox");
    assert.equal(executorFor(cfg, { id: "code", sandbox: false }, harnessName, executors).name, "host");
  }
});

test("Executor.paths: host resolves the plain verdict path and the worktree/repo cwd; sandbox resolves the per-run verdict path", () => {
  const executors = createExecutors({ sandbox: fakeSandbox, spawnPaths });
  const withWorktree = { stepId: "code", ref: "42", worktree: "/wt/42", hasWorktree: true, repoPath: "/repo" };
  assert.deepEqual(executors.host.paths(withWorktree), { cwd: "/wt/42", worktree: "/wt/42", verdictFile: "/state/verdicts/42-code.json" });
  assert.deepEqual(executors.sandbox.paths(withWorktree), { cwd: "/wt/42", worktree: "/wt/42", verdictFile: "/state/verdicts/run-42-code/verdict.json" });
  const noWorktree = { stepId: "triage", ref: "7", worktree: "/wt/7", hasWorktree: false, repoPath: "/repo" };
  assert.deepEqual(executors.host.paths(noWorktree), { cwd: "/repo", worktree: undefined, verdictFile: "/state/verdicts/7-triage.json" });
});
