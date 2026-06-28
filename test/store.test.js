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
