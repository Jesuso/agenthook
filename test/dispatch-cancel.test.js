import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Operator cancel (`runClaude.cancel`, the MCP/control `cancel`): kills the live agent and the
// run resolves as `fail` with a "cancelled by operator" reason through the normal advance path.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/dispatch.js";
import { createStore } from "../src/store.js";

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-cancel-"));
  const bin = path.join(dir, "sleepy-claude.sh");
  // exec so the sleep IS the child (no grandchild holding the pipes)
  fs.writeFileSync(bin, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code" }, { id: "done", manual: true }],
    claudeBin: bin, repoPath: dir, worktreePrefix: path.join(dir, "wt"), dataDir: dir, logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  /** @type {any[]} */ const advanced = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ v) => advanced.push({ ref, step, ...v }),
  });
  /** @type {any[]} */ const events = [];
  const run = createDispatcher(cfg, adapter, undefined, store, (e, ref, step, x) => events.push({ e, ref, step, ...x }), undefined, undefined, { killGraceMs: 200 });
  return { store, run, advanced, events };
}

const quiet = async (/** @type {() => Promise<any>} */ fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

test("cancel: false when nothing runs for the ref", () => {
  const { run } = harness();
  assert.equal(run.cancel("nope"), false);
});

test("cancel: kills the live agent; the run advances as fail with the operator reason", async () => {
  const { store, run, advanced, events } = harness();
  const done = quiet(() => run({ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "k" }));
  for (let i = 0; i < 200 && !store.listRunning()["42"]?.pid; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(store.listRunning()["42"]?.pid, "agent is running");
  assert.equal(run.cancel("42"), true);
  await done;
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0].outcome, "fail");
  assert.equal(advanced[0].reason, "cancelled by operator");
  assert.equal(events.find((e) => e.e === "failed")?.reason, "cancelled by operator");
  assert.equal(store.listRunning()["42"], undefined, "running.json cleared");
  assert.equal(run.cancel("42"), false, "pid forgotten after the run");
});
