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
