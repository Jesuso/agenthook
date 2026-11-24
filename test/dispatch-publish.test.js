import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The outbox publisher (src/dispatch/publish.js, #825): a remote run's outbox is published by
// the hub with its own credentials — push (workflow guard holds, a rejection fails), draft PR
// (a failure is one log line, never a fail), comment (best effort). A hold/fail coming out of
// publishing IS the applied verdict. Fake forge/tracker; the real GitHub implementations are
// tested separately (test/forge-github-publish.test.js, the tracker postComment tests).
import test from "node:test";
import assert from "node:assert/strict";
import { publishOutbox } from "../src/dispatch/publish.js";

/** One fake forge/adapter/store pair with call recording. @param {object} [o] */
function rig(o = {}) {
  const calls = /** @type {{ push?: (a: any) => any, pr?: (a: any) => any, comment?: (a: any) => any }} */ ({});
  if (o.push !== undefined) calls.push = o.push;
  if (o.pr !== undefined) calls.pr = o.pr;
  if (o.comment !== undefined) calls.comment = o.comment;
  const held = [];
  const refMeta = [];
  const cleared = [];
  const lines = [];
  const log = console.log;
  const forge = {
    describe: () => ({ name: "github" }),
    ...(calls.push ? { publishBranch: async (a) => calls.push(a) } : {}),
    ...(calls.pr ? { openPr: async (a) => calls.pr(a) } : {}),
  };
  const adapter = {
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    ...(calls.comment ? { postComment: async (a, b) => calls.comment(a, b) } : {}),
  };
  const store = {
    setHeld: (ref, info) => held.push({ ref, info }),
    setRefMeta: (ref, patch) => refMeta.push({ ref, patch }),
    clearFindings: (ref) => cleared.push(ref),
  };
  const verdict = { outcome: "advance", reason: "ok" };
  const base = { ref: "42", stepId: "code", remote: true, hasWorktree: true, worktree: "/wt", branch: "agent/42", outbox: {}, verdict, store, reasonHarness: "worker" };
  return {
    calls,
    held,
    refMeta,
    cleared,
    verdict,
    run: (over = {}) =>
      publishOutbox({ ...base, forge: /** @type {any} */ (forge), adapter: /** @type {any} */ (adapter), ...over }).then((res) => {
        console.log = log;
        return res;
      }),
    lines,
  };
}
const quiet = (r) => {
  console.log = () => {};
  void r.lines;
};

test("a non-ssh run, a run without a forge, and a fail verdict publish nothing", async () => {
  for (const [over, want] of [
    [{ remote: false }, "not a remote run"],
    [{ forge: null }, "no forge"],
    [{ verdict: { outcome: "fail", reason: "nope" } }, "outcome fail"],
  ]) {
    const r = rig();
    quiet(r);
    const res = await r.run(/** @type {any} */ (over));
    assert.equal(res.skipped, want, JSON.stringify(res));
    assert.deepEqual(r.calls, {}, "nothing was published");
    console.log = console.log;
  }
});

test("the workflow guard holds BEFORE anything else publishes: no PR, no comment, a held entry is recorded", async () => {
  const r = rig({
    push: () => ({ workflow: ".github/workflows/ci.yml" }),
    pr: () => {
      throw new Error("openPr must not run");
    },
    comment: () => {
      throw new Error("postComment must not run");
    },
  });
  quiet(r);
  const res = await r.run({ outbox: { pr: { title: "t", body: "b" }, comment: "c" } });
  assert.equal(res.held, true);
  assert.equal(res.workflow, ".github/workflows/ci.yml");
  assert.equal(res.pushed, undefined);
  assert.equal(r.verdict.outcome, "hold");
  assert.match(r.verdict.reason, /\.github\/workflows\/ci\.yml/);
  assert.equal(r.held.length, 1);
  assert.equal(r.held[0].info.stepId, "code");
  assert.equal(r.held[0].info.harness, "worker");
  assert.ok(r.held[0].info.heldAt, "the held entry carries a heldAt");
  console.log = console.log;
});

test("a push rejection fails the step with the forge's message and posts neither PR nor comment", async () => {
  const r = rig({
    push: () => {
      throw new Error("pre-receive hook declined");
    },
    pr: () => {
      throw new Error("openPr must not run");
    },
    comment: () => {
      throw new Error("postComment must not run");
    },
  });
  quiet(r);
  const res = await r.run({ outbox: { pr: { title: "t", body: "b" }, comment: "c" } });
  assert.equal(res.failed, "pre-receive hook declined");
  assert.equal(r.verdict.outcome, "fail");
  assert.match(r.verdict.reason, /pre-receive hook declined/);
  assert.deepEqual(r.cleared, ["42"], "the other finish.js rewrites' finding cleanup runs");
  assert.equal(r.held.length, 0);
  console.log = console.log;
});

test("push succeeds, a draft PR is opened against the outbox title, the comment is posted, and the PR number lands in refmeta", async () => {
  const r = rig({
    push: (a) => {
      assert.equal(a.branch, "agent/42");
      assert.equal(a.worktree, "/wt");
      return { pushed: ["origin/agent/42"] };
    },
    pr: (a) => {
      assert.equal(a.title, "Fix the flaky test");
      assert.equal(a.body, "what I did and why");
      assert.equal(a.branch, "agent/42");
      return { number: 31, created: true };
    },
    comment: (ref, body) => {
      assert.equal(ref, "42");
      assert.equal(body, "Ran the suite, here is the result.");
      return undefined;
    },
  });
  quiet(r);
  const res = await r.run({ outbox: { pr: { title: "Fix the flaky test", body: "what I did and why" }, comment: "Ran the suite, here is the result." } });
  assert.equal(res.pushed, true);
  assert.deepEqual(res.pr, { number: 31, created: true });
  assert.equal(res.comment, true);
  assert.equal(r.verdict.outcome, "advance", "a clean publish leaves the verdict untouched");
  assert.deepEqual(r.refMeta, [{ ref: "42", patch: { pr: 31 } }], "the CI roll-up/auto-merge/review see the PR");
  console.log = console.log;
});

test("a rework run reuses the open PR (created:false) — no second PR, the first is not edited", async () => {
  const r = rig({
    push: () => ({ pushed: ["origin/agent/42"] }),
    pr: (a) => {
      assert.equal(a.title, "second pass");
      return { number: 31, created: false };
    },
  });
  quiet(r);
  const res = await r.run({ outbox: { pr: { title: "second pass", body: "rework" } } });
  assert.deepEqual(res.pr, { number: 31, created: false });
  assert.equal(res.pushed, true);
  console.log = console.log;
});

test("a PR open failure and a comment failure each leave one log line and never fail the step", async () => {
  const r = rig({
    push: () => ({ pushed: ["origin/agent/42"] }),
    pr: () => {
      throw new Error("open PR 403: Resource not accessible by integration");
    },
    comment: () => {
      throw new Error("post comment 403");
    },
  });
  quiet(r);
  const res = await r.run({ outbox: { pr: { title: "t", body: "b" }, comment: "c" } });
  assert.equal(res.pushed, true);
  assert.equal(res.pr, undefined);
  assert.equal(res.comment, undefined);
  assert.equal(r.verdict.outcome, "advance", "PR/comment failures never fail the step");
  assert.deepEqual(r.refMeta, [], "no PR number was cached");
  console.log = console.log;
});

test("a forge without openPr and a tracker without postComment each log one skip line and skip the item", async () => {
  const r = rig({ push: () => ({ pushed: [] }) }); // no openPr on the fake forge
  quiet(r);
  const res = await r.run({ outbox: { pr: { title: "t", body: "b" }, comment: "c" } }); // no postComment on the fake adapter
  assert.equal(res.pushed, true);
  assert.equal(res.pr, undefined);
  assert.equal(res.comment, undefined);
  assert.equal(r.verdict.outcome, "advance");
  console.log = console.log;
});

test("no worktree: no push is attempted, pr.json is skipped with a log line, the comment still posts", async () => {
  const r = rig({
    push: () => {
      throw new Error("publishBranch must not run without a worktree");
    },
    comment: () => undefined,
  });
  quiet(r);
  const res = await r.run({ hasWorktree: false, worktree: undefined, branch: undefined, outbox: { pr: { title: "t", body: "b" }, comment: "c" } });
  assert.equal(res.pushed, undefined);
  assert.equal(res.pr, undefined);
  assert.equal(res.comment, true);
  assert.equal(r.verdict.outcome, "advance");
  console.log = console.log;
});

test("an empty outbox (nothing written) publishes only the push", async () => {
  const r = rig({ push: () => ({ pushed: ["origin/agent/42"] }) });
  quiet(r);
  const res = await r.run({ outbox: undefined });
  assert.equal(res.pushed, true);
  assert.equal(res.pr, undefined);
  assert.equal(res.comment, undefined);
  assert.deepEqual(r.refMeta, []);
  console.log = console.log;
});
