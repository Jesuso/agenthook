import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub forge `processEvents` (pure-unit, no network): merged-PR + pr_push routing,
// the `Closes #<ref>` self-closing-board detector, and red/green workflow_run → ci/ci_green jobs.
import test from "node:test";
import assert from "node:assert/strict";
import { prClosesIssue } from "../src/forges/github.js";
import { forge, makeStore, pipeline, ctx, merged, ghTracker } from "./_forge-helpers.js";

// --- processEvents ---

test("merged PR on agent/<ref> → one merge job keyed merged:<n>, stepId = completeOnMerge step", async () => {
  const jobs = await forge().processEvents(ctx(merged()));
  assert.deepEqual(jobs, [{ kind: "merge", ref: "123", stepId: "done", dedupKey: "merged:77" }]);
});

test("cfg.branchPrefix: a merged local/<ref> PR maps, and a plain agent/<ref> one is ignored (#674)", async () => {
  const f = forge({}, pipeline, makeStore(), { branchPrefix: "local/" });
  assert.deepEqual(await f.processEvents(ctx(merged({ head: { ref: "local/123" } }))), [
    { kind: "merge", ref: "123", stepId: "done", dedupKey: "merged:77" },
  ]);
  assert.deepEqual(await f.processEvents(ctx(merged())), [], "agent/<ref> is not this profile's prefix");
});

/** A `pull_request` synchronize payload. @param {any} [over] */
const pushed = (over = {}) => ({ action: "synchronize", pull_request: { number: 77, auto_merge: { merge_method: "squash" }, head: { ref: "agent/123", sha: "def456789", repo: { full_name: "o/r" } }, ...over } });

test("synchronize on an agent PR with auto-merge on → one pr_push signal (forge.autoMerge only)", async () => {
  const am = { autoMerge: { tiers: ["low"] } };
  assert.deepEqual(await forge(am).processEvents(ctx(pushed())), [
    { kind: "pr_push", ref: "123", stepId: "", dedupKey: "prpush:77:def456789", push: { prNumber: 77, headSha: "def456789" } },
  ]);
  assert.deepEqual(await forge().processEvents(ctx(pushed())), [], "feature off");
  assert.deepEqual(await forge(am).processEvents(ctx(pushed({ auto_merge: null }))), [], "auto-merge not on");
  assert.deepEqual(await forge(am).processEvents(ctx(pushed({ head: { ref: "feature/x", sha: "d", repo: { full_name: "o/r" } } }))), [], "not an agent branch");
  assert.deepEqual(await forge(am).processEvents(ctx(pushed({ head: { ref: "agent/123", sha: "d", repo: { full_name: "fork/r" } } }))), [], "a fork's branch");
});

// --- self-closing boards: `Closes #<ref>` (#588) ---

const onMain = (/** @type {string|null|undefined} */ body) => ({ body, baseRef: "main", defaultBranch: "main" });

test("prClosesIssue: every closing keyword, case-insensitive, optional colon", () => {
  for (const kw of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"]) {
    for (const word of [kw, kw.toUpperCase(), kw[0].toUpperCase() + kw.slice(1)]) {
      assert.equal(prClosesIssue(onMain(`${word} #12`), "12", "o/r"), true, word);
      assert.equal(prClosesIssue(onMain(`text\n${word}: #12\nmore`), "12", "o/r"), true, `${word}:`);
    }
  }
  assert.equal(prClosesIssue(onMain("See #12"), "12", "o/r"), false, "no keyword");
  assert.equal(prClosesIssue(onMain("unfixes #12"), "12", "o/r"), false, "keyword inside a word");
});

test("prClosesIssue: #<ref> never prefix-matches #<ref>0; any later mention can match", () => {
  assert.equal(prClosesIssue(onMain("Closes #120"), "12", "o/r"), false);
  assert.equal(prClosesIssue(onMain("Closes #1"), "12", "o/r"), false);
  assert.equal(prClosesIssue(onMain("Closes #120, fixes #12"), "12", "o/r"), true);
});

test("prClosesIssue: owner/repo#<ref> matches the same repo (any case) only", () => {
  assert.equal(prClosesIssue(onMain("Closes O/R#12"), "12", "o/r"), true);
  assert.equal(prClosesIssue(onMain("Closes other/r#12"), "12", "o/r"), false);
});

test("prClosesIssue: a non-default base, or an empty/missing body → false", () => {
  assert.equal(prClosesIssue({ body: "Closes #12", baseRef: "dev", defaultBranch: "main" }, "12", "o/r"), false);
  assert.equal(prClosesIssue({ body: "Closes #12", baseRef: "main" }, "12", "o/r"), false, "unknown default branch");
  assert.equal(prClosesIssue(onMain(""), "12", "o/r"), false);
  assert.equal(prClosesIssue(onMain(null), "12", "o/r"), false);
  assert.equal(prClosesIssue(onMain(undefined), "12", "o/r"), false);
});

/** A merged `Closes #123` PR into the default branch. @param {any} [over] */
const closing = (over = {}) => merged({ body: "Ships it.\n\nCloses #123", base: { ref: "main", repo: { default_branch: "main" } }, ...over });

test("merged `Closes #<ref>` PR on a same-repo github tracker → merge job with boardCloses", async () => {
  const jobs = await forge({}, pipeline, makeStore(), ghTracker).processEvents(ctx(closing()));
  assert.deepEqual(jobs, [{ kind: "merge", ref: "123", stepId: "done", dedupKey: "merged:77", boardCloses: true }]);
  // The base repo's default_branch may be absent: fall back to the event's repository.
  const ev = { ...closing({ base: { ref: "main" } }), repository: { default_branch: "main" } };
  assert.equal((await forge({}, pipeline, makeStore(), ghTracker).processEvents(ctx(ev)))[0].boardCloses, true);
});

test("merged `Closes #<ref>` PR on a non-github tracker, another repo, or a non-default base → no boardCloses", async () => {
  const cases = [
    [{ provider: "jira", tracker: { type: "jira" } }, closing()],
    [{ provider: "github", tracker: { type: "github", repository: "o/other" } }, closing()],
    [ghTracker, closing({ base: { ref: "dev", repo: { default_branch: "main" } } })],
    [ghTracker, closing({ body: "Refs #123" })],
  ];
  for (const [over, ev] of cases) {
    const jobs = await forge({}, pipeline, makeStore(), over).processEvents(ctx(ev));
    assert.deepEqual(jobs, [{ kind: "merge", ref: "123", stepId: "done", dedupKey: "merged:77" }]);
  }
});

test("merged PR with no completeOnMerge step → stepId is empty", async () => {
  const jobs = await forge({}, [{ id: "code" }]).processEvents(ctx(merged({ head: { ref: "agent/ABC-12" } })));
  assert.deepEqual(jobs, [{ kind: "merge", ref: "ABC-12", stepId: "", dedupKey: "merged:77" }]);
});

test("PR closed without merging → no job", async () => {
  assert.deepEqual(await forge().processEvents(ctx(merged({ merged: false }))), []);
});

test("non-closed PR action → no job", async () => {
  assert.deepEqual(await forge().processEvents(ctx({ ...merged(), action: "opened" })), []);
});

test("merged PR on a non-agent branch → no job", async () => {
  assert.deepEqual(await forge().processEvents(ctx(merged({ head: { ref: "feature/x" } }))), []);
});

test("non-pull_request events (ping, push) → no job", async () => {
  assert.deepEqual(await forge().processEvents(ctx({ zen: "hi" }, "ping")), []);
  assert.deepEqual(await forge().processEvents(ctx(merged(), "push")), []);
});

// --- processEvents: red CI (workflow_run) ---

/** @param {any} [run] @param {string} [action] */
const redRun = (run = {}, action = "completed") => ({
  action,
  workflow_run: {
    id: 555,
    run_attempt: 1,
    conclusion: "failure",
    head_branch: "agent/123",
    head_sha: "abc1234def",
    html_url: "https://github.com/o/r/actions/runs/555",
    head_repository: { full_name: "o/r" },
    pull_requests: [{ number: 77 }],
    ...run,
  },
});

test("red workflow_run on agent/<ref> from this repo → one ci job keyed ci:<run>:<attempt>", async () => {
  const jobs = await forge().processEvents(ctx(redRun(), "workflow_run"));
  assert.deepEqual(jobs, [
    {
      kind: "ci",
      ref: "123",
      stepId: "",
      dedupKey: "ci:555:1",
      ci: { runId: 555, attempt: 1, headSha: "abc1234def", prNumber: 77, url: "https://github.com/o/r/actions/runs/555" },
    },
  ]);
});

test("timed_out counts as red; attempt 2 keys apart; no pull_requests → prNumber null", async () => {
  const [j] = await forge().processEvents(ctx(redRun({ conclusion: "timed_out", run_attempt: 2, pull_requests: [] }), "workflow_run"));
  assert.equal(j.dedupKey, "ci:555:2");
  assert.equal(j.ci.attempt, 2);
  assert.equal(j.ci.prNumber, null);
});

test("cancelled/in-progress, non-agent branch, fork, flags off → no ci job", async () => {
  const f = forge();
  const none = async (/** @type {any} */ p, g = f) => assert.deepEqual(await g.processEvents(ctx(p, "workflow_run")), []);
  await none(redRun({ conclusion: "success", head_branch: "feature/x" }));
  await none(redRun({ conclusion: "success", head_repository: { full_name: "evil/r" } }));
  await none(redRun({ conclusion: "success" }), forge({ greenCi: false }));
  await none(redRun({ conclusion: "cancelled" }));
  await none(redRun({ conclusion: null }, "in_progress"));
  await none(redRun({}, "requested"));
  await none(redRun({ head_branch: "feature/x" }));
  await none(redRun({ head_repository: { full_name: "evil/r" } }));
  await none(redRun({ head_repository: null }));
  await none(redRun(), forge({ redCi: false }));
});

test("cfg.branchPrefix: a red run on local/<ref> maps, and a plain agent/<ref> one is ignored (#674)", async () => {
  const f = forge({}, pipeline, makeStore(), { branchPrefix: "local/" });
  const [j] = await f.processEvents(ctx(redRun({ head_branch: "local/123" }), "workflow_run"));
  assert.equal(j.ref, "123");
  assert.deepEqual(await f.processEvents(ctx(redRun(), "workflow_run")), []);
});

test("green workflow_run on agent/<ref> → one ci_green candidate keyed per (ref, sha); redCi:false does not hide it", async () => {
  for (const g of [forge(), forge({ redCi: false })]) {
    const jobs = await g.processEvents(ctx(redRun({ conclusion: "success" }), "workflow_run"));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].kind, "ci_green");
    assert.equal(jobs[0].ref, "123");
    assert.equal(jobs[0].dedupKey, "cigreen:123:abc1234def");
    assert.equal(jobs[0].ci?.prNumber, 77);
  }
  // a red run is still a ci job when only greenCi is off
  const [red] = await forge({ greenCi: false }).processEvents(ctx(redRun(), "workflow_run"));
  assert.equal(red.kind, "ci");
});
