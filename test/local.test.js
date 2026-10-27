import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Local/offline tracker — pure-unit coverage (no network, no spawn): board seeding,
// fetchTask, stage transitions in advance (advance/fail/hold/changes), listResting as
// the driver's work source, and usesPR:false in describe().
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalAdapter, seedBoard, localBoardPath, extractRouteKeys, createdJob } from "../src/trackers/local.js";
import { createStore } from "../src/store.js";
import { resolveRepo } from "../src/repos.js";

const pipeline = [
  { id: "triage", kind: "triage", sourceStatus: "triage", successStatus: "code", failureStatus: "blocked", holdStatus: "held" },
  { id: "code", kind: "implement", sourceStatus: "code", successStatus: "review", failureStatus: "blocked", createsWorktree: true },
  { id: "review", kind: "review", sourceStatus: "review", successStatus: "done", failureStatus: "blocked" },
  { id: "done", manual: true, sourceStatus: "done", drainWorktree: true },
];

/** Fresh cfg with an isolated tmp dataDir. */
function makeCfg() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-local-test-"));
  return /** @type {any} */ ({ dataDir, trigger: "@agent", pipeline });
}
const adapter = (cfg) => createLocalAdapter(cfg, /** @type {any} */ ({}));

test("describe(): local tracker, usesPR false", () => {
  const a = adapter(makeCfg());
  const m = a.describe();
  assert.equal(m.platform, "Local");
  assert.equal(m.usesPR, false);
});

test("seedBoard + fetchTask + listResting: tasks start in triage", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "E1", name: "easy one", description: "do a thing" }], "triage");
  const a = adapter(cfg);
  const t = await a.fetchTask("E1");
  assert.equal(t.name, "easy one");
  assert.equal(t.description, "do a thing");
  assert.equal(t.completed, false); // triage is not terminal
  const jobs = await a.listResting();
  assert.deepEqual(jobs.map((j) => [j.stepId, j.ref]), [["triage", "E1"]]);
});

test("advance walks triage -> code -> review -> done (terminal)", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "E1", name: "x" }], "triage");
  const a = adapter(cfg);

  await a.advance("E1", "triage", { outcome: "advance" });
  assert.deepEqual((await a.listResting()).map((j) => j.stepId), ["code"]);

  await a.advance("E1", "code", { outcome: "advance" });
  assert.deepEqual((await a.listResting()).map((j) => j.stepId), ["review"]);

  await a.advance("E1", "review", { outcome: "advance" });
  // 'done' is manual → not a driver work source → listResting empty (terminal).
  assert.deepEqual(await a.listResting(), []);
  const t = await a.fetchTask("E1");
  assert.equal(t.completed, true);
  const board = JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"));
  assert.equal(board.E1.stage, "done");
});

test("advance changes bounces review back to code (rework loop)", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "M1", name: "y" }], "review");
  const a = adapter(cfg);
  await a.advance("M1", "review", { outcome: "changes", target: "code" });
  assert.deepEqual((await a.listResting()).map((j) => j.stepId), ["code"]);
});

test("advance fail routes to failure stage (terminal)", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "H1", name: "z" }], "code");
  const a = adapter(cfg);
  await a.advance("H1", "code", { outcome: "fail" });
  assert.deepEqual(await a.listResting(), []); // 'blocked' sources no step
  const board = JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"));
  assert.equal(board.H1.stage, "blocked");
});

test("advance hold with no holdStatus leaves task in place", async () => {
  const cfg = makeCfg();
  // code step has no holdStatus → hold is a no-op move.
  seedBoard(cfg, [{ ref: "E1", name: "x" }], "code");
  const a = adapter(cfg);
  await a.advance("E1", "code", { outcome: "hold" });
  const board = JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"));
  assert.equal(board.E1.stage, "code");
});

test("concurrent advances on the board do not lose updates", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "A", name: "a" }, { ref: "B", name: "b" }, { ref: "C", name: "c" }], "triage");
  const a = adapter(cfg);
  await Promise.all([
    a.advance("A", "triage", { outcome: "advance" }),
    a.advance("B", "triage", { outcome: "advance" }),
    a.advance("C", "triage", { outcome: "advance" }),
  ]);
  const board = JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"));
  assert.equal(board.A.stage, "code");
  assert.equal(board.B.stage, "code");
  assert.equal(board.C.stage, "code");
});

test("listQueued returns tasks in the step's queueStatus, board order; [] without the key", async () => {
  const cfg = makeCfg();
  cfg.pipeline = pipeline.map((s) => (s.id === "code" ? { ...s, queueStatus: "backlog" } : s));
  const a = adapter(cfg);
  seedBoard(cfg, [{ ref: "Q1", name: "one" }, { ref: "Q2", name: "two" }], "backlog");
  assert.deepEqual(await a.listQueued("code"), ["Q1", "Q2"]);
  assert.deepEqual(await a.listQueued("review"), []);
});

test("describe().stageKeys names the status binding family", () => {
  const m = adapter(makeCfg()).describe();
  assert.deepEqual(m.stageKeys, {
    source: "sourceStatus",
    success: "successStatus",
    failure: "failureStatus",
    hold: "holdStatus",
    queue: "queueStatus",
  });
});

test("listStages unions every pipeline-bound status with stages sitting on the board", async () => {
  const cfg = makeCfg();
  // "parking-lot" is a board-only stage, not bound to any step's …Status key — it must
  // still show up because listStages also reads the board file.
  seedBoard(cfg, [{ ref: "E1", name: "x" }, { ref: "E2", name: "y" }], "triage");
  const board = JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"));
  board.E2.stage = "parking-lot";
  fs.writeFileSync(localBoardPath(cfg), JSON.stringify(board, null, 2) + "\n");
  const stages = await adapter(cfg).listStages();
  const ids = stages.map((s) => s.id).sort();
  assert.deepEqual(ids, ["blocked", "code", "done", "held", "parking-lot", "review", "triage"]);
  for (const s of stages) assert.equal(s.id, s.label);
});

test("extractRouteKeys: string, array, absent, unset", () => {
  assert.deepEqual(extractRouteKeys({ platform: "ios" }, "platform"), ["ios"]);
  assert.deepEqual(extractRouteKeys({ platform: ["ios", "", 3, "web"] }, "platform"), ["ios", "web"]);
  assert.deepEqual(extractRouteKeys({}, "platform"), []);
  assert.deepEqual(extractRouteKeys({ platform: 5 }, "platform"), []);
  assert.deepEqual(extractRouteKeys({ platform: "ios" }, undefined), []);
});

test("routing e2e: seedBoard keeps the extra field → fetchTask routeKeys → resolveRepo", async () => {
  const cfg = makeCfg();
  cfg.providerConfig = { routeField: "platform" };
  cfg.repos = [
    { id: "web", path: "/w", match: [], default: true },
    { id: "ios", path: "/i", match: ["ios"] },
  ];
  const board = seedBoard(cfg, [{ ref: "R1", name: "a", platform: "ios" }, { ref: "R2", name: "b", platform: "zzz" }], "triage");
  assert.equal(board.R1.platform, "ios");
  const a = adapter(cfg);
  const t1 = await a.fetchTask("R1");
  assert.deepEqual(t1.routeKeys, ["ios"]);
  assert.equal(/** @type {any} */ (resolveRepo(cfg, t1.routeKeys)).repo.id, "ios");
  const t2 = await a.fetchTask("R2");
  assert.equal(/** @type {any} */ (resolveRepo(cfg, t2.routeKeys)).repo.id, "web");
  cfg.providerConfig = undefined;
  assert.deepEqual((await adapter(cfg).fetchTask("R1")).routeKeys, []);
});

// ── In-process push (onJobs) ──────────────────────────────────────────────────

/** An adapter with a sink wired; returns it plus the pushed jobs. */
function wired(cfg) {
  const a = adapter(cfg);
  /** @type {any[]} */
  const pushed = [];
  a.onJobs?.((jobs) => pushed.push(...jobs));
  return { a, pushed };
}

test("onJobs: advance into the next step's source pushes exactly one secmove job", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "P1", name: "x" }], "triage");
  const { a, pushed } = wired(cfg);
  await a.advance("P1", "triage", { outcome: "advance" });
  assert.deepEqual(pushed, [{ kind: "pipeline", ref: "P1", stepId: "code", dedupKey: "secmove:1" }]);
  // The job never sees the old stage: the board write landed before the push.
  assert.equal(JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8")).P1.stage, "code");
});

test("onJobs: advance to a stage no step sources (failure, hold) pushes nothing", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "P1", name: "x" }, { ref: "P2", name: "y" }], "triage");
  const { a, pushed } = wired(cfg);
  await a.advance("P1", "triage", { outcome: "fail" });
  await a.advance("P2", "triage", { outcome: "hold" });
  assert.deepEqual(pushed, []);
});

test("onJobs: advance into a MANUAL step's source pushes a job for it (drain + pipeline_done)", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "P1", name: "x" }], "review");
  const { a, pushed } = wired(cfg);
  await a.advance("P1", "review", { outcome: "advance" });
  assert.deepEqual(pushed.map((j) => j.stepId), ["done"]);
});

test("onJobs: changes pushes the target step; enterStage pushes the entered step", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "P1", name: "x" }, { ref: "P2", name: "y" }], "review");
  const { a, pushed } = wired(cfg);
  await a.advance("P1", "review", { outcome: "changes", target: "code" });
  await a.enterStage?.("P2", "triage");
  assert.deepEqual(pushed.map((j) => [j.ref, j.stepId, j.dedupKey]), [["P1", "code", "secmove:1"], ["P2", "triage", "secmove:2"]]);
});

test("onJobs: the move counter is monotonic across adapters and survives seedBoard", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "P1", name: "x" }], "triage");
  const first = wired(cfg);
  await first.a.advance("P1", "triage", { outcome: "advance" });
  await first.a.advance("P1", "code", { outcome: "advance" });
  seedBoard(cfg, [{ ref: "P1", name: "x" }], "triage"); // resets the board, not the counter
  const second = wired(cfg);
  await second.a.advance("P1", "triage", { outcome: "advance" });
  const keys = [...first.pushed, ...second.pushed].map((j) => j.dedupKey);
  assert.deepEqual(keys, ["secmove:1", "secmove:2", "secmove:3"]);
});

test("onJobs: a replayed move is deduped by the store's seen set", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "P1", name: "x" }], "triage");
  const { a, pushed } = wired(cfg);
  await a.advance("P1", "triage", { outcome: "advance" });
  const store = createStore(cfg.dataDir);
  const [job] = pushed;
  assert.equal(store.hasSeen(job.dedupKey), false);
  store.markSeen(job.dedupKey);
  assert.equal(createStore(cfg.dataDir).hasSeen(job.dedupKey), true, "same key on replay → intake skips it");
});

test("onJobs: unwired, moves push nothing and don't throw (offline driver path)", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "P1", name: "x" }], "triage");
  const a = adapter(cfg);
  await a.advance("P1", "triage", { outcome: "advance" });
  await a.enterStage?.("P1", "review");
  assert.equal(fs.existsSync(path.join(cfg.dataDir, "local-seq.json")), false, "no counter bumped without a sink");
});

test("enterStage on a missing task throws, and later moves still land", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "P1", name: "x" }], "triage");
  const { a, pushed } = wired(cfg);
  await assert.rejects(() => /** @type {any} */ (a.enterStage)("nope", "code"), /no task "nope"/);
  await a.advance("P1", "triage", { outcome: "advance" });
  assert.deepEqual(pushed.map((j) => j.stepId), ["code"]);
});

test("createdJob: step:<id>:<ref> for a source stage (manual too); null for an unbound one", () => {
  const cfg = makeCfg();
  assert.deepEqual(createdJob(cfg, "7", "triage"), { kind: "pipeline", ref: "7", stepId: "triage", dedupKey: "step:triage:7" });
  assert.equal(createdJob(cfg, "7", "done")?.stepId, "done");
  assert.equal(createdJob(cfg, "7", "backlog"), null);
});

test("currentStage: null for an unbound stage, the stage for a pipeline-bound one", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "B1", name: "x" }, { ref: "C1", name: "y" }], "code");
  const board = JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"));
  board.B1.stage = "backlog";
  fs.writeFileSync(localBoardPath(cfg), JSON.stringify(board));
  const a = adapter(cfg);
  assert.equal(await a.currentStage?.("B1"), null);
  assert.equal(await a.currentStage?.("C1"), "code");
  assert.equal(await a.currentStage?.("missing"), null);
  // A backlog item has not entered the pipeline, so it is not completed (ops `run` would refuse it).
  assert.equal((await a.fetchTask("B1")).completed, false);
});

// ── Single-item add (createTask — `agenthook ticket add`) ─────────────────────

test("createTask: next numeric ref at the first non-manual step's source; unwired pushes nothing", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "E1", name: "named ref" }, { ref: "7", name: "seven" }], "code");
  const a = adapter(cfg);
  const r = await /** @type {any} */ (a.createTask)({ name: "  add a thing ", description: "why" });
  assert.deepEqual(r, { ref: "8", stage: "triage", stepId: "triage" });
  const board = JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"));
  assert.deepEqual(board["8"], { name: "add a thing", description: "why", url: "local://8", stage: "triage" });
  assert.equal(board.E1.name, "named ref", "the rest of the board is kept (not a reseed)");
  assert.equal(fs.existsSync(path.join(cfg.dataDir, "local-seq.json")), false);
});

test("createTask: an empty board starts at ref 1; concurrent adds never share a ref", async () => {
  const cfg = makeCfg();
  const a = /** @type {any} */ (adapter(cfg));
  const refs = await Promise.all([a.createTask({ name: "a" }), a.createTask({ name: "b" }), a.createTask({ name: "c" })]);
  assert.deepEqual(refs.map((r) => r.ref), ["1", "2", "3"]);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"))).length, 3);
});

test("createTask: with a sink, pushes exactly one created-in-stage job after the write", async () => {
  const cfg = makeCfg();
  const { a, pushed } = wired(cfg);
  /** @type {any[]} */
  const stagesAtPush = [];
  a.onJobs?.((jobs) => {
    pushed.push(...jobs);
    stagesAtPush.push(JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"))[jobs[0].ref]?.stage);
  });
  const r = await /** @type {any} */ (a.createTask)({ name: "x", stepId: "code" });
  assert.deepEqual(r, { ref: "1", stage: "code", stepId: "code" });
  assert.deepEqual(pushed, [{ kind: "pipeline", ref: "1", stepId: "code", dedupKey: "step:code:1" }]);
  assert.deepEqual(stagesAtPush, ["code"], "the board already holds the item when its job is pushed");
});

test("createTask: --step review lands in review; a manual or unknown step throws, writing nothing", async () => {
  const cfg = makeCfg();
  const a = /** @type {any} */ (adapter(cfg));
  assert.equal((await a.createTask({ name: "x", stepId: "review" })).stage, "review");
  await assert.rejects(() => a.createTask({ name: "y", stepId: "done" }), /manual/);
  await assert.rejects(() => a.createTask({ name: "y", stepId: "nope" }), /no step "nope"/);
  await assert.rejects(() => a.createTask({ name: "  " }), /needs a name/);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"))), ["1"]);
});

// ── Done signal (#585): completed = a manual step's source stage, nothing else ──

test("fetchTask().completed: failure stage → false, hold stage → false, unbound → false, manual done stage → true", async () => {
  const cfg = makeCfg();
  seedBoard(cfg, [{ ref: "F", name: "f" }, { ref: "H", name: "h" }, { ref: "B", name: "b" }, { ref: "D", name: "d" }], "triage");
  const board = JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"));
  Object.assign(board.F, { stage: "blocked" });
  Object.assign(board.H, { stage: "held" });
  Object.assign(board.B, { stage: "backlog" });
  Object.assign(board.D, { stage: "done" });
  fs.writeFileSync(localBoardPath(cfg), JSON.stringify(board));
  const a = adapter(cfg);
  assert.equal((await a.fetchTask("F")).completed, false, "failure stage");
  assert.equal((await a.fetchTask("H")).completed, false, "hold stage");
  assert.equal((await a.fetchTask("B")).completed, false, "unbound stage");
  assert.equal((await a.fetchTask("D")).completed, true, "manual step's source stage");
});
