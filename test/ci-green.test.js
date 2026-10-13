import "./_setup.js";
// `ci_green`: emitted once per (ref, sha), only when the whole roll-up is green, never
// through the run queue. Fake adapter/forge/store — no network.
import test from "node:test";
import assert from "node:assert/strict";
import { createCiGreen } from "../src/ci-green.js";

const job = (over = {}) => ({
  kind: "ci_green",
  ref: "123",
  stepId: "",
  dedupKey: "cigreen:123:abc",
  ci: { runId: 1, attempt: 1, headSha: "abc", prNumber: 77, url: "u" },
  ...over,
});

function setup({ ci = "success", assigned = true, pr = { number: 77, sha: "abc", open: true }, delay = 0 } = {}) {
  const seen = new Set();
  const events = [];
  let status = { mergeable: true, mergeState: "clean", ci };
  const deps = {
    adapter: { fetchTask: async () => ({ assignedToUs: assigned }) },
    forge: {
      prHead: async () => pr,
      ciStatus: async () => {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        return status;
      },
    },
    store: { reloadSeen() {}, hasSeen: (k) => seen.has(k), markSeen: (k) => seen.add(k) },
    emit: (...a) => events.push(a),
  };
  return { fn: createCiGreen(/** @type {any} */ (deps)), events, seen, set: (s) => (status = { ...status, ...s }) };
}

test("whole roll-up green → one ci_green with pr/sha/mergeable/mergeState", async () => {
  const t = setup();
  assert.equal(await t.fn(/** @type {any} */ (job())), true);
  assert.deepEqual(t.events, [["ci_green", "123", "", { pr: 77, sha: "abc", mergeable: true, mergeState: "clean" }]]);
});

test("another workflow still pending → no event, and a later candidate can still fire", async () => {
  const t = setup({ ci: "pending" });
  assert.equal(await t.fn(/** @type {any} */ (job())), false);
  assert.equal(t.events.length, 0);
  t.set({ ci: "success" });
  assert.equal(await t.fn(/** @type {any} */ (job({ ci: { runId: 2, attempt: 1, headSha: "abc", prNumber: 77, url: "u" } }))), true);
  assert.equal(t.events.length, 1);
});

test("red / none / unknown roll-up → no event", async () => {
  for (const ci of ["failure", "none", "unknown"]) {
    const t = setup({ ci });
    assert.equal(await t.fn(/** @type {any} */ (job())), false, ci);
  }
});

test("at most one per (ref, sha): sequential repeat and concurrent finishers", async () => {
  const t = setup({ delay: 10 });
  const [a, b] = await Promise.all([t.fn(/** @type {any} */ (job())), t.fn(/** @type {any} */ (job()))]);
  assert.deepEqual([a, b].sort(), [false, true]);
  assert.equal(await t.fn(/** @type {any} */ (job())), false);
  assert.equal(t.events.length, 1);
});

test("a new push (new sha) fires again after the old sha fired", async () => {
  const t = setup({ pr: { number: 77, sha: "def", open: true } });
  t.seen.add("cigreen:123:abc"); // the previous head already fired
  const next = job({ dedupKey: "cigreen:123:def", ci: { runId: 3, attempt: 1, headSha: "def", prNumber: 77, url: "u" } });
  assert.equal(await t.fn(/** @type {any} */ (next)), true);
});

test("stale run (PR head moved), closed PR, unassigned task → no event", async () => {
  assert.equal(await setup({ pr: { number: 77, sha: "zzz", open: true } }).fn(/** @type {any} */ (job())), false);
  assert.equal(await setup({ pr: { number: 77, sha: "abc", open: false } }).fn(/** @type {any} */ (job())), false);
  assert.equal(await setup({ assigned: false }).fn(/** @type {any} */ (job())), false);
});

test("forge without ciStatus/prHead → no event", async () => {
  const fn = createCiGreen(/** @type {any} */ ({ adapter: {}, forge: {}, store: { reloadSeen() {}, hasSeen: () => false, markSeen() {} } }));
  assert.equal(await fn(/** @type {any} */ (job())), false);
});
