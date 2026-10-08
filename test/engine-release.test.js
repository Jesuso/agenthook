import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseOnSettle, crashRecord } from "../src/engine.js";

const fakeStore = () => {
  const s = { reloads: 0, unmarked: [], reloadSeen: () => s.reloads++, unmarkSeen: (k) => s.unmarked.push(k) };
  return s;
};

test("releaseOnSettle releases step: key on resolve", async () => {
  const st = fakeStore();
  const run = releaseOnSettle(async () => "ok", st);
  assert.equal(await run({ dedupKey: "step:code:88" }), "ok");
  assert.deepEqual(st.unmarked, ["step:code:88"]);
  assert.equal(st.reloads, 1);
});

test("releaseOnSettle releases step: key on reject and rethrows", async () => {
  const st = fakeStore();
  const run = releaseOnSettle(async () => { throw new Error("boom"); }, st);
  await assert.rejects(run({ dedupKey: "step:code:88" }), /boom/);
  assert.deepEqual(st.unmarked, ["step:code:88"]);
});

test("releaseOnSettle keeps secmove: keys", async () => {
  const st = fakeStore();
  await releaseOnSettle(async () => {}, st)({ dedupKey: "secmove:1" });
  assert.deepEqual(st.unmarked, []);
});

test("crashRecord captures kind, message, stack, and in-flight refs", () => {
  const rec = crashRecord("uncaughtException", new Error("boom"), ["42", "7"]);
  assert.equal(rec.kind, "uncaughtException");
  assert.equal(rec.message, "boom");
  assert.equal(rec.pid, process.pid);
  assert.match(rec.stack, /boom/);
  assert.deepEqual(rec.running, ["42", "7"]);
  assert.ok(rec.at);
});

test("crashRecord wraps a non-Error rejection reason", () => {
  const rec = crashRecord("unhandledRejection", "plain string reason", []);
  assert.equal(rec.message, "plain string reason");
  assert.deepEqual(rec.running, []);
});
