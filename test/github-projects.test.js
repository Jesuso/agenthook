// GitHub Projects v2 adapter — pure-unit coverage (no network): HMAC authenticate,
// Status-driven processEvents routing (created + edited, with the non-Status guards),
// and advance setting the Status single-select option per outcome. The adapter is
// GraphQL-only, so the fetch stub routes by inspecting the posted `query` string.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createGithubProjectsAdapter } from "../src/trackers/github-projects.js";

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

const pipeline = [{ id: "code", sourceStatus: "In Progress", successStatus: "In Review", failureStatus: "Blocked" }];

/** Build an adapter. Defaults to assigneeFilter:false so routing needs no `viewer` fetch. */
function adapter(pc = {}) {
  const providerConfig = { type: "github-projects", token: "t", project: "acme/7", assigneeFilter: false, ...pc };
  return createGithubProjectsAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline, providerConfig }), /** @type {any} */ (makeStore()));
}

const PROJECT_ID = "PVT_proj";
const STATUS_FIELD_ID = "PVTSSF_status";
const STATUS_OPTIONS = { "In Progress": "opt_inprog", "In Review": "opt_review", Blocked: "opt_blocked" };

/** A fetch stub that answers each GraphQL operation by matching its query text. `opts`
 * tunes the canned item: its Status, assignee logins, viewer login. Returns the captured
 * mutation variables (or null) so advance assertions can read what was set. */
function stubGraphql(opts = {}) {
  const { status = "In Progress", assignees = [], viewer = "bot", items } = opts;
  const captured = { mutation: /** @type {any} */ (null), calls: 0 };
  const orig = global.fetch;
  const issueNode = {
    __typename: "Issue",
    number: 42,
    title: "Wire up the thing",
    body: "do it",
    url: "https://github.com/acme/repo/issues/42",
    state: "OPEN",
    assignees: { nodes: assignees.map((/** @type {string} */ login) => ({ login })) },
  };
  const itemNodes = items || [{ id: "PVTI_42", content: issueNode, status: status ? { name: status } : null }];
  // @ts-ignore - test stub
  global.fetch = async (_url, init = {}) => {
    captured.calls++;
    const q = JSON.parse(String(init.body)).query;
    const vars = JSON.parse(String(init.body)).variables;
    /** @param {any} data */
    const ok = (data) => /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ data }) });
    if (q.includes("updateProjectV2ItemFieldValue")) {
      captured.mutation = vars;
      return ok({ updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.item } } });
    }
    if (q.includes("items(first:100")) return ok({ node: { items: { nodes: itemNodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (q.includes("ProjectV2SingleSelectField")) {
      return ok({ node: { field: { id: STATUS_FIELD_ID, name: "Status", options: Object.entries(STATUS_OPTIONS).map(([name, id]) => ({ id, name })) } } });
    }
    if (q.includes("fieldValueByName")) return ok({ node: { id: itemNodes[0].id, content: issueNode, status: status ? { name: status } : null } });
    if (q.includes("viewer")) return ok({ viewer: { login: viewer } });
    if (q.includes("projectV2(number")) return ok({ organization: { projectV2: { id: PROJECT_ID } }, user: null });
    return ok({});
  };
  return { captured, restore: () => (global.fetch = orig) };
}

/** A `projects_v2_item` webhook delivery context. */
function evt(ev, headers = {}) {
  return { pathname: "/github-projects/", headers: { "x-github-event": "projects_v2_item", ...headers }, rawBody: JSON.stringify(ev) };
}

test("authenticate accepts a correctly signed body", () => {
  const a = adapter({ webhookSecret: "s3cr3t" });
  const body = JSON.stringify({ hello: 1 });
  const sig = "sha256=" + crypto.createHmac("sha256", "s3cr3t").update(body).digest("hex");
  assert.equal(a.authenticate(/** @type {any} */ ({ rawBody: body, headers: { "x-hub-signature-256": sig } })).type, "accept");
});

test("authenticate rejects a bad signature", () => {
  const a = adapter({ webhookSecret: "s3cr3t" });
  assert.equal(a.authenticate(/** @type {any} */ ({ rawBody: "{}", headers: { "x-hub-signature-256": "sha256=deadbeef" } })).type, "reject");
});

test("authenticate accepts unsigned when webhookSecret:false", () => {
  const a = adapter({ webhookSecret: false });
  assert.equal(a.authenticate(/** @type {any} */ ({ rawBody: "{}", headers: {} })).type, "accept");
});

test("a status-change edited event routes to the step whose sourceStatus the item now rests in", async () => {
  const { captured, restore } = stubGraphql({ status: "In Progress" });
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (
        evt(
          {
            action: "edited",
            projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" },
            changes: { field_value: { field_node_id: STATUS_FIELD_ID, field_type: "single_select" } },
          },
          { "x-github-delivery": "guid-1" },
        )
      ),
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].ref, "42");
    assert.equal(jobs[0].stepId, "code");
    assert.equal(jobs[0].dedupKey, "secmove:guid-1");
  } finally {
    restore();
  }
  assert.ok(captured.calls > 0);
});

test("a created event routes by the item's current Status (state-based dedup key)", async () => {
  const { restore } = stubGraphql({ status: "In Progress" });
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (evt({ action: "created", projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" } })),
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].dedupKey, "step:code:42");
  } finally {
    restore();
  }
});

test("a non-single-select edit yields no job (and never queries the item)", async () => {
  const { captured, restore } = stubGraphql();
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (
        evt({ action: "edited", projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" }, changes: { field_value: { field_type: "text" } } })
      ),
    );
    assert.equal(jobs.length, 0);
    assert.equal(captured.calls, 0); // short-circuited before any GraphQL
  } finally {
    restore();
  }
});

test("a single-select edit on a DIFFERENT field (not Status) yields no job", async () => {
  const { restore } = stubGraphql();
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (
        evt({
          action: "edited",
          projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" },
          changes: { field_value: { field_node_id: "PVTSSF_priority", field_type: "single_select" } },
        })
      ),
    );
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("an item whose Status matches no step yields no job", async () => {
  const { restore } = stubGraphql({ status: "Done" });
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (evt({ action: "created", projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" } })),
    );
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("a non-issue item (draft/PR) yields no job", async () => {
  const { restore } = stubGraphql();
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (evt({ action: "created", projects_v2_item: { node_id: "PVTI_draft", content_type: "DraftIssue" } })),
    );
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("a non-projects_v2_item delivery is ignored", async () => {
  const jobs = await adapter().processEvents(
    /** @type {any} */ (evt({ action: "created", projects_v2_item: { node_id: "PVTI_42" } }, { "x-github-event": "issues" })),
  );
  assert.equal(jobs.length, 0);
});

test("an item not assigned to us yields no job (fail-closed scoping)", async () => {
  const { restore } = stubGraphql({ status: "In Progress", assignees: ["someone-else"], viewer: "bot" });
  try {
    // assigneeFilter default (true): the issue's assignee must be the viewer login.
    const jobs = await adapter({ assigneeFilter: true }).processEvents(
      /** @type {any} */ (evt({ action: "created", projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" } })),
    );
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("advance sets the Status single-select to the SUCCESS option (updateProjectV2ItemFieldValue)", async () => {
  const { captured, restore } = stubGraphql();
  try {
    await adapter().advance("42", "code", { outcome: "advance" });
  } finally {
    restore();
  }
  assert.ok(captured.mutation, "expected an updateProjectV2ItemFieldValue mutation");
  assert.equal(captured.mutation.project, PROJECT_ID);
  assert.equal(captured.mutation.item, "PVTI_42");
  assert.equal(captured.mutation.field, STATUS_FIELD_ID);
  assert.equal(captured.mutation.option, STATUS_OPTIONS["In Review"]);
});

test("advance maps fail → failureStatus option", async () => {
  const { captured, restore } = stubGraphql();
  try {
    await adapter().advance("42", "code", { outcome: "fail" });
  } finally {
    restore();
  }
  assert.equal(captured.mutation.option, STATUS_OPTIONS["Blocked"]);
});

test("advance is a no-op when the target status has no matching Status option", async () => {
  const { captured, restore } = stubGraphql();
  try {
    // holdStatus isn't set on the step → outcome hold resolves to no status → no mutation.
    await adapter().advance("42", "code", { outcome: "hold" });
  } finally {
    restore();
  }
  assert.equal(captured.mutation, null);
});

test("advance refuses to move an item whose issue isn't ours (fail-closed)", async () => {
  const { captured, restore } = stubGraphql({ assignees: ["someone-else"], viewer: "bot" });
  try {
    await adapter({ assigneeFilter: true }).advance("42", "code", { outcome: "advance" });
  } finally {
    restore();
  }
  assert.equal(captured.mutation, null);
});

test("fetchTask maps the project item's issue to neutral Task fields", async () => {
  const { restore } = stubGraphql({ status: "In Progress" });
  let task;
  try {
    task = await adapter().fetchTask("42");
  } finally {
    restore();
  }
  assert.equal(task.ref, "42");
  assert.equal(task.name, "Wire up the thing");
  assert.equal(task.description, "do it");
  assert.equal(task.completed, false);
  assert.equal(task.url, "https://github.com/acme/repo/issues/42");
});

test("listResting yields one job per open issue resting in a step's source Status", async () => {
  const { restore } = stubGraphql({ status: "In Progress" });
  let jobs;
  try {
    jobs = await adapter().listResting();
  } finally {
    restore();
  }
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].stepId, "code");
  assert.equal(jobs[0].dedupKey, "reconcile:code:42");
});
