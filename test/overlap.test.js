// File-overlap guard (#91): the pure matchers in src/overlap.js, then the gate + every
// release point driven through the real dispatcher (a fake `claude` sh script, no
// network) and the engine's releaser / crash recovery with an intake spy.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathsOverlap, findBlocker, sanitizePaths, unionPaths, staleOverlaps, MAX_PATHS } from "../src/overlap.js";
import { createDispatcher } from "../src/dispatch.js";
import { createOverlapReleaser, recoverInterrupted } from "../src/engine.js";
import { createStore } from "../src/store.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-overlap-"));

// --- pure helpers ---

test("pathsOverlap: exact, directory prefix, no fuzzy match", () => {
  assert.equal(pathsOverlap("src/a.js", "src/a.js"), true);
  assert.equal(pathsOverlap("src/", "src/a.js"), true);
  assert.equal(pathsOverlap("src/a.js", "src/"), true, "symmetric");
  assert.equal(pathsOverlap("src/a.js", "src/b.js"), false);
  assert.equal(pathsOverlap("src", "src/a.js"), false, "no trailing slash = a file, not a dir");
  assert.equal(pathsOverlap("src/", "srcx/a.js"), false);
});

test("findBlocker: first OTHER ref in stable key order whose lock overlaps", () => {
  const locks = {
    Z: { paths: ["src/"], stepId: "code" },
    B: { paths: ["src/a.js"], stepId: "code" },
    SELF: { paths: ["src/a.js"], stepId: "code" },
  };
  assert.equal(findBlocker("SELF", ["src/a.js"], locks), "B");
  assert.equal(findBlocker("SELF", ["src/zz.js"], locks), "Z");
  assert.equal(findBlocker("SELF", ["docs/x.md"], locks), undefined);
  assert.equal(findBlocker("SELF", [], locks), undefined, "no prediction → never gated");
});

test("sanitizePaths: drops non-strings, empties, absolute and .. paths; strips ./; dedupes", () => {
  assert.deepEqual(
    sanitizePaths(["./src/a.js", "src/a.js", "", "  ", 5, null, "/etc/passwd", "C:\\x", "../up.js", "a/../b.js", "dir/", "a..b.js"]),
    ["src/a.js", "dir/", "a..b.js"],
  );
  assert.equal(sanitizePaths("src/a.js"), undefined, "not an array");
  assert.equal(sanitizePaths([]), undefined);
  assert.equal(sanitizePaths(["/abs"]), undefined, "nothing survives → undefined");
});

test("sanitizePaths: caps at MAX_PATHS (200)", () => {
  const many = Array.from({ length: 250 }, (_, i) => `f${i}.js`);
  const out = sanitizePaths(many);
  assert.equal(MAX_PATHS, 200);
  assert.equal(out?.length, 200);
  assert.equal(out?.[199], "f199.js");
});

test("unionPaths / staleOverlaps", () => {
  assert.deepEqual(unionPaths(["a", "b"], ["b", "c"]), ["a", "b", "c"]);
  const overlap = { B: { stepId: "code", blockedBy: "A", heldAt: "t" }, C: { stepId: "code", blockedBy: "X", heldAt: "t" } };
  assert.deepEqual(staleOverlaps(overlap, { A: { paths: ["a"], stepId: "code" } }), ["C"]);
});

// --- the gate + releases through the real dispatcher ---

/**
 * A dispatcher over a real store in a temp dir, a fake `claude` that records it ran (and
 * a snapshot of locks.json at spawn time), and the engine's real releaser wired to an
 * intake spy. The worktree dir is pre-created per ref (mkWt) so no git is needed.
 * @param {{steps?: any[], assignedToUs?: boolean, overlapGuard?: boolean}} [o]
 */
function harness(o = {}) {
  const dir = tmpDir();
  const bin = path.join(dir, "fake-claude.sh");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s' "$2" > "$FAKE_PROMPT_OUT"\ncp "$FAKE_DATA/locks.json" "$FAKE_LOCKS_AT_SPAWN" 2>/dev/null || echo '{}' > "$FAKE_LOCKS_AT_SPAWN"\nprintf '%s' "$FAKE_VERDICT" > "$AGENTHOOK_VERDICT_FILE"\n`,
    { mode: 0o755 },
  );
  const cfg = /** @type {any} */ ({
    pipeline: o.steps || [
      { id: "triage", kind: "triage" },
      { id: "code", createsWorktree: true },
      { id: "review", kind: "review" },
      { id: "done", manual: true, drainWorktree: true },
    ],
    overlapGuard: o.overlapGuard ?? true,
    claudeBin: bin,
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const advanced = [];
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const intaken = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: o.assignedToUs ?? true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ v) => advanced.push([ref, stepId, v.outcome]),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ extra) => events.push({ event, ref, step, ...extra });
  const intake = (/** @type {any[]} */ jobs, /** @type {any} */ opts) => intaken.push({ jobs, opts });
  const release = cfg.overlapGuard ? createOverlapReleaser(store, intake, emit) : undefined;
  const run = createDispatcher(cfg, adapter, undefined, store, emit, release);
  const promptOut = path.join(dir, "prompt.txt");
  const locksAtSpawn = path.join(dir, "locks-at-spawn.json");
  /** @param {string} ref */
  const mkWt = (ref) => fs.mkdirSync(path.join(dir, "wt", ref), { recursive: true });
  /** @param {string} ref @param {string} stepId @param {any} [verdict] @param {Partial<import('../src/types.js').Job>} [job] */
  const runStep = async (ref, stepId, verdict = { outcome: "advance" }, job = {}) => {
    fs.rmSync(promptOut, { force: true });
    fs.rmSync(locksAtSpawn, { force: true });
    Object.assign(process.env, { FAKE_VERDICT: JSON.stringify(verdict), FAKE_PROMPT_OUT: promptOut, FAKE_DATA: dir, FAKE_LOCKS_AT_SPAWN: locksAtSpawn });
    const [log, err] = [console.log, console.error];
    console.log = () => {};
    console.error = () => {};
    try {
      return await run({ kind: "pipeline", ref, stepId, dedupKey: `step:${stepId}:${ref}`, ...job });
    } finally {
      console.log = log;
      console.error = err;
    }
  };
  const spawned = () => fs.existsSync(promptOut);
  const lockSnapshot = () => JSON.parse(fs.readFileSync(locksAtSpawn, "utf8"));
  return { dir, store, advanced, events, intaken, run, runStep, mkWt, spawned, lockSnapshot, promptOut };
}

test("gate: B's predicted paths overlap A's lock → no spawn, no advance, no attempt; overlap.json + overlap_held", async () => {
  const h = harness();
  h.store.setLock("A", { paths: ["src/"], stepId: "code" });
  h.store.setPredictedPaths("B", ["src/a.js"]);
  const out = await h.runStep("B", "code");
  assert.equal(out.code, 0);
  assert.equal(h.spawned(), false, "claude never spawned");
  assert.deepEqual(h.advanced, [], "task rests in its source stage");
  assert.equal(h.store.getAttempt("B", "code"), 0, "no attempt bump");
  assert.equal(h.store.getLock("B"), undefined, "a held ref takes no lock");
  const ov = h.store.getOverlap("B");
  assert.equal(ov?.stepId, "code");
  assert.equal(ov?.blockedBy, "A");
  assert.ok(ov?.heldAt);
  assert.deepEqual(h.events, [{ event: "overlap_held", ref: "B", step: "code", blockedBy: "A" }]);
  assert.equal(fs.existsSync(path.join(h.dir, "wt", "B")) || false, false, "no worktree made for a held ref");
});

test("gate: a ref that already holds a lock (rework) is never gated", async () => {
  const h = harness();
  h.store.setLock("A", { paths: ["src/"], stepId: "code" });
  h.store.setLock("B", { paths: ["src/a.js"], stepId: "review" });
  h.store.setPredictedPaths("B", ["src/a.js"]);
  h.mkWt("B");
  await h.runStep("B", "code");
  assert.equal(h.spawned(), true);
  assert.equal(h.store.getOverlap("B"), undefined);
  assert.equal(h.store.getAttempt("B", "code"), 1);
});

test("gate: passing takes the lock BEFORE spawning; worktree verdict paths union into it", async () => {
  const h = harness();
  h.store.setLock("A", { paths: ["src/a.js"], stepId: "code" });
  h.store.setPredictedPaths("B", ["src/b.js"]);
  h.store.setOverlap("B", { stepId: "code", blockedBy: "A", heldAt: "old" }); // a stale wait
  h.mkWt("B");
  await h.runStep("B", "code", { outcome: "advance", paths: ["./test/b.test.js", "src/b.js", "/etc/passwd", "../x"] });
  assert.equal(h.spawned(), true);
  assert.deepEqual(h.lockSnapshot().B, { paths: ["src/b.js"], stepId: "code" }, "provisional lock present at spawn");
  assert.deepEqual(h.store.getLock("B"), { paths: ["src/b.js", "test/b.test.js"], stepId: "code" }, "sanitised + unioned");
  assert.equal(h.store.getOverlap("B"), undefined, "a real start drops the stale wait");

  // a later worktree step only grows the lock, never narrows it
  await h.runStep("B", "review", { outcome: "advance", paths: ["docs/x.md"] });
  assert.deepEqual(h.store.getLock("B"), { paths: ["src/b.js", "test/b.test.js", "docs/x.md"], stepId: "review" });
});

test("no-worktree step (triage): verdict paths go to paths.json only", async () => {
  const h = harness();
  await h.runStep("C", "triage", { outcome: "advance", paths: ["src/c.js", "lib/"] });
  assert.deepEqual(h.store.getPredictedPaths("C"), ["src/c.js", "lib/"]);
  assert.equal(h.store.getLock("C"), undefined);
});

test("gate: no predicted paths → passes ungated and takes no lock until a verdict writes one", async () => {
  const h = harness();
  h.store.setLock("A", { paths: ["src/"], stepId: "code" });
  h.mkWt("D");
  await h.runStep("D", "code", { outcome: "hold" });
  assert.equal(h.spawned(), true);
  assert.deepEqual(h.lockSnapshot().D, undefined);
  assert.equal(h.store.getLock("D"), undefined);
});

test("prompt: verdict `paths` documented when overlapGuard is on (predict vs touched)", async () => {
  const h = harness();
  await h.runStep("C", "triage");
  assert.match(fs.readFileSync(h.promptOut, "utf8"), /"paths": \[[\s\S]*PREDICT/);
  h.mkWt("C");
  await h.runStep("C", "code");
  assert.match(fs.readFileSync(h.promptOut, "utf8"), /"paths": \[[\s\S]*TOUCHED/);
});

/** Set up A holding a lock with B (and an unrelated E) waiting. @param {ReturnType<typeof harness>} h */
function aBlocksB(h) {
  h.store.setLock("A", { paths: ["src/"], stepId: "code" });
  h.store.setPredictedPaths("A", ["src/"]);
  h.store.setOverlap("B", { stepId: "code", blockedBy: "A", heldAt: "t" });
  h.store.setOverlap("E", { stepId: "code", blockedBy: "OTHER", heldAt: "t" });
}

/** @param {ReturnType<typeof harness>} h */
function assertReleased(h) {
  assert.equal(h.store.getLock("A"), undefined, "A's lock cleared");
  assert.equal(h.store.getOverlap("B"), undefined, "B's wait cleared");
  assert.equal(h.store.getOverlap("E")?.blockedBy, "OTHER", "unrelated waiter untouched");
  assert.deepEqual(h.intaken, [{ jobs: [{ kind: "pipeline", ref: "B", stepId: "code", dedupKey: "overlap:A:B" }], opts: { force: true } }]);
  assert.ok(h.events.some((e) => e.event === "overlap_released" && e.ref === "B" && e.blockedBy === "A"));
}

test("release: the manual drain step clears A's lock + predicted paths and re-intakes B", async () => {
  const h = harness();
  aBlocksB(h);
  await h.runStep("A", "done");
  assertReleased(h);
  assert.equal(h.store.getPredictedPaths("A"), undefined);
});

test("release: a terminal fail clears A's lock and re-intakes B", async () => {
  const h = harness();
  aBlocksB(h);
  h.mkWt("A");
  await h.runStep("A", "code", { outcome: "fail", paths: ["src/x.js"] });
  assertReleased(h);
  assert.equal(h.store.getPredictedPaths("A"), undefined);
});

test("release: a drained agent step clears A's lock and re-intakes B", async () => {
  const h = harness({
    steps: [{ id: "code", createsWorktree: true }, { id: "review", kind: "review", drainWorktree: true }],
  });
  aBlocksB(h);
  h.mkWt("A");
  await h.runStep("A", "review", { outcome: "advance" });
  assertReleased(h);
});

test("release: a mid-pipeline advance/hold keeps A's lock", async () => {
  const h = harness();
  aBlocksB(h);
  h.mkWt("A");
  await h.runStep("A", "code", { outcome: "hold" });
  assert.deepEqual(h.store.getLock("A")?.paths, ["src/"]);
  assert.deepEqual(h.intaken, []);
});

test("release: a forge merge (runMerge) clears A's lock and re-intakes B", async () => {
  const h = harness();
  aBlocksB(h);
  const log = console.log;
  console.log = () => {};
  try {
    await h.run({ kind: "merge", ref: "A", stepId: "", dedupKey: "merged:1" });
  } finally {
    console.log = log;
  }
  assertReleased(h);
});

test("release: a re-intaken B not assigned to us is skipped (fail-closed)", async () => {
  const h = harness({ assignedToUs: false });
  h.store.setPredictedPaths("B", ["src/a.js"]);
  h.mkWt("B");
  await h.runStep("B", "code", { outcome: "advance" }, { dedupKey: "overlap:A:B" });
  assert.equal(h.spawned(), false);
  assert.deepEqual(h.advanced, []);
  assert.equal(h.store.getLock("B"), undefined);
});

test("overlapGuard off: no gate, no overlap files written, no paths in the prompt", async () => {
  const h = harness({ overlapGuard: false });
  await h.runStep("C", "triage", { outcome: "advance", paths: ["src/c.js"] });
  assert.doesNotMatch(fs.readFileSync(h.promptOut, "utf8"), /"paths"/);
  h.mkWt("C");
  await h.runStep("C", "code", { outcome: "fail", paths: ["src/c.js"] });
  await h.runStep("C", "done");
  for (const f of ["paths.json", "locks.json", "overlap.json"]) {
    assert.equal(fs.existsSync(path.join(h.dir, f)), false, `${f} not written`);
  }
  assert.ok(!h.events.some((e) => e.event.startsWith("overlap_")));
});

// --- engine: the releaser and crash recovery ---

test("createOverlapReleaser: clears the lock, wakes only that blocker's waiters", () => {
  const store = createStore(tmpDir());
  store.setLock("A", { paths: ["src/"], stepId: "code" });
  store.setLock("X", { paths: ["lib/"], stepId: "code" });
  store.setOverlap("B", { stepId: "code", blockedBy: "A", heldAt: "t" });
  store.setOverlap("C", { stepId: "review", blockedBy: "A", heldAt: "t" });
  store.setOverlap("D", { stepId: "code", blockedBy: "X", heldAt: "t" });
  /** @type {any[]} */
  const intaken = [];
  /** @type {any[]} */
  const events = [];
  const log = console.log;
  console.log = () => {};
  try {
    createOverlapReleaser(store, (jobs, opts) => intaken.push({ jobs, opts }), (event, ref, step, extra) => events.push({ event, ref, step, ...extra }))("A");
  } finally {
    console.log = log;
  }
  assert.equal(store.getLock("A"), undefined);
  assert.ok(store.getLock("X"));
  assert.deepEqual(Object.keys(store.listOverlap()), ["D"]);
  assert.deepEqual(intaken.map((i) => i.jobs[0].dedupKey), ["overlap:A:B", "overlap:A:C"]);
  assert.deepEqual(intaken.map((i) => i.jobs[0].stepId), ["code", "review"]);
  assert.deepEqual(events.map((e) => [e.event, e.ref, e.blockedBy]), [["overlap_released", "B", "A"], ["overlap_released", "C", "A"]]);
});

test("recoverInterrupted: a crashed A is failed and releases its lock (re-intakes B)", async () => {
  const store = createStore(tmpDir());
  store.setRunning("A", { stepId: "code", startedAt: "t" });
  store.setLock("A", { paths: ["src/"], stepId: "code" });
  store.setPredictedPaths("A", ["src/"]);
  store.setOverlap("B", { stepId: "code", blockedBy: "A", heldAt: "t" });
  /** @type {any[]} */
  const advanced = [];
  /** @type {any[]} */
  const intaken = [];
  const adapter = /** @type {any} */ ({ advance: async (/** @type {string} */ ref, /** @type {string} */ s, /** @type {any} */ v) => advanced.push([ref, s, v.outcome]) });
  const log = console.log;
  console.log = () => {};
  try {
    await recoverInterrupted(store, adapter, () => {}, createOverlapReleaser(store, (jobs) => intaken.push(...jobs)));
  } finally {
    console.log = log;
  }
  assert.deepEqual(advanced, [["A", "code", "fail"]]);
  assert.equal(store.getLock("A"), undefined);
  assert.equal(store.getPredictedPaths("A"), undefined);
  assert.deepEqual(intaken, [{ kind: "pipeline", ref: "B", stepId: "code", dedupKey: "overlap:A:B" }]);
});

test("recoverInterrupted: without a releaser (guard off) overlap state is untouched", async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  store.setRunning("A", { stepId: "code", startedAt: "t" });
  const log = console.log;
  console.log = () => {};
  try {
    await recoverInterrupted(store, /** @type {any} */ ({ advance: async () => {} }), () => {});
  } finally {
    console.log = log;
  }
  assert.equal(fs.existsSync(path.join(dir, "locks.json")), false);
  assert.deepEqual(store.listRunning(), {});
});

test("gate: a worktree failure right after taking the lock releases it again", async () => {
  const h = harness();
  h.store.setPredictedPaths("F", ["src/f.js"]);
  h.store.setOverlap("G", { stepId: "code", blockedBy: "F", heldAt: "t" });
  // repoPath is not a git repo and wt/F doesn't exist → ensureWorktree throws
  await assert.rejects(h.runStep("F", "code"));
  assert.equal(h.store.getLock("F"), undefined);
  assert.equal(h.spawned(), false);
  assert.deepEqual(h.intaken.map((i) => i.jobs[0].dedupKey), ["overlap:F:G"]);
});
