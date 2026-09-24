// Jira adapter — pure-unit coverage (no network): the adapter contract (x-hub-signature
// verify, issue_created + issue_updated status-change routing, advance → transition lookup —
// mirrors test/github.test.js) plus the `agenthook init` discovery. Note for the init test:
// site/email are collected BY the wizard, so the status discovery rebuilds base+auth from the
// answers (not the factory's cached pair) — the test asserts it hits the answered site/project,
// and dedups statuses across issue types.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createJiraAdapter, extractRouteKeys } from "../src/trackers/jira.js";

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
  assert.ok(urls[0].endsWith("fields=summary,description,status,assignee,components"), urls[0]);
  assert.ok(urls[1].endsWith("fields=summary,description,status,assignee,customfield_10010"), urls[1]);
  assert.ok(urls[2].endsWith("fields=summary,description,status,assignee"), urls[2]);
  assert.ok(urls[3].endsWith("fields=summary,description,status,assignee"), urls[3]);
});
