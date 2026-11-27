import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// A red-CI bounce parked while the CI target step (code) itself is running (#869): when that
// run's own advance lands, the move can't re-fire code the way a downstream step's `changes` →
// target does (re-entering a label it's already in fires no webhook), so the bounce is re-parked
// instead of dropped — provided the PR head is still on the sha that went red and the applied
// verdict (after every rewrite) is still a clean advance.
import test from "node:test";
import assert from "node:assert/strict";
import { ciHarness, ciJob, movingHeadForge, SHA } from "./_ci-helpers.js";

test("ci: a bounce parked while the target step itself runs is re-parked when it advances with the PR head unchanged, then bounced by the late path", async () => {
  const h = ciHarness({ verdict: { outcome: "advance", reason: "done" } });
  h.store.setRunning("7", { stepId: "code", startedAt: new Date().toISOString() });
  await h.run(ciJob(2));
  assert.deepEqual(h.advances, [], "no move while code runs");
  assert.ok(h.events.some((e) => e.event === "ci_red" && e.action === "deferred"));
  h.store.clearRunning("7");
  await h.run({ kind: "pipeline", ref: "7", stepId: "code", dedupKey: "step:code:7" });
  assert.equal(h.advances.length, 2, "code's own advance, then the late path's bounce");
  assert.equal(h.advances[0].stepId, "code");
  assert.equal(h.advances[0].outcome, "advance");
  assert.ok(h.events.some((e) => e.event === "ci_red" && e.action === "bounced" && e.target === "code"), "the late path bounced it back from review");
  assert.equal(h.advances.at(-1).stepId, "review");
  assert.equal(h.advances.at(-1).outcome, "changes");
  assert.equal(h.advances.at(-1).target, "code");
  assert.equal(h.store.takeCiRed("7"), undefined, "parked bounce consumed");
});

test("ci: setCiRed stores the sha a parked bounce was parked at", async () => {
  const h = ciHarness();
  h.store.setRunning("7", { stepId: "code", startedAt: new Date().toISOString() });
  await h.run(ciJob(2));
  assert.ok(h.events.some((e) => e.event === "ci_red" && e.action === "deferred"), "parked while code runs");
  assert.equal(h.store.takeCiRed("7")?.sha, SHA, "parked with the ci job's headSha");
  h.store.clearRunning("7");
});

test("ci: a bounce parked while the target step runs drops if the PR head moved on by the time it advances", async () => {
  const h = ciHarness({ verdict: { outcome: "advance", reason: "done" }, forge: movingHeadForge() });
  h.store.setRunning("7", { stepId: "code", startedAt: new Date().toISOString() });
  await h.run(ciJob(2));
  assert.ok(h.events.some((e) => e.event === "ci_red" && e.action === "deferred"), "parked successfully at the old head");
  h.store.clearRunning("7");
  await h.run({ kind: "pipeline", ref: "7", stepId: "code", dedupKey: "step:code:7" });
  assert.equal(h.advances.length, 1, "only code's own advance — no bounce");
  assert.equal(h.advances[0].stepId, "code");
  assert.ok(!h.events.some((e) => e.event === "ci_red" && e.action === "bounced"));
  assert.equal(h.store.takeCiRed("7"), undefined, "parked bounce consumed, not re-parked");
});

test("ci: a bounce parked while the target step runs drops if the PR head can't be read when it advances", async () => {
  const h = ciHarness({ verdict: { outcome: "advance", reason: "done" }, forge: movingHeadForge({ laterThrows: true }) });
  h.store.setRunning("7", { stepId: "code", startedAt: new Date().toISOString() });
  await h.run(ciJob(2));
  assert.ok(h.events.some((e) => e.event === "ci_red" && e.action === "deferred"), "parked successfully at the old head");
  h.store.clearRunning("7");
  const err = console.error;
  console.error = () => {};
  try {
    await h.run({ kind: "pipeline", ref: "7", stepId: "code", dedupKey: "step:code:7" });
  } finally {
    console.error = err;
  }
  assert.equal(h.advances.length, 1, "only code's own advance — no bounce");
  assert.ok(!h.events.some((e) => e.event === "ci_red" && e.action === "bounced"));
  assert.equal(h.store.takeCiRed("7"), undefined, "parked bounce consumed, not re-parked");
});

test("ci: setCiRed stores the sha; a parked entry without one still drops when the target advances", async () => {
  const h = ciHarness({ verdict: { outcome: "advance", reason: "done" } });
  h.store.setCiRed("7", { target: "code", text: "no sha here" });
  await h.run({ kind: "pipeline", ref: "7", stepId: "code", dedupKey: "step:code:7" });
  assert.equal(h.advances.length, 1, "only code's own advance — no bounce");
  assert.ok(!h.events.some((e) => e.event === "ci_red" && e.action === "bounced"));
  assert.equal(h.store.takeCiRed("7"), undefined, "dropped, not re-parked");
});

test("ci: a target-step advance rewritten to a hold (e.g. by a follow-up check) drops the parked bounce instead of re-parking it", async () => {
  const h = ciHarness({ verdict: { outcome: "advance", reason: "done", followUp: ["verify in prod"] } });
  h.store.setRunning("7", { stepId: "code", startedAt: new Date().toISOString() });
  await h.run(ciJob(2));
  assert.ok(h.events.some((e) => e.event === "ci_red" && e.action === "deferred"), "parked successfully at the old head");
  h.store.clearRunning("7");
  await h.run({ kind: "pipeline", ref: "7", stepId: "code", dedupKey: "step:code:7" });
  assert.equal(h.advances.length, 1, "code's own advance, rewritten to hold by the follow-up gate");
  assert.equal(h.advances[0].outcome, "hold");
  assert.ok(!h.events.some((e) => e.event === "ci_red" && e.action === "bounced"), "no bounce — the move was never a clean advance");
  assert.ok(!h.events.some((e) => e.event === "ci_red" && e.action === "skipped"), "no late-path skip either — the bounce was dropped here, not handed off");
  assert.equal(h.store.takeCiRed("7"), undefined, "parked bounce dropped, not re-parked");
});
