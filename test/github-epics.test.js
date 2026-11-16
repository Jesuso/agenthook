import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub adapter (split from the former github.test.js): queue-stage pull (listQueued +
// enterStage leaving the queue label), listResting's stale-list-index-vs-live-read decision,
// extractRouteKeys/routeKeys, and epics (#309, #310) — isEpicIssue/mapEpics/mapEpicTickets,
// fetchTask's epic linking, listEpics/listEpicTickets, and epic_changed from sub_issues/issues.
import test from "node:test";
import assert from "node:assert/strict";
import { createGithubAdapter, epicChangeFromEvent, extractRouteKeys, isEpicIssue, mapEpics, mapEpicTickets } from "../src/trackers/github.js";
import { ticketBucket } from "../src/epics.js";
import { adapter, evt, makeStore, withDeps } from "./_github-helpers.js";

// --- queue-stage pull: listQueued + enterStage leaving the queue label ---
const qPipeline = [{ id: "code", sourceLabel: "agent:code", successLabel: "agent:review", queueLabel: "queue:code" }];
/** @param {any} [pc] */
function queued(pc = {}) {
  const providerConfig = { type: "github", token: "t", repository: "o/r", ...pc };
  return createGithubAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: qPipeline, providerConfig }), /** @type {any} */ (makeStore()));
}

test("listQueued lists the queue label oldest-first, keeping only our open, unblocked issues", async () => {
  /** @type {string[]} */
  const urls = [];
  const orig = global.fetch;
  /** @param {any} data */
  const res = (data) => /** @type {any} */ ({ ok: true, status: 200, json: async () => data });
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith("/user")) return res({ login: "bot" });
    if (u.includes("/issues/5/dependencies/blocked_by")) return res([{ number: 1, state: "open" }]);
    if (u.includes("/dependencies/blocked_by")) return res([]);
    return res([
      { number: 3, assignees: [{ login: "bot" }] },
      { number: 4, assignees: [{ login: "bot" }], pull_request: {} },
      { number: 5, assignees: [{ login: "bot" }] },
      { number: 6, assignees: [{ login: "someone" }] },
      { number: 8, assignee: { login: "Bot" } },
    ]);
  };
  let refs;
  try {
    refs = await queued().listQueued("code");
  } finally {
    global.fetch = orig;
  }
  assert.deepEqual(refs, ["3", "8"]);
  const list = urls.find((u) => u.includes("/issues?"));
  assert.ok(list?.includes("labels=queue%3Acode") && list.includes("assignee=bot") && list.includes("sort=created&direction=asc"), list);
});

test("listQueued fails closed when our login can't be resolved", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) });
  try {
    await assert.rejects(() => queued().listQueued("code"), /\/user 500/);
  } finally {
    global.fetch = orig;
  }
});

test("enterStage on a queue step adds the source label, THEN removes the queue label", async () => {
  /** @type {string[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    // The label add succeeds; the queue-label removal 404s (not on the issue) — tolerated.
    const ok = init.method === "POST";
    return /** @type {any} */ ({ ok, status: ok ? 200 : 404, json: async () => ({}) });
  };
  try {
    await queued({ assigneeFilter: false }).enterStage("42", "code", { assign: false });
  } finally {
    global.fetch = orig;
  }
  const add = calls.findIndex((c) => c.startsWith("POST") && c.endsWith("/issues/42/labels"));
  const del = calls.findIndex((c) => c.startsWith("DELETE") && c.endsWith("/issues/42/labels/queue%3Acode"));
  assert.ok(add >= 0 && del > add, `expected add-then-remove; got:\n${calls.join("\n")}`);
});

test("extractRouteKeys: prefix match, case-insensitive, pipeline labels never returned", () => {
  const labels = [{ name: "Platform:iOS" }, "platform:web", { name: "platform:" }, { name: "bug" }, { name: "agent:code" }];
  assert.deepEqual(extractRouteKeys(labels, "platform:"), ["iOS", "web"]);
  assert.deepEqual(extractRouteKeys([{ name: "agent:code" }, { name: "agent:x" }], "agent:", ["agent:code"]), ["x"]);
  assert.deepEqual(extractRouteKeys([{ name: "platform:ios" }], "platform:", ["Platform:IOS"]), []);
  assert.deepEqual(extractRouteKeys(labels, undefined), []);
  assert.deepEqual(extractRouteKeys(undefined, "platform:"), []);
});

test("fetchTask returns routeKeys from labels; [] when routeField unset", async () => {
  const issue = { title: "t", body: "", html_url: "u", state: "open", labels: [{ name: "agent:code" }, { name: "platform:ios" }, { name: "platform:web" }] };
  const restore = withDeps((u) => (u.endsWith("/issues/5") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => issue }) : null));
  try {
    assert.deepEqual((await adapter({ routeField: "platform:" }).fetchTask("5")).routeKeys, ["ios", "web"]);
    assert.deepEqual((await adapter().fetchTask("5")).routeKeys, []);
  } finally {
    restore();
  }
});

// --- listResting: the list-by-label index lags label changes; the live issue read decides ---

/** @param {Record<string, any>} routes  url-suffix → body (or {status}) */
function restingAdapter(routes) {
  const a = createGithubAdapter(
    /** @type {any} */ ({ trigger: "@agent", pipeline: [{ id: "code", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:blocked" }], providerConfig: { type: "github", token: "t", repository: "o/r", assigneeFilter: false } }),
    /** @type {any} */ (makeStore()),
  );
  const restore = withDeps((u) => {
    const hit = Object.entries(routes).find(([suffix]) => u.includes(suffix));
    if (!hit) return null;
    const r = hit[1];
    return /** @type {any} */ ({ ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.body });
  });
  return { a, restore };
}

test("listResting: a ticket the stale list index still shows under the label, but that already moved on, is NOT resting", async () => {
  const { a, restore } = restingAdapter({
    "/dependencies/blocked_by": { body: [] },
    "/issues?state=open&labels=agent%3Acode": { body: [{ number: 10, labels: [{ name: "agent:code" }], assignees: [] }, { number: 11, labels: [{ name: "agent:code" }], assignees: [] }] },
    "/issues/10": { body: { number: 10, state: "open", labels: [{ name: "agent:blocked" }] } }, // moved on: the list is stale
    "/issues/11": { body: { number: 11, state: "open", labels: [{ name: "agent:code" }] } },
  });
  try {
    const jobs = await a.listResting();
    assert.deepEqual(jobs.map((j) => j.ref), ["11"]);
  } finally {
    restore();
  }
});

test("listResting: a closed ticket, and a live read that fails, are not resting (fail closed)", async () => {
  const { a, restore } = restingAdapter({
    "/dependencies/blocked_by": { body: [] },
    "/issues?state=open&labels=agent%3Acode": { body: [{ number: 20, labels: [{ name: "agent:code" }], assignees: [] }, { number: 21, labels: [{ name: "agent:code" }], assignees: [] }, { number: 22, labels: [{ name: "Agent:Code" }], assignees: [] }] },
    "/issues/20": { body: { number: 20, state: "closed", labels: [{ name: "agent:code" }] } },
    "/issues/21": { status: 502, body: {} },
    "/issues/22": { body: { number: 22, state: "open", labels: [{ name: "Agent:Code" }] } }, // label match is case-insensitive
  });
  try {
    assert.deepEqual((await a.listResting()).map((j) => j.ref), ["22"]);
  } finally {
    restore();
  }
});

// --- epics (#309): isEpicIssue / mapEpics / mapEpicTickets, fetchTask, list filters ---

test("isEpicIssue: typed, labelled (any case), custom type/label, plain parent is not an epic", () => {
  assert.equal(isEpicIssue({ type: { name: "Epic" } }, "Epic", "epic"), true);
  assert.equal(isEpicIssue({ labels: [{ name: "Epic" }] }, "Epic", "epic"), true);
  assert.equal(isEpicIssue({ labels: ["EPIC"] }, "Epic", "epic"), true);
  assert.equal(isEpicIssue({ type: { name: "Bug" }, labels: [{ name: "bug" }], sub_issues_summary: { total: 3 } }, "Epic", "epic"), false);
  assert.equal(isEpicIssue({ type: { name: "Initiative" } }, "Initiative", "big"), true);
  assert.equal(isEpicIssue({ labels: [{ name: "big" }] }, "Initiative", "big"), true);
  assert.equal(isEpicIssue({ labels: [{ name: "epic" }] }, "Initiative", "big"), false);
});

test("mapEpics: typed + labelled fixtures each listed once (dedupe by number), PRs dropped, closed → status/completed", () => {
  const epics = mapEpics(
    [
      { number: 1, title: "A", html_url: "ua", state: "open", type: { name: "Epic" } },
      { number: 1, title: "A", html_url: "ua", state: "open", type: { name: "Epic" } }, // same epic via the other path
      { number: 2, title: "B", html_url: "ub", state: "closed", labels: [{ name: "epic" }] },
      { number: 3, title: "PR", html_url: "up", state: "open", type: { name: "Epic" }, pull_request: {} },
      { number: 4, title: "Plain", html_url: "u4", state: "open" },
    ],
    "Epic",
    "epic",
  );
  assert.deepEqual(epics, [
    { ref: "1", name: "A", url: "ua", displayId: "#1", status: "open", completed: false },
    { ref: "2", name: "B", url: "ub", displayId: "#2", status: "closed", completed: true },
  ]);
});

test("mapEpicTickets: in-pipeline stage, no-pipeline-label same-repo, other-repo, PR dropped, closed", () => {
  const stageLabels = new Map([["agent:review", "agent:review"]]);
  const repoApiUrl = "https://api.github.com/repos/o/r";
  const tickets = mapEpicTickets(
    [
      { number: 10, title: "in pipeline", state: "open", repository_url: repoApiUrl, html_url: "https://github.com/o/r/issues/10", labels: [{ name: "agent:review" }] },
      { number: 11, title: "no stage", state: "open", repository_url: repoApiUrl, html_url: "https://github.com/o/r/issues/11", labels: [{ name: "bug" }] },
      { number: 12, title: "other repo", state: "closed", repository_url: "https://api.github.com/repos/o/other", html_url: "https://github.com/o/other/issues/12" },
      { number: 13, title: "pr", state: "open", repository_url: repoApiUrl, pull_request: {} },
    ],
    repoApiUrl,
    stageLabels,
  );
  assert.deepEqual(tickets, [
    { ref: "10", displayId: "#10", name: "in pipeline", completed: false, stage: "agent:review", url: "https://github.com/o/r/issues/10" },
    { ref: "11", displayId: "#11", name: "no stage", completed: false, stage: "", url: "https://github.com/o/r/issues/11" },
    { ref: "o/other#12", displayId: "o/other#12", name: "other repo", completed: true, stage: null, url: "https://github.com/o/other/issues/12" },
  ]);
  assert.equal(ticketBucket(tickets[1], null, [], false), "backlog");
  const openOtherRepo = mapEpicTickets(
    [{ number: 20, title: "other repo open", state: "open", repository_url: "https://api.github.com/repos/o/other" }],
    repoApiUrl,
    stageLabels,
  )[0];
  assert.equal(ticketBucket(openOtherRepo, null, [], false), "untracked");
});

test("fetchTask: no parent_issue_url makes exactly 1 call and sets no epic", async () => {
  const calls = [];
  const restore = withDeps((u) => {
    calls.push(u);
    return u.endsWith("/issues/5") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ title: "t", body: "", html_url: "u", state: "open" }) }) : null;
  });
  try {
    const task = await adapter().fetchTask("5");
    assert.equal(calls.length, 1);
    assert.equal(task.epic, undefined);
    assert.equal(task.isEpic, false);
  } finally {
    restore();
  }
});

test("fetchTask: epic parent sets Task.epic (2 calls)", async () => {
  const calls = [];
  const restore = withDeps((u) => {
    calls.push(u);
    if (u.endsWith("/issues/5")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ title: "t", body: "", html_url: "u", state: "open", parent_issue_url: "x" }) });
    if (u.endsWith("/issues/5/parent")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ number: 7, title: "Epic 7", html_url: "u7", type: { name: "Epic" }, repository_url: "https://api.github.com/repos/o/r" }) });
    return null;
  });
  try {
    const task = await adapter().fetchTask("5");
    assert.equal(calls.length, 2);
    assert.deepEqual(task.epic, { ref: "7", name: "Epic 7", url: "u7", displayId: "#7" });
  } finally {
    restore();
  }
});

test("fetchTask: parent is a plain (non-epic) issue sets no epic", async () => {
  const restore = withDeps((u) => {
    if (u.endsWith("/issues/5")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ title: "t", body: "", html_url: "u", state: "open", parent_issue_url: "x" }) });
    if (u.endsWith("/issues/5/parent")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ number: 7, title: "Plain parent", html_url: "u7", repository_url: "https://api.github.com/repos/o/r" }) });
    return null;
  });
  try {
    assert.equal((await adapter().fetchTask("5")).epic, undefined);
  } finally {
    restore();
  }
});

test("fetchTask: parent 404 sets no epic and does not throw", async () => {
  const restore = withDeps((u) => {
    if (u.endsWith("/issues/5")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ title: "t", body: "", html_url: "u", state: "open", parent_issue_url: "x" }) });
    if (u.endsWith("/issues/5/parent")) return /** @type {any} */ ({ ok: false, status: 404, json: async () => ({}) });
    return null;
  });
  try {
    assert.equal((await adapter().fetchTask("5")).epic, undefined);
  } finally {
    restore();
  }
});

test("fetchTask: labelled issue is isEpic:true", async () => {
  const restore = withDeps((u) => (u.endsWith("/issues/5") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ title: "t", body: "", html_url: "u", state: "open", labels: [{ name: "epic" }] }) }) : null));
  try {
    assert.equal((await adapter().fetchTask("5")).isEpic, true);
  } finally {
    restore();
  }
});

test("listResting drops an epic-labelled and a typed-Epic issue, keeps the rest", async () => {
  const { a, restore } = restingAdapter({
    "/dependencies/blocked_by": { body: [] },
    "/issues?state=open&labels=agent%3Acode": {
      body: [
        { number: 1, labels: [{ name: "agent:code" }], assignees: [] },
        { number: 2, labels: [{ name: "agent:code" }, { name: "epic" }], assignees: [] },
        { number: 3, labels: [{ name: "agent:code" }], type: { name: "Epic" }, assignees: [] },
      ],
    },
    "/issues/1": { body: { number: 1, state: "open", labels: [{ name: "agent:code" }] } },
  });
  try {
    assert.deepEqual((await a.listResting()).map((j) => j.ref), ["1"]);
  } finally {
    restore();
  }
});

test("listQueued drops an epic-labelled and a typed-Epic issue, keeps the rest", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    const res = (data) => /** @type {any} */ ({ ok: true, status: 200, json: async () => data });
    if (u.includes("/dependencies/blocked_by")) return res([]);
    return res([
      { number: 1, assignees: [] },
      { number: 2, assignees: [], labels: [{ name: "epic" }] },
      { number: 3, assignees: [], type: { name: "Epic" } },
    ]);
  };
  try {
    assert.deepEqual(await queued({ assigneeFilter: false }).listQueued("code"), ["1"]);
  } finally {
    global.fetch = orig;
  }
});

test("listEpics returns [] (no throw) on an API error", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) });
  try {
    assert.deepEqual(await adapter().listEpics(), []);
  } finally {
    global.fetch = orig;
  }
});

test("listEpicTickets returns [] (no throw) on an API error", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) });
  try {
    assert.deepEqual(await adapter().listEpicTickets("7"), []);
  } finally {
    global.fetch = orig;
  }
});

test("listEpics merges label-path and type-path results through mapEpics (post-filtered, deduped)", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    const res = (data) => /** @type {any} */ ({ ok: true, status: 200, json: async () => data });
    if (u.includes("labels=epic")) return res([{ number: 1, title: "A", html_url: "ua", state: "open", labels: [{ name: "epic" }] }]);
    if (u.includes("type=Epic")) return res([{ number: 1, title: "A", html_url: "ua", state: "open", labels: [{ name: "epic" }] }, { number: 2, title: "B", html_url: "ub", state: "open", type: { name: "Epic" } }]);
    return res([]);
  };
  try {
    const epics = await adapter().listEpics();
    assert.deepEqual(
      epics.map((e) => e.ref),
      ["1", "2"],
    );
  } finally {
    global.fetch = orig;
  }
});

test("listEpics: type path 422 (no issue types on this repo) logs once at info level, never warns, and stops querying type= on later calls", async () => {
  const orig = global.fetch;
  const warn = console.warn;
  const log = console.log;
  let typeCalls = 0;
  /** @type {any[]} */
  const warnings = [];
  /** @type {any[]} */
  const infos = [];
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    const res = (data, status = 200) => /** @type {any} */ ({ ok: status < 400, status, json: async () => data });
    if (u.includes("type=Epic")) {
      typeCalls++;
      return res({}, 422);
    }
    if (u.includes("labels=epic")) return res([{ number: 1, title: "A", html_url: "ua", state: "open", labels: [{ name: "epic" }] }]);
    return res([]);
  };
  console.warn = (...args) => warnings.push(args);
  console.log = (...args) => infos.push(args);
  try {
    const a = adapter();
    const first = await a.listEpics();
    const second = await a.listEpics();
    assert.deepEqual(first.map((e) => e.ref), ["1"]);
    assert.deepEqual(second.map((e) => e.ref), ["1"]);
    assert.equal(typeCalls, 1);
    assert.equal(warnings.length, 0);
    assert.equal(infos.length, 1);
  } finally {
    global.fetch = orig;
    console.warn = warn;
    console.log = log;
  }
});

test("listEpics: type path 500 warns and is retried on every call", async () => {
  const orig = global.fetch;
  const warn = console.warn;
  let typeCalls = 0;
  /** @type {any[]} */
  const warnings = [];
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    const res = (data, status = 200) => /** @type {any} */ ({ ok: status < 400, status, json: async () => data });
    if (u.includes("type=Epic")) {
      typeCalls++;
      return res({}, 500);
    }
    if (u.includes("labels=epic")) return res([{ number: 1, title: "A", html_url: "ua", state: "open", labels: [{ name: "epic" }] }]);
    return res([]);
  };
  console.warn = (...args) => warnings.push(args);
  try {
    const a = adapter();
    await a.listEpics();
    await a.listEpics();
    assert.equal(typeCalls, 2);
    assert.equal(warnings.length, 2);
  } finally {
    global.fetch = orig;
    console.warn = warn;
  }
});

// --- epic_changed (#310): sub_issues + issues typed/untyped → a signal job, never a pipeline job ---

const OUR_REPO = "https://api.github.com/repos/o/r";
const epicParent = { number: 12, repository_url: OUR_REPO, type: { name: "Epic" }, labels: [] };
const subIssue = { id: 9001, number: 40, repository_url: OUR_REPO, labels: [{ name: "agent:code" }], assignees: [] };
/** @param {string} action @param {object} [over] */
const subIssuesEvt = (action, over = {}) => ({ action, parent_issue: epicParent, parent_issue_repo: { url: OUR_REPO, full_name: "o/r" }, sub_issue: subIssue, sub_issue_repo: { url: OUR_REPO }, ...over });

for (const action of ["sub_issue_added", "sub_issue_removed", "parent_issue_added", "parent_issue_removed"]) {
  test(`sub_issues ${action} on an epic parent → one epic_changed for the parent, no pipeline job`, async () => {
    const jobs = await adapter().processEvents(/** @type {any} */ (evt(subIssuesEvt(action), { "x-github-event": "sub_issues", "x-github-delivery": "d-1" })));
    assert.deepEqual(jobs, [{ kind: "epic_changed", ref: "12", stepId: "", dedupKey: "epic:d-1" }]);
  });
}

test("issues typed → Epic, and untyped from Epic → one epic_changed for the issue (assignee gate not consulted)", async () => {
  const typed = { action: "typed", type: { name: "Epic" }, issue: { number: 12, type: { name: "Epic" }, labels: [], assignees: [] } };
  const untyped = { action: "untyped", type: { name: "Epic" }, issue: { number: 12, type: null, labels: [], assignees: [] } };
  const a = adapter({ assigneeFilter: true, assigneeLogin: "someone-else" });
  assert.deepEqual(await a.processEvents(/** @type {any} */ (evt(typed, { "x-github-delivery": "d-2" }))), [{ kind: "epic_changed", ref: "12", stepId: "", dedupKey: "epic:d-2" }]);
  assert.deepEqual(await a.processEvents(/** @type {any} */ (evt(untyped, { "x-github-delivery": "d-3" }))), [{ kind: "epic_changed", ref: "12", stepId: "", dedupKey: "epic:d-3" }]);
});

test("epic_changed without a delivery header falls back to ref:action:sub_issue.id", async () => {
  const jobs = await adapter().processEvents(/** @type {any} */ (evt(subIssuesEvt("sub_issue_added"), { "x-github-event": "sub_issues" })));
  assert.deepEqual(jobs, [{ kind: "epic_changed", ref: "12", stepId: "", dedupKey: "epic:12:sub_issue_added:9001" }]);
});

test("a non-epic parent, a cross-repo parent, a non-epic type change, a labelled epic retyped → as expected", async () => {
  const hdr = { "x-github-event": "sub_issues", "x-github-delivery": "d-4" };
  const plain = { ...epicParent, type: null };
  assert.deepEqual(await adapter().processEvents(/** @type {any} */ (evt(subIssuesEvt("sub_issue_added", { parent_issue: plain }), hdr))), []);
  const foreign = { ...epicParent, repository_url: "https://api.github.com/repos/x/y" };
  assert.deepEqual(await adapter().processEvents(/** @type {any} */ (evt(subIssuesEvt("sub_issue_added", { parent_issue: foreign, parent_issue_repo: { url: "https://api.github.com/repos/x/y" } }), hdr))), []);
  const bug = { action: "typed", type: { name: "Bug" }, issue: { number: 5, type: { name: "Bug" }, labels: [], assignees: [] } };
  assert.deepEqual(await adapter().processEvents(/** @type {any} */ (evt(bug))), []);
  const labelled = { action: "typed", type: { name: "Bug" }, issue: { number: 6, type: { name: "Bug" }, labels: [{ name: "epic" }], assignees: [] } };
  assert.deepEqual((await adapter().processEvents(/** @type {any} */ (evt(labelled, { "x-github-delivery": "d-5" })))).map((j) => [j.kind, j.ref]), [["epic_changed", "6"]]);
});

test("epicChangeFromEvent: unknown sub_issues action / missing repo evidence / repo URL case → null|ref", () => {
  const o = { epicType: "Epic", epicLabel: "epic", repoApiUrl: OUR_REPO };
  assert.equal(epicChangeFromEvent("sub_issues", subIssuesEvt("something_else"), o), null);
  assert.equal(epicChangeFromEvent("sub_issues", subIssuesEvt("sub_issue_added", { parent_issue: { ...epicParent, repository_url: undefined }, parent_issue_repo: undefined }), o), null);
  assert.equal(epicChangeFromEvent("sub_issues", subIssuesEvt("sub_issue_added", { parent_issue: { ...epicParent, repository_url: OUR_REPO.toUpperCase() } }), o), "12");
  assert.equal(epicChangeFromEvent("issues", { action: "labeled", issue: epicParent }, o), null);
});

test("a sub_issues delivery with a bad / absent signature is rejected", () => {
  const a = adapter({ webhookSecret: "s3cr3t" });
  const body = JSON.stringify(subIssuesEvt("sub_issue_added"));
  assert.equal(a.authenticate(/** @type {any} */ ({ rawBody: body, headers: { "x-github-event": "sub_issues", "x-hub-signature-256": "sha256=deadbeef" } })).type, "reject");
  assert.equal(a.authenticate(/** @type {any} */ ({ rawBody: body, headers: { "x-github-event": "sub_issues" } })).type, "reject");
});

