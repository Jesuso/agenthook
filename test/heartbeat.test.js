// instructionTargets — pure unit coverage: which standing-instructions files the
// pipeline actually reads, grouped by role (step/default/repo), with dedupe-by-path
// and step > default > repo precedence when one file serves several roles.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { instructionTargets } from "../src/heartbeat.js";

/** @param {object} overrides */
function baseCfg(overrides = {}) {
  return {
    instructionsFile: "/cfg/INSTRUCTIONS.md",
    pipeline: [],
    repos: undefined,
    ...overrides,
  };
}

test("two steps sharing one file -> one scope:'step' entry with both ids", () => {
  const cfg = baseCfg({
    pipeline: [
      { id: "code", instructionsFile: "/cfg/code.md" },
      { id: "review", instructionsFile: "/cfg/code.md" },
    ],
  });
  const targets = instructionTargets(cfg);
  assert.deepEqual(targets, [{ path: path.resolve("/cfg/code.md"), scope: "step", ids: ["code", "review"] }]);
});

test("non-manual step without its own file -> default entry for that step's id", () => {
  const cfg = baseCfg({
    pipeline: [{ id: "code" }],
  });
  const targets = instructionTargets(cfg);
  assert.deepEqual(targets, [{ path: path.resolve("/cfg/INSTRUCTIONS.md"), scope: "default", ids: ["code"] }]);
});

test("every non-manual step has its own file -> no default entry", () => {
  const cfg = baseCfg({
    pipeline: [
      { id: "code", instructionsFile: "/cfg/code.md" },
      { id: "review", instructionsFile: "/cfg/review.md" },
    ],
  });
  const targets = instructionTargets(cfg);
  assert.ok(!targets.some((t) => t.scope === "default"));
});

test("manual steps never appear in any ids, with or without their own file", () => {
  const cfg = baseCfg({
    pipeline: [
      { id: "gate", manual: true },
      { id: "gate2", manual: true, instructionsFile: "/cfg/gate2.md" },
      { id: "code" },
    ],
  });
  const targets = instructionTargets(cfg);
  for (const t of targets) {
    assert.ok(!t.ids.includes("gate"));
    assert.ok(!t.ids.includes("gate2"));
  }
  // manual-only lack of a file does not spuriously trigger a default entry for them
  const def = targets.find((t) => t.scope === "default");
  assert.deepEqual(def.ids, ["code"]);
  assert.ok(!targets.some((t) => t.path === path.resolve("/cfg/gate2.md")));
});

test("repos[].instructionsFile -> scope:'repo', ids:[repo.id]; synthesized default repo contributes nothing", () => {
  const cfg = baseCfg({
    repos: [
      { id: "svc-a", path: "/repos/a", instructionsFile: "/cfg/a.md" },
      { id: "svc-b", path: "/repos/b" },
    ],
  });
  const targets = instructionTargets(cfg);
  assert.deepEqual(targets, [{ path: path.resolve("/cfg/a.md"), scope: "repo", ids: ["svc-a"] }]);

  const noRepos = baseCfg({ repoPath: "/repos/default" });
  assert.deepEqual(instructionTargets(noRepos), []);
});

test("same path in several roles -> single entry, highest-precedence scope, union of ids in step/default/repo order", () => {
  const cfg = baseCfg({
    instructionsFile: "/cfg/shared.md",
    pipeline: [
      { id: "code", instructionsFile: "/cfg/shared.md" },
      { id: "triage" }, // falls back to cfg.instructionsFile === shared.md
    ],
    repos: [{ id: "svc-a", path: "/repos/a", instructionsFile: "/cfg/shared.md" }],
  });
  const targets = instructionTargets(cfg);
  assert.deepEqual(targets, [{ path: path.resolve("/cfg/shared.md"), scope: "step", ids: ["code", "triage", "svc-a"] }]);
});

test("all paths come out absolute even from relative fixtures", () => {
  const cfg = baseCfg({
    instructionsFile: "cfg/INSTRUCTIONS.md",
    pipeline: [{ id: "code", instructionsFile: "cfg/code.md" }],
    repos: [{ id: "svc-a", path: "repos/a", instructionsFile: "cfg/a.md" }],
  });
  for (const t of instructionTargets(cfg)) {
    assert.equal(t.path, path.resolve(t.path));
  }
});
