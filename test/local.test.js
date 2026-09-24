// Local/offline tracker — pure-unit coverage (no network, no spawn): board seeding,
// fetchTask, stage transitions in advance (advance/fail/hold/changes), listResting as
// the driver's work source, and usesPR:false in describe().
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalAdapter, seedBoard, localBoardPath, extractRouteKeys } from "../src/trackers/local.js";
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
