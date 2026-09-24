import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseOnSettle } from "../src/engine.js";

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
