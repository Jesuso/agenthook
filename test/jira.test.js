import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Jira adapter — pure-unit coverage (no network): the adapter contract (x-hub-signature
// verify, issue_created + issue_updated status-change routing, advance → transition lookup —
// mirrors test/github.test.js) plus the `agenthook init` discovery. Note for the init test:
// site/email are collected BY the wizard, so the status discovery rebuilds base+auth from the
// answers (not the factory's cached pair) — the test asserts it hits the answered site/project,
// and dedups statuses across issue types.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createJiraAdapter, extractRouteKeys, isEpicType, mapEpicFields, mapEpics, mapEpicTickets, epicChangesFromEvent } from "../src/trackers/jira.js";

/** Minimal in-memory Store stub. */
function makeStore() {
  const m = new Map();
  return {
    getSecret: (k) => m.get(k),
    setSecret: (k, v) => m.set(k, v),
    secretCount: () => m.size,
    reloadSeen() {},
    hasSeen: () => false,
    markSeen() {},
    unmarkSeen() {},
    seenCount: () => 0,
    seenFile: "",
    setRunning() {},
    clearRunning() {},
    listRunning: () => ({}),
    getAttempt: () => 0,
    bumpAttempt: () => 0,
    clearAttempts() {},
  };
}

/** Build an adapter with only the init-probe config ({type, token}), as init does. */
function adapter() {
  const providerConfig = { type: "jira", token: "t" };
  return createJiraAdapter(/** @type {any} */ ({ trigger: "@agent", providerConfig }), /** @type {any} */ (makeStore()));
}

// --- adapter contract (mirrors test/github.test.js): signature verify, the issue_created +
// issue_updated(status change) routing, and the advance → transition lookup. The default
// pipeline binds one `code` step; assigneeFilter:false keeps routing offline (no /myself gate)
// and an explicit string webhookSecret keeps verification deterministic (no random/store).
const pipeline = [{ id: "code", sourceStatus: "To Do", successStatus: "In Review", failureStatus: "Blocked" }];

/** Build a pipeline-bound adapter. assigneeFilter:false keeps routing offline; a fixed
 *  webhookSecret keeps the signature deterministic. */
function routed(pc = {}) {
  const providerConfig = { type: "jira", token: "t", site: "acme", email: "bot@x.com", assigneeFilter: false, webhookSecret: "shh", ...pc };
  return createJiraAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline, providerConfig }), /** @type {any} */ (makeStore()));
}

test("authenticate accepts a correctly signed body", () => {
  const body = JSON.stringify({ webhookEvent: "jira:issue_created" });
  const sig = "sha256=" + crypto.createHmac("sha256", "shh").update(body).digest("hex");
  assert.equal(routed().authenticate(/** @type {any} */ ({ rawBody: body, headers: { "x-hub-signature": sig } })).type, "accept");
});

test("authenticate rejects a bad signature", () => {
  assert.equal(routed().authenticate(/** @type {any} */ ({ rawBody: "{}", headers: { "x-hub-signature": "sha256=deadbeef" } })).type, "reject");
});

test("authenticate accepts unsigned when webhookSecret:false", () => {
  assert.equal(routed({ webhookSecret: false }).authenticate(/** @type {any} */ ({ rawBody: "{}", headers: {} })).type, "accept");
});

test("issue_created routes by the issue's status (state-based dedup key)", async () => {
  const jobs = await routed().processEvents(
    /** @type {any} */ ({ rawBody: JSON.stringify({ webhookEvent: "jira:issue_created", issue: { key: "PROJ-1", fields: { status: { name: "To Do" } } } }) }),
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].ref, "PROJ-1");
  assert.equal(jobs[0].stepId, "code");
  assert.equal(jobs[0].dedupKey, "step:code:PROJ-1");
});

test("issue_created in an unmapped status yields no job", async () => {
  const jobs = await routed().processEvents(
    /** @type {any} */ ({ rawBody: JSON.stringify({ webhookEvent: "jira:issue_created", issue: { key: "PROJ-1", fields: { status: { name: "Done" } } } }) }),
  );
  assert.equal(jobs.length, 0);
});

test("issue_updated with a status change routes to the new status (secmove changelog key)", async () => {
  const jobs = await routed().processEvents(
    /** @type {any} */ ({
      rawBody: JSON.stringify({ webhookEvent: "jira:issue_updated", issue: { key: "PROJ-1", fields: {} }, changelog: { id: "999", items: [{ field: "status", toString: "To Do" }] } }),
    }),
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].ref, "PROJ-1");
  assert.equal(jobs[0].stepId, "code");
  assert.equal(jobs[0].dedupKey, "secmove:999");
});

test("issue_updated without a status change yields no job", async () => {
  const jobs = await routed().processEvents(
    /** @type {any} */ ({
      rawBody: JSON.stringify({ webhookEvent: "jira:issue_updated", issue: { key: "PROJ-1", fields: {} }, changelog: { id: "999", items: [{ field: "assignee", toString: "someone" }] } }),
    }),
  );
  assert.equal(jobs.length, 0);
});

test("advance executes the transition whose target status matches (transition lookup)", async () => {
  /** @type {string[]} */
  const calls = [];
  let body;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    if (init.method === "POST" && init.body) body = JSON.parse(String(init.body));
    if (String(url).endsWith("/transitions") && (!init.method || init.method === "GET")) {
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ transitions: [{ id: "31", to: { name: "In Review" } }, { id: "41", to: { name: "Blocked" } }] }) });
    }
    return /** @type {any} */ ({ ok: true, status: 204, json: async () => ({}) });
  };
  try {
    await routed().advance("PROJ-1", "code", /** @type {any} */ ({ outcome: "advance" }));
  } finally {
    global.fetch = orig;
  }
  const get = calls.findIndex((c) => c === "GET https://acme.atlassian.net/rest/api/2/issue/PROJ-1/transitions");
  const post = calls.findIndex((c) => c === "POST https://acme.atlassian.net/rest/api/2/issue/PROJ-1/transitions");
  assert.ok(get >= 0 && post >= 0 && get < post, `expected a transitions GET then POST; got:\n${calls.join("\n")}`);
  assert.deepEqual(body, { transition: { id: "31" } });
});

test("advance is a no-op when no transition leads to the target status", async () => {
  /** @type {string[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    if (String(url).endsWith("/transitions")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ transitions: [{ id: "41", to: { name: "Blocked" } }] }) });
    return /** @type {any} */ ({ ok: true, status: 204, json: async () => ({}) });
  };
  try {
    await routed().advance("PROJ-1", "code", /** @type {any} */ ({ outcome: "advance" }));
  } finally {
    global.fetch = orig;
  }
  assert.ok(!calls.some((c) => c.startsWith("POST")), `expected no transition POST when the target is unreachable; got:\n${calls.join("\n")}`);
});

test("pipelineBindings maps the wizard stage picks to status bindings", () => {
  const a = adapter();
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "To Do", _successStage: "In Review", _failureStage: "Blocked" }), {
    sourceStatus: "To Do",
    successStatus: "In Review",
    failureStatus: "Blocked",
  });
});

test("pipelineBindings returns null when no stage was picked (init keeps the placeholder)", () => {
  assert.equal(adapter().pipelineBindings?.({}), null);
});

test("pipelineBindings adds holdStatus only when _holdStage was picked", () => {
  const a = adapter();
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "To Do", _successStage: "In Review", _failureStage: "Blocked", _holdStage: "Waiting" }), {
    sourceStatus: "To Do",
    successStatus: "In Review",
    failureStatus: "Blocked",
    holdStatus: "Waiting",
  });
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "To Do", _successStage: "In Review", _failureStage: "Blocked", _holdStage: "" }), {
    sourceStatus: "To Do",
    successStatus: "In Review",
    failureStatus: "Blocked",
  });
});

test("currentStage returns ANY pipeline status the issue sits in (not just source) — backs run's guard", async () => {
  const orig = global.fetch;
  // The issue is in the SUCCESS status (In Review), not the source — still in-flight.
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ fields: { status: { name: "In Review" } } }) });
  try {
    assert.equal(await routed().currentStage?.("PROJ-1"), "In Review");
  } finally {
    global.fetch = orig;
  }
});

test("currentStage is null when the issue's status is outside the pipeline", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ fields: { status: { name: "Done" } } }) });
  try {
    assert.equal(await routed().currentStage?.("PROJ-9"), null);
  } finally {
    global.fetch = orig;
  }
});

test("init status discovery hits the answered site/project and dedups statuses across issue types", async () => {
  const orig = global.fetch;
  /** @type {string[]} */
  const urls = [];
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    urls.push(String(url));
    // The /statuses endpoint groups by issue type; "To Do" appears under both.
    return /** @type {any} */ ({
      ok: true,
      status: 200,
      json: async () => [
        { name: "Story", statuses: [{ name: "To Do" }, { name: "In Review" }] },
        { name: "Bug", statuses: [{ name: "To Do" }, { name: "Blocked" }] },
      ],
    });
  };
  try {
    const steps = adapter().wizardSteps?.({}) || [];
    const source = steps.find((s) => s.key === "_sourceStage");
    assert.ok(source && typeof source.choices === "function", "expected a _sourceStage select with live choices");
    const choices = await /** @type {any} */ (source.choices)({ site: "acme", email: "bot@x.com", projectKey: "CAHUI" });
    assert.deepEqual(
      choices.map((/** @type {any} */ c) => c.value),
      ["To Do", "In Review", "Blocked"],
    );
    assert.ok(urls.some((u) => u.includes("https://acme.atlassian.net") && u.includes("/project/CAHUI/statuses")), `expected a statuses fetch on the answered site/project; got:\n${urls.join("\n")}`);
  } finally {
    global.fetch = orig;
  }
});

test("describe().stageKeys names the status binding family", () => {
  assert.deepEqual(adapter().describe().stageKeys, {
    source: "sourceStatus",
    success: "successStatus",
    failure: "failureStatus",
    hold: "holdStatus",
    queue: "queueStatus",
  });
});

test("listStages hits the configured project's statuses and dedups across issue types", async () => {
  const orig = global.fetch;
  /** @type {string[]} */
  const urls = [];
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    urls.push(String(url));
    return /** @type {any} */ ({
      ok: true,
      status: 200,
      json: async () => [
        { name: "Story", statuses: [{ name: "To Do" }, { name: "In Review" }] },
        { name: "Bug", statuses: [{ name: "To Do" }, { name: "Blocked" }] },
      ],
    });
  };
  try {
    const a = routed({ projectKey: "CAHUI" });
    const stages = await a.listStages?.();
    assert.deepEqual(stages, [
      { id: "To Do", label: "To Do" },
      { id: "In Review", label: "In Review" },
      { id: "Blocked", label: "Blocked" },
    ]);
    assert.ok(urls.some((u) => u.includes("https://acme.atlassian.net") && u.includes("/project/CAHUI/statuses")), `expected a statuses fetch on the configured site/project; got:\n${urls.join("\n")}`);
  } finally {
    global.fetch = orig;
  }
});

test("listQueued searches the queue status ranked (ORDER BY Rank ASC), skipping done-category issues", async () => {
  /** @type {string[]} */
  const urls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    urls.push(decodeURIComponent(String(url)));
    return /** @type {any} */ ({
      ok: true,
      status: 200,
      json: async () => ({
        issues: [
          { key: "A-2", fields: { status: { statusCategory: { key: "new" } } } },
          { key: "A-1", fields: { status: { statusCategory: { key: "done" } } } },
          { key: "A-5", fields: { status: { statusCategory: { key: "new" } } } },
        ],
      }),
    });
  };
  const pl = [{ id: "code", sourceStatus: "To Do", queueStatus: "Backlog" }];
  const a = createJiraAdapter(
    /** @type {any} */ ({ trigger: "@agent", pipeline: pl, providerConfig: { type: "jira", token: "t", site: "acme", email: "e", assigneeFilter: false } }),
    /** @type {any} */ (makeStore()),
  );
  try {
    assert.deepEqual(await a.listQueued("code"), ["A-2", "A-5"]);
  } finally {
    global.fetch = orig;
  }
  assert.ok(urls[0].includes(`status = "Backlog" ORDER BY Rank ASC`), urls[0]);
});

test("extractRouteKeys: components, labels, customfield string/option/array", () => {
  const f = {
    components: [{ name: "ios" }, { name: "web" }],
    labels: ["a", "b"],
    customfield_1: "x",
    customfield_2: { value: "opt" },
    customfield_3: [{ value: "m1" }, { name: "m2" }, "m3"],
  };
  assert.deepEqual(extractRouteKeys(f, "Components"), ["ios", "web"]);
  assert.deepEqual(extractRouteKeys(f, "labels"), ["a", "b"]);
  assert.deepEqual(extractRouteKeys(f, "customfield_1"), ["x"]);
  assert.deepEqual(extractRouteKeys(f, "customfield_2"), ["opt"]);
  assert.deepEqual(extractRouteKeys(f, "customfield_3"), ["m1", "m2", "m3"]);
  assert.deepEqual(extractRouteKeys(f, "customfield_9"), []);
  assert.deepEqual(extractRouteKeys(f, "Platform"), []);
  assert.deepEqual(extractRouteKeys(f, undefined), []);
});

test("fetchTask requests the routed field only when routeField is set", async () => {
  /** @type {string[]} */
  const urls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => (urls.push(String(url)), /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ fields: { summary: "s", components: [{ name: "ios" }] } }) }));
  try {
    const t = await routed({ routeField: "components" }).fetchTask("PROJ-1");
    assert.deepEqual(t.routeKeys, ["ios"]);
    await routed({ routeField: "customfield_10010" }).fetchTask("PROJ-1");
    const t2 = await routed().fetchTask("PROJ-1");
    assert.deepEqual(t2.routeKeys, []);
    await routed({ routeField: "bogus" }).fetchTask("PROJ-1");
  } finally {
    global.fetch = orig;
  }
  assert.ok(urls[0].endsWith("fields=summary,description,status,assignee,issuetype,parent,components"), urls[0]);
  assert.ok(urls[1].endsWith("fields=summary,description,status,assignee,issuetype,parent,customfield_10010"), urls[1]);
  assert.ok(urls[2].endsWith("fields=summary,description,status,assignee,issuetype,parent"), urls[2]);
  assert.ok(urls[3].endsWith("fields=summary,description,status,assignee,issuetype,parent"), urls[3]);
});

// --- epics (ADR 0005): hierarchy-level identity, `parent` membership, read-only epic_changed signals.

const EPIC = { name: "Epic", hierarchyLevel: 1 };
const STORY = { name: "Story", hierarchyLevel: 0 };
const SUBTASK = { name: "Subtask", hierarchyLevel: -1, subtask: true };

test("isEpicType: hierarchy level 1 by default; epicType pins a name (case-insensitive)", () => {
  assert.equal(isEpicType(EPIC, undefined), true);
  assert.equal(isEpicType(STORY, undefined), false);
  assert.equal(isEpicType(SUBTASK, undefined), false);
  assert.equal(isEpicType({ name: "Initiative", hierarchyLevel: 2 }, undefined), false);
  assert.equal(isEpicType({ name: "Initiative", hierarchyLevel: 2 }, "initiative"), true);
  assert.equal(isEpicType(EPIC, "Initiative"), false);
  assert.equal(isEpicType(undefined, undefined), false);
});

test("mapEpicFields: an Epic is itself an epic; a Story under an Epic gets .epic; a plain parent never does", () => {
  const base = "https://acme.atlassian.net";
  assert.deepEqual(mapEpicFields({ issuetype: EPIC }, undefined, base), { isEpic: true });
  const child = { issuetype: STORY, parent: { key: "A-1", fields: { summary: "The epic", issuetype: EPIC } } };
  assert.deepEqual(mapEpicFields(child, undefined, base), {
    isEpic: false,
    epic: { ref: "A-1", name: "The epic", url: `${base}/browse/A-1`, displayId: "A-1" },
  });
  // a Subtask's parent is a Story: not an epic
  const sub = { issuetype: SUBTASK, parent: { key: "A-2", fields: { summary: "A story", issuetype: STORY } } };
  assert.deepEqual(mapEpicFields(sub, undefined, base), { isEpic: false });
});

test("mapEpics / mapEpicTickets: status, done-category completion, subtasks dropped", () => {
  const base = "https://acme.atlassian.net";
  assert.deepEqual(
    mapEpics([{ key: "A-1", fields: { summary: "E", status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } }, { key: "A-9", fields: { summary: "Old", status: { name: "Done", statusCategory: { key: "done" } } } }], base),
    [
      { ref: "A-1", name: "E", url: `${base}/browse/A-1`, displayId: "A-1", status: "In Progress", completed: false },
      { ref: "A-9", name: "Old", url: `${base}/browse/A-9`, displayId: "A-9", status: "Done", completed: true },
    ],
  );
  assert.deepEqual(
    mapEpicTickets(
      [
        { key: "A-2", fields: { summary: "S", issuetype: STORY, status: { name: "QA", statusCategory: { key: "indeterminate" } } } },
        { key: "A-3", fields: { summary: "Sub", issuetype: SUBTASK, status: { name: "To Do", statusCategory: { key: "new" } } } },
        { key: "A-4", fields: { summary: "B", issuetype: { name: "Bug", hierarchyLevel: 0 }, status: { name: "Done", statusCategory: { key: "done" } } } },
      ],
      base,
    ),
    [
      { ref: "A-2", displayId: "A-2", name: "S", completed: false, stage: "QA", terminal: false, url: `${base}/browse/A-2` },
      { ref: "A-4", displayId: "A-4", name: "B", completed: true, stage: "Done", terminal: false, url: `${base}/browse/A-4` },
    ],
  );
});

test("mapEpicTickets: terminal = the status is a manual step's sourceStatus", () => {
  const issue = (/** @type {string} */ key, /** @type {string} */ status) => ({ key, fields: { summary: key, issuetype: STORY, status: { name: status, statusCategory: { key: "indeterminate" } } } });
  const tickets = mapEpicTickets([issue("A-2", "Shipped"), issue("A-3", "QA")], "https://acme.atlassian.net", new Set(["Shipped"]));
  assert.deepEqual(tickets.map((t) => [t.ref, t.terminal]), [["A-2", true], ["A-3", false]]);
});

test("epicChangesFromEvent: parent association (to + from), created/deleted under an epic, retype, subtasks skipped", () => {
  const epicParent = { key: "A-1", fields: { issuetype: EPIC } };
  assert.deepEqual(
    epicChangesFromEvent({ webhookEvent: "jira:issue_updated", issue: { key: "A-5", fields: { issuetype: STORY } }, changelog: { items: [{ field: "IssueParentAssociation", fromString: "A-1", toString: "A-2" }] } }, undefined).sort(),
    ["A-1", "A-2"],
  );
  assert.deepEqual(epicChangesFromEvent({ webhookEvent: "jira:issue_created", issue: { key: "A-6", fields: { issuetype: STORY, parent: epicParent } } }, undefined), ["A-1"]);
  assert.deepEqual(epicChangesFromEvent({ webhookEvent: "jira:issue_deleted", issue: { key: "A-6", fields: { issuetype: STORY, parent: epicParent } } }, undefined), ["A-1"]);
  assert.deepEqual(epicChangesFromEvent({ webhookEvent: "jira:issue_created", issue: { key: "A-7", fields: { issuetype: EPIC } } }, undefined), ["A-7"]);
  assert.deepEqual(epicChangesFromEvent({ webhookEvent: "jira:issue_updated", issue: { key: "A-8", fields: { issuetype: EPIC } }, changelog: { items: [{ field: "issuetype", fromString: "Story", toString: "Epic" }] } }, undefined), ["A-8"]);
  // a Subtask changing its Story parent is not an epic change
  assert.deepEqual(epicChangesFromEvent({ webhookEvent: "jira:issue_updated", issue: { key: "A-9", fields: { issuetype: SUBTASK } }, changelog: { items: [{ field: "IssueParentAssociation", fromString: "A-2", toString: "A-3" }] } }, undefined), []);
  // an unrelated status change is not an epic change
  assert.deepEqual(epicChangesFromEvent({ webhookEvent: "jira:issue_updated", issue: { key: "A-5", fields: { issuetype: STORY } }, changelog: { items: [{ field: "status", toString: "Done" }] } }, undefined), []);
});

test("processEvents: a parent association becomes epic_changed jobs (signal only, before the assignee gate)", async () => {
  const body = JSON.stringify({
    webhookEvent: "jira:issue_updated",
    changelog: { id: "900", items: [{ field: "IssueParentAssociation", fromString: null, toString: "A-1" }] },
    issue: { key: "A-5", fields: { issuetype: STORY, status: { name: "Backlog" }, assignee: { accountId: "someone-else" } } },
  });
  const a = routed({ assigneeFilter: true, assigneeAccountId: "me" });
  const jobs = await a.processEvents({ rawBody: body, headers: {}, pathname: "/jira/" });
  assert.deepEqual(jobs, [{ kind: "epic_changed", ref: "A-1", stepId: "", dedupKey: "epic:900:A-1" }]);
});

test("fetchTask returns isEpic and epic from the one issue fetch", async () => {
  const orig = global.fetch;
  /** @type {string[]} */
  const urls = [];
  // @ts-ignore - test stub
  global.fetch = async (url) => (urls.push(String(url)), /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ fields: { summary: "s", issuetype: STORY, parent: { key: "A-1", fields: { summary: "Epic one", issuetype: EPIC } } } }) }));
  try {
    const t = await routed().fetchTask("A-5");
    assert.equal(t.isEpic, false);
    assert.deepEqual(t.epic, { ref: "A-1", name: "Epic one", url: "https://acme.atlassian.net/browse/A-1", displayId: "A-1" });
  } finally {
    global.fetch = orig;
  }
  assert.equal(urls.length, 1);
});

test("listResting / listQueued skip epics", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ isLast: true, issues: [
    { key: "A-1", fields: { issuetype: EPIC, status: { statusCategory: { key: "new" } } } },
    { key: "A-2", fields: { issuetype: STORY, status: { statusCategory: { key: "new" } } } },
  ] }) });
  try {
    assert.deepEqual((await routed().listResting()).map((j) => j.ref), ["A-2"]);
    const q = createJiraAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: [{ id: "code", sourceStatus: "To Do", queueStatus: "Backlog" }], providerConfig: { type: "jira", token: "t", site: "acme", email: "e", assigneeFilter: false } }), /** @type {any} */ (makeStore()));
    assert.deepEqual(await q.listQueued("code"), ["A-2"]);
  } finally {
    global.fetch = orig;
  }
});

test("listEpics finds the level-1 type names, then searches them (paged); listEpicTickets searches parent = KEY", async () => {
  const orig = global.fetch;
  /** @type {string[]} */
  const urls = [];
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    urls.push(u);
    if (u.includes("/project/PROJ")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ issueTypes: [EPIC, STORY, SUBTASK] }) });
    if (u.includes("issuetype in")) {
      const second = u.includes("nextPageToken=tok2");
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ isLast: second, nextPageToken: second ? undefined : "tok2", issues: [{ key: second ? "PROJ-2" : "PROJ-1", fields: { summary: "E", status: { name: "Idea", statusCategory: { key: "new" } } } }] }) });
    }
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ isLast: true, issues: [{ key: "PROJ-7", fields: { summary: "T", issuetype: STORY, status: { name: "QA", statusCategory: { key: "indeterminate" } } } }] }) });
  };
  try {
    const a = routed({ projectKey: "PROJ" });
    assert.deepEqual((await a.listEpics?.())?.map((e) => e.ref), ["PROJ-1", "PROJ-2"]);
    assert.ok(urls.some((u) => u.includes('issuetype in ("Epic")')), urls.join("\n"));
    assert.deepEqual((await a.listEpicTickets?.("PROJ-1"))?.map((t) => t.ref), ["PROJ-7"]);
    assert.ok(urls.some((u) => u.includes('parent = "PROJ-1"')));
    assert.deepEqual(await a.listEpicTickets?.('x" OR project = "OTHER'), [], "a ref that is not an issue key is refused (JQL injection)");
  } finally {
    global.fetch = orig;
  }
});

test("listEpics is [] when the project has no level-1 type, and on an API error (fail-open)", async () => {
  const orig = global.fetch;
  const warn = console.warn;
  console.warn = () => {};
  const log = console.log;
  console.log = () => {};
  try {
    // @ts-ignore - test stub
    global.fetch = async () => /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ issueTypes: [STORY] }) });
    assert.deepEqual(await routed({ projectKey: "PROJ" }).listEpics?.(), []);
    // @ts-ignore - test stub
    global.fetch = async () => /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) });
    assert.deepEqual(await routed({ projectKey: "PROJ" }).listEpics?.(), []);
  } finally {
    global.fetch = orig;
    console.warn = warn;
    console.log = log;
  }
});

// --- the `@agent` comment trigger (comment_created → resume the held step) ---

const heldPipeline = [
  { id: "triage", sourceStatus: "Triage", successStatus: "To Do", failureStatus: "Blocked", holdStatus: "Held" },
  { id: "code", sourceStatus: "To Do", successStatus: "In Review", failureStatus: "Blocked", holdStatus: "Held" },
];

/** Adapter over a store stub whose held record / attempt count the test controls. "Us" is
 * derived from /myself (no assigneeAccountId), so each case runs under `withJira`'s stub.
 * @param {{pc?: object, held?: any, ran?: number}} [o] */
function commentAdapter({ pc = {}, held = { stepId: "triage", heldAt: "2026-10-18T00:00:00.000Z" }, ran = 1 } = {}) {
  const store = { ...makeStore(), getHeld: () => held, getAttempt: () => ran };
  const providerConfig = { type: "jira", token: "t", site: "acme", email: "bot@x.com", webhookSecret: false, ...pc };
  return createJiraAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: heldPipeline, providerConfig }), /** @type {any} */ (store));
}

/** A comment_created delivery (Jira abbreviates `issue.fields` here — no assignee).
 * @param {{author?: string, body?: string, id?: string}} [o] */
function commentEvt({ author = "acc-bot", body = "@agent use Postgres", id = "10042" } = {}) {
  const ev = { webhookEvent: "comment_created", issue: { key: "PROJ-7", fields: { summary: "S" } }, comment: { id, body, author: { accountId: author } } };
  return /** @type {any} */ ({ rawBody: JSON.stringify(ev), headers: {} });
}

/** Run `fn` with a fake Jira: /myself → `me` (or a 500 when null), the fresh assignee fetch of
 * PROJ-7 → `assignee`. Returns the request URLs alongside fn's result.
 * @template T @param {{me?: string|null, assignee?: string}} o @param {() => Promise<T>} fn */
async function withJira({ me = "acc-bot", assignee = "acc-bot" }, fn) {
  /** @type {string[]} */
  const urls = [];
  const orig = global.fetch;
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith("/myself")) return /** @type {any} */ (me ? { ok: true, status: 200, json: async () => ({ accountId: me }) } : { ok: false, status: 500, json: async () => ({}) });
    if (u.includes("/issue/PROJ-7?fields=assignee")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ fields: { assignee: { accountId: assignee } } }) });
    return /** @type {any} */ ({ ok: false, status: 404, json: async () => ({}) });
  };
  try {
    return { result: await fn(), urls };
  } finally {
    global.fetch = orig;
    console.log = log;
    console.error = error;
  }
}

test("comment_created: an owner's @agent reply on a held issue resumes the held step", async () => {
  const { result, urls } = await withJira({}, () => commentAdapter().processEvents(commentEvt()));
  assert.deepEqual(result, [{ kind: "pipeline", ref: "PROJ-7", stepId: "triage", dedupKey: "trigger:10042", comment: "@agent use Postgres" }]);
  assert.ok(urls.some((u) => u.includes("/issue/PROJ-7?fields=assignee")), "the assignee is fetched fresh, not read off the payload");
});

test("comment_created: a leading-whitespace trigger still matches", async () => {
  const { result } = await withJira({}, () => commentAdapter().processEvents(commentEvt({ body: "  \n@agent go" })));
  assert.equal(result.length, 1);
  assert.equal(result[0].comment, "  \n@agent go");
});

test("comment_created: a non-owner author yields no job — including with assigneeFilter:false", async () => {
  for (const pc of [{}, { assigneeFilter: false }]) {
    const { result } = await withJira({}, () => commentAdapter({ pc }).processEvents(commentEvt({ author: "acc-mallory" })));
    assert.deepEqual(result, [], JSON.stringify(pc));
  }
});

test("comment_created: an unresolvable /myself fails closed (no job)", async () => {
  const { result } = await withJira({ me: null }, () => commentAdapter().processEvents(commentEvt()));
  assert.deepEqual(result, []);
});

test("comment_created: no held record, or the held step at its attempt cap, yields no job", async () => {
  assert.deepEqual((await withJira({}, () => commentAdapter({ held: null }).processEvents(commentEvt()))).result, []);
  assert.deepEqual((await withJira({}, () => commentAdapter({ ran: 3 }).processEvents(commentEvt()))).result, []);
});

test("comment_created: a body not starting with the trigger yields no job", async () => {
  const { result, urls } = await withJira({}, () => commentAdapter().processEvents(commentEvt({ body: "thanks @agent, use Postgres" })));
  assert.deepEqual(result, []);
  assert.deepEqual(urls, [], "a non-trigger comment costs no API call");
});

test("comment_created: an issue assigned to someone else yields no job (fresh ownedByUs fetch)", async () => {
  const { result } = await withJira({ assignee: "acc-other" }, () => commentAdapter().processEvents(commentEvt()));
  assert.deepEqual(result, []);
});

test("comment_created: a duplicate delivery of the same comment carries the same dedupKey", async () => {
  const a = commentAdapter();
  const { result } = await withJira({}, async () => [...(await a.processEvents(commentEvt())), ...(await a.processEvents(commentEvt()))]);
  assert.equal(result.length, 2);
  assert.equal(result[0].dedupKey, result[1].dedupKey);
  assert.equal(result[0].dedupKey, "trigger:10042");
});

test("issue_updated for a comment (issue_commented, no status changelog) yields no job", async () => {
  const ev = { webhookEvent: "jira:issue_updated", issue_event_type_name: "issue_commented", issue: { key: "PROJ-7", fields: {} }, comment: { id: "1", body: "@agent go", author: { accountId: "acc-bot" } } };
  assert.deepEqual(await routed().processEvents(/** @type {any} */ ({ rawBody: JSON.stringify(ev) })), []);
});

test("registerWebhook's manual setup lists Comment → created", async () => {
  /** @type {string[]} */
  const out = [];
  const log = console.log;
  console.log = (/** @type {any} */ s) => out.push(String(s));
  try {
    await routed().registerWebhook("https://example.test");
  } finally {
    console.log = log;
  }
  assert.match(out.join("\n"), /Comment → created/);
});

// --- done signal (#585): a status move into a done-category status → board_done ---

/** An issue_updated status move of PROJ-7 into `to` (statusCategory `cat`), assigned to `assignee`.
 * @param {{to?: string, cat?: string, assignee?: string}} [o] */
const doneEvt = ({ to = "Done", cat = "done", assignee = "acc-bot" } = {}) =>
  /** @type {any} */ ({
    rawBody: JSON.stringify({
      webhookEvent: "jira:issue_updated",
      issue: { key: "PROJ-7", fields: { assignee: { accountId: assignee }, status: { name: to, statusCategory: { key: cat } } } },
      changelog: { id: "555", items: [{ field: "status", toString: to }] },
    }),
  });

test("board_done: an owned issue moved to an unbound done-category status yields one board_done; not ours → none", async () => {
  const a = routed({ assigneeFilter: true });
  assert.deepEqual((await withJira({}, () => a.processEvents(doneEvt()))).result, [{ kind: "board_done", ref: "PROJ-7", stepId: "", dedupKey: "done:555" }]);
  assert.deepEqual((await withJira({}, () => a.processEvents(doneEvt({ assignee: "acc-other" })))).result, []);
});

test("board_done: rides along with the step routing when the done-category status is bound; a non-done status yields none", async () => {
  const a = routed({ assigneeFilter: true });
  assert.deepEqual((await withJira({}, () => a.processEvents(doneEvt({ to: "To Do" })))).result, [
    { kind: "board_done", ref: "PROJ-7", stepId: "", dedupKey: "done:555" },
    { kind: "pipeline", ref: "PROJ-7", stepId: "code", dedupKey: "secmove:555" },
  ]);
  assert.deepEqual((await withJira({}, () => a.processEvents(doneEvt({ to: "To Do", cat: "new" })))).result, [
    { kind: "pipeline", ref: "PROJ-7", stepId: "code", dedupKey: "secmove:555" },
  ]);
});
