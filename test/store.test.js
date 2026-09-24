import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-store-"));

test("secrets round-trip, persist across instances, and are written 0600", () => {
  const dir = tmpDir();
  const s = createStore(dir);
  assert.equal(s.getSecret("/mytasks"), undefined);
  s.setSecret("/mytasks", "abc");
  assert.equal(s.getSecret("/mytasks"), "abc");
  assert.equal(s.secretCount(), 1);

  const mode = fs.statSync(path.join(dir, "secrets.json")).mode & 0o777;
  assert.equal(mode, 0o600, "secrets file must be owner-only");

  // a fresh store over the same dir reads what the first wrote
  assert.equal(createStore(dir).getSecret("/mytasks"), "abc");
});

test("seen set marks/checks/unmarks and reloadSeen picks up out-of-band edits", () => {
  const dir = tmpDir();
  const s = createStore(dir);
  assert.equal(s.hasSeen("k1"), false);
  s.markSeen("k1");
  assert.equal(s.hasSeen("k1"), true);
  assert.equal(s.seenCount(), 1);

  // simulate the catchup CLI editing seen.json under us
  fs.writeFileSync(s.seenFile, JSON.stringify(["k1", "k2"]));
  assert.equal(s.hasSeen("k2"), false, "in-memory set masks the edit until reload");
  s.reloadSeen();
  assert.equal(s.hasSeen("k2"), true, "reloadSeen is the source of truth");

  s.unmarkSeen("k2");
  assert.equal(s.hasSeen("k2"), false);
});

test("running jobs set/list/clear by ref (crash-recovery state)", () => {
  const dir = tmpDir();
  const s = createStore(dir);
  s.setRunning("T1", { stepId: "code", pid: 123 });
  assert.deepEqual(s.listRunning(), { T1: { stepId: "code", pid: 123 } });
  s.setRunning("T2", { stepId: "review", pid: 456 });
  assert.equal(Object.keys(s.listRunning()).length, 2);
  s.clearRunning("T1");
  assert.deepEqual(Object.keys(s.listRunning()), ["T2"]);
});

test("recordUsage appends and readUsage round-trips records (newest-last)", () => {
  const dir = tmpDir();
  const s = createStore(dir);
  assert.deepEqual(s.readUsage(), [], "no file yet -> empty list");
  const r1 = { ref: "1", stepId: "code", input: 100, output: 20, costUsd: 0.03 };
  const r2 = { ref: "2", stepId: "review", input: 50, output: 10, costUsd: 0.01 };
  s.recordUsage(r1);
  s.recordUsage(r2);
  assert.deepEqual(s.readUsage(), [r1, r2]);
  // a fresh store over the same dir reads the appended log
  assert.deepEqual(createStore(dir).readUsage(), [r1, r2]);
});

test("readUsage tolerates a trailing/garbage line", () => {
  const dir = tmpDir();
  const s = createStore(dir);
  const rec = { ref: "1", stepId: "code", input: 1, output: 2 };
  s.recordUsage(rec);
  // simulate a partial/torn append (e.g. crash mid-write)
  fs.appendFileSync(path.join(dir, "usage.jsonl"), '{"ref":"2","stepId":"rev');
  assert.deepEqual(s.readUsage(), [rec], "garbage line skipped, good record kept");
});

test("attempt counters bump/get/clear per (ref,step) — the changes-loop cap", () => {
  const dir = tmpDir();
  const s = createStore(dir);
  assert.equal(s.getAttempt("T1", "code"), 0);
  assert.equal(s.bumpAttempt("T1", "code"), 1);
  assert.equal(s.bumpAttempt("T1", "code"), 2);
  assert.equal(s.getAttempt("T1", "code"), 2);
  assert.equal(s.getAttempt("T1", "review"), 0, "counters are per-step");
  s.clearAttempts("T1");
  assert.equal(s.getAttempt("T1", "code"), 0);
});

test("held record set/get/clear per ref and persists to held.json", () => {
  const dir = tmpDir();
  const s = createStore(dir);
  assert.equal(s.getHeld("T1"), undefined);
  const info = { stepId: "triage", reason: "which DB?", heldAt: "2026-09-24T00:00:00.000Z" };
  s.setHeld("T1", info);
  s.setHeld("T2", { stepId: "code", heldAt: "2026-09-24T00:00:01.000Z" });
  assert.deepEqual(s.getHeld("T1"), info);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "held.json"), "utf8")).T1, info, "written to held.json");
  // a fresh store over the same dir reads what the first wrote
  assert.deepEqual(createStore(dir).getHeld("T1"), info);
  s.clearHeld("T1");
  assert.equal(s.getHeld("T1"), undefined);
  assert.equal(s.getHeld("T2")?.stepId, "code", "clearing one ref leaves the others");
});

test("refmeta set shallow-merges, lists, and persists across instances", () => {
  const dir = tmpDir();
  const s = createStore(dir);
  assert.equal(s.getRefMeta("123"), undefined);
  assert.deepEqual(s.listRefMeta(), {});
  s.setRefMeta("123", { displayId: "ID-1", title: "First" });
  s.setRefMeta("123", { pr: 42 }); // later PR lookup keeps id/title
  s.setRefMeta("123", { displayId: undefined, title: "Renamed" }); // undefined never erases
  assert.deepEqual(s.getRefMeta("123"), { displayId: "ID-1", title: "Renamed", pr: 42 });
  s.setRefMeta("456", { title: "Other" });
  assert.deepEqual(Object.keys(createStore(dir).listRefMeta()).sort(), ["123", "456"]);
  assert.equal(createStore(dir).getRefMeta("123")?.pr, 42);
});

test("findings set/get/clear round-trip and persist across instances", () => {
  const dir = tmpDir();
  const s = createStore(dir);
  assert.equal(s.getFindings("7"), undefined);
  s.setFindings("7", { target: "code", fromStep: "review", text: "fix A" });
  s.setFindings("7", { target: "code", fromStep: "review", text: "fix B" });
  assert.equal(createStore(dir).getFindings("7").text, "fix B");
  s.clearFindings("7");
  assert.equal(createStore(dir).getFindings("7"), undefined);
});

test("queue.json round-trips in insertion order and dedups by ref:stepId", () => {
  const dir = tmpDir();
  const s = createStore(dir);
  const j = (ref, stepId) => ({ kind: "pipeline", ref, stepId, dedupKey: `${ref}:${stepId}` });
  assert.deepEqual(s.listQueued(), []);
  s.addQueued(j("A", "code"));
  s.addQueued(j("B", "code"));
  s.addQueued(j("A", "code"));
  s.addQueued(j("A", "review"));
  assert.deepEqual(createStore(dir).listQueued().map((x) => `${x.ref}:${x.stepId}`), ["A:code", "B:code", "A:review"]);
  s.removeQueued(j("B", "code"));
  s.removeQueued(j("Z", "code"));
  assert.deepEqual(s.listQueued().map((x) => `${x.ref}:${x.stepId}`), ["A:code", "A:review"]);
});

test("queue.json dedup includes kind: a merge job and its ref's pipeline job coexist", () => {
  const dir = tmpDir();
  const s = createStore(dir);
  const pipe = { kind: "pipeline", ref: "A", stepId: "done", dedupKey: "step:done:A" };
  const merge = { kind: "merge", ref: "A", stepId: "done", dedupKey: "merged:5" };
  s.addQueued(merge);
  s.addQueued(pipe);
  s.addQueued({ ...merge, dedupKey: "merged:6" });
  assert.deepEqual(s.listQueued().map((x) => x.kind), ["merge", "pipeline"]);
  s.removeQueued(pipe);
  assert.deepEqual(s.listQueued().map((x) => x.kind), ["merge"]);
  s.addQueued(pipe);
  s.removeQueued(merge);
  assert.deepEqual(s.listQueued().map((x) => x.kind), ["pipeline"]);
});

test("isStateDedupKey: only step: keys are state-based", async () => {
  const { isStateDedupKey } = await import("../src/store.js");
  assert.equal(isStateDedupKey("step:code:88"), true);
  assert.equal(isStateDedupKey("secmove:123"), false);
  assert.equal(isStateDedupKey("unblock:x"), false);
  assert.equal(isStateDedupKey(undefined), false);
});

test("overlap guard: paths.json / locks.json / overlap.json round-trip and persist", () => {
  const dir = tmpDir();
  const s = createStore(dir);
  assert.equal(s.getPredictedPaths("T1"), undefined);
  assert.deepEqual(s.listLocks(), {});
  assert.deepEqual(s.listOverlap(), {});

  s.setPredictedPaths("T1", ["src/a.js", "lib/"]);
  s.setLock("T1", { paths: ["src/a.js"], stepId: "code" });
  s.setLock("T2", { paths: ["docs/"], stepId: "review" });
  s.setOverlap("T3", { stepId: "code", blockedBy: "T1", heldAt: "2026-01-01T00:00:00.000Z" });

  const s2 = createStore(dir); // a fresh store reads what the first wrote
  assert.deepEqual(s2.getPredictedPaths("T1"), ["src/a.js", "lib/"]);
  assert.deepEqual(s2.getLock("T1"), { paths: ["src/a.js"], stepId: "code" });
  assert.deepEqual(Object.keys(s2.listLocks()), ["T1", "T2"]);
  assert.deepEqual(s2.getOverlap("T3"), { stepId: "code", blockedBy: "T1", heldAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(fs.existsSync(path.join(dir, "held.json")), false, "overlap state never touches held.json");

  s2.clearPredictedPaths("T1");
  s2.clearLock("T1");
  s2.clearOverlap("T3");
  assert.equal(s2.getPredictedPaths("T1"), undefined);
  assert.deepEqual(Object.keys(s2.listLocks()), ["T2"]);
  assert.deepEqual(s2.listOverlap(), {});
});

test("overlap guard: clearing an absent ref writes no file", () => {
  const dir = tmpDir();
  const s = createStore(dir);
  s.clearPredictedPaths("X");
  s.clearLock("X");
  s.clearOverlap("X");
  for (const f of ["paths.json", "locks.json", "overlap.json"]) assert.equal(fs.existsSync(path.join(dir, f)), false);
});
