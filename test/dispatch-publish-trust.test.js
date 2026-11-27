import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Publishing trust (src/dispatch/publish.js, #829): a workflow-guard hit that comes only via a
// merge says so in the held reason, and worker-written mentions are made safe in the PR
// title/body and comment. These fakes have no `liveMentions`, so every mention falls back to
// `breakAllMentions` (a zero-width space right after the `@`) — the owner's own login
// (describe().ownerHint) is exempt, and with no owner known every mention is broken (fail
// closed). See test/dispatch-publish-mentions.test.js for the renderer-verified path.
import test from "node:test";
import assert from "node:assert/strict";
import { publishOutbox } from "../src/dispatch/publish.js";

/** One fake forge/adapter pair. @param {object} o */
function rig(o = {}) {
  const lines = [];
  /** @type {any} */ let prArg;
  const forge = {
    describe: () => ({ name: "github" }),
    publishBranch: async () => o.push(),
    openPr: async (/** @type {any} */ a) => {
      prArg = a;
      return { number: 7, created: true };
    },
  };
  const adapter = {
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment", ...(o.ownerHint !== undefined ? { ownerHint: o.ownerHint } : {}) }),
    postComment: async (ref, body) => lines.push(`comment:${body}`),
  };
  const store = { setHeld: () => {}, setRefMeta: () => {}, clearFindings: () => {} };
  const verdict = { outcome: "advance", reason: "ok" };
  const base = { ref: "42", stepId: "code", remote: true, hasWorktree: true, worktree: "/wt", branch: "agent/42", verdict, store, log: (l) => lines.push(l), reasonHarness: "worker" };
  return (over = {}) => publishOutbox({ ...base, forge: /** @type {any} */ (forge), adapter: /** @type {any} */ (adapter), ...over }).then((res) => ({ res, lines, verdict, prArg }));
}

test("a workflow hit only via a merge says so in the held reason; a plain commit doesn't", async () => {
  const via = await rig({ push: () => ({ workflow: ".github/workflows/ci.yml", viaMerge: true }) })({ outbox: { comment: "c" } });
  assert.equal(via.verdict.outcome, "hold");
  assert.match(via.verdict.reason, /include a merge/);
  assert.match(via.verdict.reason, /\.github\/workflows\/ci\.yml/);
  assert.equal(via.lines.length, 0, "no log line, no PR/comment — the hold is the result");

  const plain = await rig({ push: () => ({ workflow: ".github/workflows/ci.yml" }) })({ outbox: { comment: "c" } });
  assert.match(plain.verdict.reason, /commits touch/);
  assert.doesNotMatch(plain.verdict.reason, /include a merge/);
});

test("mentions in the PR title/body and comment are broken; the owner's own login (ownerHint) is exempt", async () => {
  const r = await rig({ push: () => ({ pushed: ["origin/agent/42"] }), ownerHint: "@octo" })({
    outbox: { pr: { title: "Fix @bob's flake", body: "done by @octo and @bob" }, comment: "see @stranger for details" },
  });
  assert.equal(r.res.pushed, true);
  assert.equal(r.res.comment, true);
  // the comment posted has every foreign mention broken (fake forge has no liveMentions)
  const posted = r.lines.find((l) => l.startsWith("comment:")) ?? "";
  assert.equal(posted, "comment:see @\u200bstranger for details");
  // the PR was opened with broken title/body (the owner's own mention survives)
  assert.equal(r.prArg.title, "Fix @\u200bbob's flake");
  assert.equal(r.prArg.body, "done by @octo and @\u200bbob");
});

test("no owner known → EVERY mention is broken (fail closed)", async () => {
  const r = await rig({ push: () => ({ pushed: ["origin/agent/42"] }) })({
    outbox: { comment: "thanks @bob and @octo" },
  });
  const posted = r.lines.find((l) => l.startsWith("comment:")) ?? "";
  assert.equal(posted, "comment:thanks @\u200bbob and @\u200bocto");
});

test("an explicit ownerLogin overrides the adapter's ownerHint", async () => {
  const r = await rig({ push: () => ({ pushed: ["origin/agent/42"] }), ownerHint: "@octo" })({
    outbox: { comment: "hi @bob @octo @carol" },
    ownerLogin: "carol",
  });
  const posted = r.lines.find((l) => l.startsWith("comment:")) ?? "";
  assert.equal(posted, "comment:hi @\u200bbob @\u200bocto @carol");
});
