import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub Projects v2 adapter — pure-unit coverage (no network): HMAC authenticate,
// Status-driven processEvents routing (created + edited, with the non-Status guards),
// and advance setting the Status single-select option per outcome. The adapter is
// GraphQL-only, so the fetch stub routes by inspecting the posted `query` string.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createGithubProjectsAdapter, extractRouteKeys, isEpicGqlIssue, toRestShape, mapProjectEpics, mapProjectEpicTickets } from "../src/trackers/github-projects.js";
import { MoveRefusedError } from "../src/trackers/owner.js";

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
  const captured = { mutation: /** @type {any} */ (null), assigned: /** @type {any} */ (null), added: /** @type {any} */ (null), calls: 0 };
  const orig = global.fetch;
  const issueNode = {
    __typename: "Issue",
    id: "I_42",
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
    if (q.includes("addAssigneesToAssignable")) {
      captured.assigned = vars;
      return ok({ addAssigneesToAssignable: { clientMutationId: "x" } });
    }
    if (q.includes("addProjectV2ItemById")) {
      captured.added = vars;
      return ok({ addProjectV2ItemById: { item: { id: "PVTI_new" } } });
    }
    if (q.includes("repository(owner")) return ok({ repository: { issue: { id: "I_new" } } });
    if (q.includes("items(first:100")) return ok({ node: { items: { nodes: itemNodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    if (q.includes("ProjectV2FieldCommon")) {
      // Resolve a field node id -> name. STATUS_FIELD_ID and the same-field-under-a-
      // different-id alias both name "Status"; a real other field names itself; an
      // unknown id resolves to null (caller falls through with a warning).
      const NAMES = /** @type {Record<string,string>} */ ({ [STATUS_FIELD_ID]: "Status", PVTSSF_status_alt: "Status", PVTSSF_priority: "Priority" });
      return ok({ node: { name: NAMES[vars.id] ?? null } });
    }
    if (q.includes("ProjectV2SingleSelectField")) {
      return ok({ node: { field: { id: STATUS_FIELD_ID, name: "Status", options: Object.entries(STATUS_OPTIONS).map(([name, id]) => ({ id, name })) } } });
    }
    if (q.includes("fieldValueByName")) return ok({ node: { id: itemNodes[0].id, content: issueNode, status: status ? { name: status } : null } });
    if (q.includes("viewer")) return ok({ viewer: { login: viewer, id: "U_bot" } });
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

test("#35: edited whose field_node_id differs from the Status id but resolves by NAME to Status still fires", async () => {
  // The webhook's field_node_id and the GraphQL field id differ in format, yet both name
  // the same Status field. The old hard id-equality gate would silently drop this; we now
  // confirm identity by name and route the (real) Status change.
  const { restore } = stubGraphql({ status: "In Progress" });
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (
        evt(
          {
            action: "edited",
            projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" },
            changes: { field_value: { field_node_id: "PVTSSF_status_alt", field_type: "single_select" } },
          },
          { "x-github-delivery": "guid-alt" },
        )
      ),
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].stepId, "code");
    assert.equal(jobs[0].dedupKey, "secmove:guid-alt");
  } finally {
    restore();
  }
});

test("#35: edited whose changed field id is unknown (name unresolved) falls through to the live Status re-read", async () => {
  // Fail-open-with-log: an id we can't match AND can't name should not silently stall; it
  // routes by the item's actual current Status (here "In Progress" → the code step).
  const { restore } = stubGraphql({ status: "In Progress" });
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (
        evt({
          action: "edited",
          projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" },
          changes: { field_value: { field_node_id: "PVTSSF_unknown", field_type: "single_select" } },
        })
      ),
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].stepId, "code");
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
    await assert.rejects(adapter({ assigneeFilter: true }).advance("42", "code", { outcome: "advance" }), (e) => e instanceof MoveRefusedError && e.reason === "not_ours");
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

test("forgeCatchup exposes the matched step when the item rests in a source Status", async () => {
  const { restore } = stubGraphql({ status: "In Progress" });
  let forged;
  try {
    forged = await adapter().forgeCatchup?.("42");
  } finally {
    restore();
  }
  assert.equal(forged?.stepId, "code");
  assert.equal(forged?.dedupKey, "step:code:42");
  assert.equal(forged?.path, "/github-projects/");
  // The forged event is a `created` projects_v2_item carrying the item's node id.
  const ev = JSON.parse(String(forged?.body));
  assert.equal(ev.action, "created");
  assert.equal(ev.projects_v2_item.node_id, "PVTI_42");
});

test("forgeCatchup leaves stepId undefined when the item's Status maps to no step (catchup detects the no-op)", async () => {
  const { restore } = stubGraphql({ status: "Done" });
  let forged;
  try {
    forged = await adapter().forgeCatchup?.("42");
  } finally {
    restore();
  }
  assert.equal(forged?.stepId, undefined);
  assert.equal(forged?.dedupKey, "issue:42:created");
});

// --- agenthook run: enterStage (assign + set source Status, add-to-project if needed) ---

test("enterStage assigns the issue and sets the source Status when the issue is already a card", async () => {
  // The card currently rests in "In Review"; entering the code step sets it to In Progress.
  const { captured, restore } = stubGraphql({ status: "In Review" });
  let r;
  try {
    r = await adapter().enterStage("42", "code", {});
  } finally {
    restore();
  }
  assert.equal(r.stage, "In Progress");
  assert.equal(captured.mutation.item, "PVTI_42");
  assert.equal(captured.mutation.option, STATUS_OPTIONS["In Progress"]); // moved to sourceStatus
  assert.ok(captured.assigned, "assigned the issue to us");
  assert.equal(captured.assigned.a, "I_42"); // the issue node id
  assert.deepEqual(captured.assigned.u, ["U_bot"]); // the viewer's user id
});

test("enterStage skips the assign when opts.assign === false", async () => {
  const { captured, restore } = stubGraphql({ status: "In Review" });
  try {
    await adapter().enterStage("42", "code", { assign: false });
  } finally {
    restore();
  }
  assert.equal(captured.assigned, null);
  assert.equal(captured.mutation.option, STATUS_OPTIONS["In Progress"]);
});

test("enterStage adds the issue to the project (via tracker.repository) when it isn't a card yet", async () => {
  const { captured, restore } = stubGraphql({ items: [] }); // findItem → null (no card)
  let r;
  try {
    r = await adapter({ repository: "acme/repo" }).enterStage("42", "code", {});
  } finally {
    restore();
  }
  assert.equal(r.stage, "In Progress");
  assert.ok(captured.added, "added the issue to the project");
  assert.equal(captured.added.c, "I_new"); // issue node id resolved from tracker.repository
  assert.equal(captured.assigned.a, "I_new"); // assigned the freshly-added issue
  assert.equal(captured.mutation.item, "PVTI_new"); // Status set on the new item
  assert.equal(captured.mutation.option, STATUS_OPTIONS["In Progress"]);
});

test("enterStage refuses to add a loose issue when tracker.repository is unset", async () => {
  const { restore } = stubGraphql({ items: [] });
  try {
    await assert.rejects(() => adapter().enterStage("42", "code", {}), /tracker\.repository is unset/);
  } finally {
    restore();
  }
});

// --- agenthook init: wizardSteps discovery + pipelineBindings ---

/** A fetch stub for the `viewer{ projectsV2, organizations }` project-list discovery query. */
function stubViewerProjects(data) {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (_url, init = {}) => {
    const q = JSON.parse(String(init.body)).query;
    const ok = (d) => /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ data: d }) });
    if (q.includes("organizations(first:100)")) return ok({ viewer: data });
    return ok({});
  };
  return { restore: () => (global.fetch = orig) };
}

test("wizardSteps project discovery flattens user + org Projects v2 into owner/number choices", async () => {
  const { restore } = stubViewerProjects({
    login: "alice",
    projectsV2: { nodes: [{ number: 1, title: "Roadmap" }] },
    organizations: { nodes: [{ login: "acme", projectsV2: { nodes: [{ number: 7, title: "Board" }] } }] },
  });
  let choices;
  try {
    const step = adapter().wizardSteps?.().find((s) => s.key === "project");
    choices = await /** @type {any} */ (step).choices();
  } finally {
    restore();
  }
  assert.deepEqual(
    choices.map((/** @type {any} */ c) => c.value),
    ["alice/1", "acme/7"],
  );
});

test("wizardSteps Status-option discovery parses the picked project's single-select options", async () => {
  const { restore } = stubGraphql();
  let opts;
  try {
    const step = adapter().wizardSteps?.().find((s) => s.key === "_sourceStage");
    opts = await /** @type {any} */ (step).choices({ project: "acme/7" });
  } finally {
    restore();
  }
  assert.deepEqual(
    opts.map((/** @type {any} */ o) => o.value),
    ["In Progress", "In Review", "Blocked"],
  );
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

test("listStages parses the configured project's Status single-select options", async () => {
  const { restore } = stubGraphql();
  let stages;
  try {
    stages = await adapter().listStages?.();
  } finally {
    restore();
  }
  assert.deepEqual(stages, [
    { id: "In Progress", label: "In Progress" },
    { id: "In Review", label: "In Review" },
    { id: "Blocked", label: "Blocked" },
  ]);
});

test("pipelineBindings maps the wizard Status picks to step fields", () => {
  const b = adapter().pipelineBindings?.({ _sourceStage: "In Progress", _successStage: "In Review", _failureStage: "Blocked" });
  assert.deepEqual(b, { sourceStatus: "In Progress", successStatus: "In Review", failureStatus: "Blocked" });
});

test("pipelineBindings returns null when no Status was picked (init keeps the TODO_* skeleton)", () => {
  assert.equal(adapter().pipelineBindings?.({}), null);
});

// --- webhook lifecycle (org auto-register / scrub, user + missing-scope fallbacks) ---

/** A fetch stub for the REST webhook path. Answers the GraphQL project probe (org vs
 * user owner) and the `/orgs/{org}/hooks` list/create/delete calls, recording each. */
function stubWebhook(opts = {}) {
  const { owner = "org", hooks = [], createStatus = 201, listStatus = 200 } = opts;
  const calls = { lists: 0, posts: /** @type {any[]} */ ([]), deletes: /** @type {string[]} */ ([]) };
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    const reply = (status, data) => /** @type {any} */ ({ ok: status >= 200 && status < 300, status, json: async () => data });
    if (u.endsWith("/graphql")) {
      const data = owner === "org" ? { organization: { projectV2: { id: "PVT_proj" } }, user: null } : { organization: null, user: { projectV2: { id: "PVT_proj" } } };
      return reply(200, { data });
    }
    if (u.includes("/orgs/") && u.includes("/hooks")) {
      if (method === "GET") {
        calls.lists++;
        return listStatus === 200 ? reply(200, hooks) : reply(listStatus, {});
      }
      if (method === "POST") {
        calls.posts.push(JSON.parse(String(init.body)));
        return reply(createStatus, createStatus < 300 ? { id: 99, active: true } : {});
      }
      if (method === "DELETE") {
        calls.deletes.push(u);
        return reply(204, {});
      }
    }
    return reply(200, {});
  };
  return { calls, restore: () => (global.fetch = orig) };
}

/** Capture console.log/console.warn lines for the duration of `fn`. */
async function captureLogs(fn) {
  const lines = /** @type {string[]} */ ([]);
  const log = console.log;
  const warn = console.warn;
  console.log = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines;
}

test("registerWebhook on an org project scrubs our stale hooks then creates one signed projects_v2_item hook", async () => {
  const hooks = [
    { id: 1, config: { url: "https://old.example/github-projects/" } }, // ours (stale URL)
    { id: 2, config: { url: "https://other.example/some-hook" } }, // unrelated — must survive
  ];
  const { calls, restore } = stubWebhook({ owner: "org", hooks });
  try {
    await captureLogs(() => adapter().registerWebhook("https://new.example"));
  } finally {
    restore();
  }
  assert.equal(calls.deletes.length, 1, "only our stale hook is deleted");
  assert.match(calls.deletes[0], /\/orgs\/acme\/hooks\/1$/);
  assert.equal(calls.posts.length, 1, "exactly one hook created");
  assert.deepEqual(calls.posts[0].events, ["projects_v2_item"]);
  assert.equal(calls.posts[0].config.url, "https://new.example/github-projects/");
  assert.equal(calls.posts[0].config.content_type, "json");
  assert.ok(calls.posts[0].config.secret, "the generated secret is passed into the hook config");
});

test("registerWebhook falls back to manual instructions on 403 (missing admin:org_hook), without throwing or creating", async () => {
  const { calls, restore } = stubWebhook({ owner: "org", createStatus: 403 });
  let lines;
  try {
    lines = await captureLogs(() => adapter().registerWebhook("https://new.example"));
  } finally {
    restore();
  }
  assert.equal(calls.posts.length, 1, "it attempted the create");
  assert.ok(lines.some((l) => /admin:org_hook/.test(l)), "printed the manual org-webhook instructions");
  assert.ok(lines.some((l) => /Projects v2 item/.test(l)));
});

test("registerWebhook on a USER-owned project prints a clear not-supported message and creates no hook", async () => {
  const { calls, restore } = stubWebhook({ owner: "user" });
  let lines;
  try {
    lines = await captureLogs(() => adapter().registerWebhook("https://new.example"));
  } finally {
    restore();
  }
  assert.equal(calls.posts.length, 0, "no hook is created for a user-owned project");
  assert.equal(calls.lists, 0, "and we never even list org hooks");
  assert.ok(lines.some((l) => /USER-owned/.test(l) && /GitHub App/.test(l)));
});

test("unregisterWebhooks deletes only our org hooks for an org project", async () => {
  const hooks = [
    { id: 1, config: { url: "https://x.example/github-projects" } }, // ours
    { id: 2, config: { url: "https://x.example/unrelated" } }, // not ours
  ];
  const { calls, restore } = stubWebhook({ owner: "org", hooks });
  try {
    await captureLogs(() => adapter().unregisterWebhooks());
  } finally {
    restore();
  }
  assert.equal(calls.deletes.length, 1);
  assert.match(calls.deletes[0], /\/orgs\/acme\/hooks\/1$/);
});

test("unregisterWebhooks is a no-op for a user-owned project", async () => {
  const { calls, restore } = stubWebhook({ owner: "user" });
  try {
    await captureLogs(() => adapter().unregisterWebhooks());
  } finally {
    restore();
  }
  assert.equal(calls.lists, 0);
  assert.equal(calls.deletes.length, 0);
});

// --- queue-stage pull: listQueued ---
test("listQueued returns our open cards in the queue Status, board POSITION order", async () => {
  const card = (/** @type {number} */ n, /** @type {string} */ status, o = {}) => ({
    id: `PVTI_${n}`,
    content: { __typename: "Issue", id: `I_${n}`, number: n, state: "OPEN", assignees: { nodes: [{ login: "bot" }] }, ...o },
    status: { name: status },
  });
  const items = [
    card(9, "Backlog"),
    card(2, "In Progress"),
    card(4, "backlog", { state: "CLOSED" }),
    card(5, "Backlog", { assignees: { nodes: [{ login: "someone" }] } }),
    card(1, "Backlog"),
  ];
  const { restore } = stubGraphql({ items });
  /** @type {string[]} */
  const queries = [];
  const inner = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => (queries.push(JSON.parse(String(init.body)).query), inner(url, init));
  const pl = [{ id: "code", sourceStatus: "In Progress", queueStatus: "Backlog" }];
  const a = createGithubProjectsAdapter(
    /** @type {any} */ ({ trigger: "@agent", pipeline: pl, providerConfig: { type: "github-projects", token: "t", project: "acme/7" } }),
    /** @type {any} */ (makeStore()),
  );
  let refs;
  try {
    refs = await a.listQueued("code");
  } finally {
    restore();
  }
  assert.deepEqual(refs, ["9", "1"]);
  assert.ok(queries.some((q) => q.includes("orderBy:{field:POSITION, direction:ASC}")), "items are read in board position order");
});

test("extractRouteKeys: [name] or []", () => {
  assert.deepEqual(extractRouteKeys("ios"), ["ios"]);
  assert.deepEqual(extractRouteKeys(null), []);
  assert.deepEqual(extractRouteKeys(""), []);
});

test("routeField adds a route: alias to the item query; fetchTask returns [name]", async () => {
  const issue = { __typename: "Issue", id: "I_42", number: 42, title: "t", body: "", url: "u", state: "OPEN", assignees: { nodes: [] } };
  const items = [{ id: "PVTI_42", content: issue, status: { name: "In Progress" }, route: { name: "ios" } }];
  const { restore } = stubGraphql({ items });
  /** @type {string[]} */
  const queries = [];
  const inner = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => (queries.push(JSON.parse(String(init.body)).query), inner(url, init));
  try {
    const t = await adapter({ routeField: 'Plat"form' }).fetchTask("42");
    assert.deepEqual(t.routeKeys, ["ios"]);
    assert.ok(queries.some((q) => q.includes('route: fieldValueByName(name:"Plat\\"form")')), queries.join("\n"));
    queries.length = 0;
    const t2 = await adapter().fetchTask("42");
    assert.deepEqual(t2.routeKeys, []);
    assert.ok(!queries.some((q) => q.includes("route:")));
  } finally {
    restore();
  }
});

// --- epics (ADR 0003/0004/0005) ---
const REPO = "acme/repo";
/** A GraphQL Issue node. @param {number} n @param {Record<string, any>} [o] */
const gqlIssue = (n, o = {}) => ({
  __typename: "Issue",
  id: `I_${n}`,
  number: n,
  title: `issue ${n}`,
  body: "",
  url: `https://github.com/${REPO}/issues/${n}`,
  state: "OPEN",
  assignees: { nodes: [] },
  issueType: null,
  labels: { nodes: [] },
  repository: { nameWithOwner: REPO },
  parent: null,
  ...o,
});
const TYPED_EPIC = gqlIssue(10, { title: "Typed epic", issueType: { name: "Epic" } });
const LABELLED_EPIC = gqlIssue(11, { title: "Labelled epic", labels: { nodes: [{ name: "EPIC" }] }, state: "CLOSED" });
const PLAIN_PARENT = gqlIssue(12, { title: "Plain parent" });
/** @param {any} issue @param {string|null} status */
const card = (issue, status) => ({ id: `PVTI_${issue.number}`, content: issue, status: status ? { name: status } : null });

test("isEpicGqlIssue: typed or labelled (any case) epic; plain parent / null is not", () => {
  assert.equal(isEpicGqlIssue(TYPED_EPIC, "Epic", "epic"), true);
  assert.equal(isEpicGqlIssue(LABELLED_EPIC, "Epic", "epic"), true);
  assert.equal(isEpicGqlIssue(PLAIN_PARENT, "Epic", "epic"), false);
  assert.equal(isEpicGqlIssue(null, "Epic", "epic"), false);
  assert.deepEqual(toRestShape(LABELLED_EPIC), { type: null, labels: [{ name: "EPIC" }] });
  assert.deepEqual(toRestShape(TYPED_EPIC).type, { name: "Epic" });
});

test("mapProjectEpics: only epic Issue cards, Status (null when unset), completed, deduped", () => {
  const items = [card(TYPED_EPIC, "In Progress"), card(PLAIN_PARENT, "Todo"), card(LABELLED_EPIC, null), card(TYPED_EPIC, "In Progress"), { issue: { __typename: "DraftIssue" }, status: null }];
  const shaped = items.map((it) => ("content" in it ? { issue: it.content, status: it.status?.name ?? null } : it));
  assert.deepEqual(mapProjectEpics(shaped, "Epic", "epic"), [
    { ref: "10", name: "Typed epic", url: `https://github.com/${REPO}/issues/10`, displayId: "#10", status: "In Progress", completed: false },
    { ref: "11", name: "Labelled epic", url: `https://github.com/${REPO}/issues/11`, displayId: "#11", status: null, completed: true },
  ]);
});

test("mapProjectEpicTickets: same/other repo refs, on-board Status, no-Status → '', off-board → null", () => {
  const children = [
    { id: "I_20", number: 20, title: "same on board", state: "OPEN", repository: { nameWithOwner: "ACME/Repo" } },
    { id: "I_21", number: 21, title: "same off board", state: "CLOSED", repository: { nameWithOwner: REPO } },
    { id: "I_X5", number: 5, title: "other on board", state: "OPEN", repository: { nameWithOwner: "acme/other" } },
    { id: "I_22", number: 22, title: "same no status", state: "OPEN", repository: { nameWithOwner: REPO } },
  ];
  const stages = new Map([
    ["I_20", "In Review"],
    ["I_X5", "Todo"],
    ["I_22", null],
  ]);
  assert.deepEqual(mapProjectEpicTickets(children, REPO, stages), [
    { ref: "20", displayId: "#20", name: "same on board", completed: false, stage: "In Review" },
    { ref: "21", displayId: "#21", name: "same off board", completed: true, stage: null },
    { ref: "acme/other#5", displayId: "acme/other#5", name: "other on board", completed: false, stage: "Todo" },
    { ref: "22", displayId: "#22", name: "same no status", completed: false, stage: "" },
  ]);
});

test("fetchTask: typed / labelled epic → isEpic; plain parent → false", async () => {
  const { restore } = stubGraphql({ items: [card(TYPED_EPIC, "Todo"), card(LABELLED_EPIC, "Todo"), card(PLAIN_PARENT, "Todo")] });
  try {
    const a = adapter();
    assert.equal((await a.fetchTask("10")).isEpic, true);
    assert.equal((await a.fetchTask("11")).isEpic, true);
    assert.equal((await a.fetchTask("12")).isEpic, false);
  } finally {
    restore();
  }
});

test("fetchTask: same-repo epic parent → epic; plain or other-repo parent → no epic key; no extra request", async () => {
  const child = gqlIssue(30, { parent: { number: 10, title: "Typed epic", url: TYPED_EPIC.url, issueType: { name: "Epic" }, labels: { nodes: [] }, repository: { nameWithOwner: "Acme/Repo" } } });
  const plainChild = gqlIssue(31, { parent: { number: 12, title: "Plain parent", url: PLAIN_PARENT.url, issueType: null, labels: { nodes: [] }, repository: { nameWithOwner: REPO } } });
  const otherChild = gqlIssue(32, { parent: { number: 10, title: "Foreign epic", url: "u", issueType: { name: "Epic" }, labels: { nodes: [] }, repository: { nameWithOwner: "acme/other" } } });
  const orphan = gqlIssue(33);
  const { captured, restore } = stubGraphql({ items: [card(child, "Todo"), card(plainChild, "Todo"), card(otherChild, "Todo"), card(orphan, "Todo")] });
  try {
    const a = adapter();
    const t = await a.fetchTask("30");
    assert.deepEqual(t.epic, { ref: "10", name: "Typed epic", url: TYPED_EPIC.url, displayId: "#10" });
    assert.equal(t.isEpic, false);
    const callsAfterFirst = captured.calls;
    assert.equal(callsAfterFirst, 2, "project id + one item scan — no parent lookup");
    assert.ok(!("epic" in (await a.fetchTask("31"))));
    assert.ok(!("epic" in (await a.fetchTask("32"))));
    assert.ok(!("epic" in (await a.fetchTask("33"))));
    assert.equal(captured.calls - callsAfterFirst, 3, "one scan per fetchTask (project id memoised)");
  } finally {
    restore();
  }
});

test("the item query reads issueType, labels, repository and parent", async () => {
  const { restore } = stubGraphql();
  /** @type {string[]} */
  const queries = [];
  const inner = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => (queries.push(JSON.parse(String(init.body)).query), inner(url, init));
  try {
    await adapter().fetchTask("42");
  } finally {
    restore();
  }
  const q = queries.find((x) => x.includes("items(first:100")) || "";
  for (const f of ["issueType{ name }", "labels(first:20){ nodes{ name } }", "repository{ nameWithOwner }", "parent{ number title url"]) assert.ok(q.includes(f), f);
});

test("listResting / listQueued never return an epic card", async () => {
  const pl = [{ id: "code", sourceStatus: "In Progress", queueStatus: "Todo" }];
  const items = [card(TYPED_EPIC, "In Progress"), card(gqlIssue(40), "In Progress"), card(gqlIssue(41, { labels: { nodes: [{ name: "Epic" }] } }), "Todo"), card(gqlIssue(42), "Todo")];
  const { restore } = stubGraphql({ items });
  try {
    const a = createGithubProjectsAdapter(
      /** @type {any} */ ({ trigger: "@agent", pipeline: pl, providerConfig: { type: "github-projects", token: "t", project: "acme/7", assigneeFilter: false } }),
      /** @type {any} */ (makeStore()),
    );
    assert.deepEqual((await a.listResting()).map((j) => j.ref), ["40"]);
    assert.deepEqual(await a.listQueued("code"), ["42"]);
  } finally {
    restore();
  }
});

test("listEpics: epic cards on the board; GraphQL failure → [] + warn", async () => {
  const { restore } = stubGraphql({ items: [card(TYPED_EPIC, "Todo"), card(PLAIN_PARENT, "Todo"), card(LABELLED_EPIC, null)] });
  try {
    const epics = await adapter().listEpics?.();
    assert.deepEqual(epics?.map((e) => [e.ref, e.status, e.completed]), [
      ["10", "Todo", false],
      ["11", null, true],
    ]);
  } finally {
    restore();
  }
  const orig = global.fetch;
  const warn = console.warn;
  /** @type {any[]} */
  const warned = [];
  console.warn = (...args) => warned.push(args);
  // @ts-ignore - test stub
  global.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  try {
    assert.deepEqual(await adapter().listEpics?.(), []);
    assert.ok(warned.some((w) => String(w[0]).startsWith("[epics]")));
  } finally {
    global.fetch = orig;
    console.warn = warn;
  }
});

/** Wrap stubGraphql so subIssues queries answer from `pages` (one per call, by cursor). */
function stubSubIssues(items, pages) {
  const stub = stubGraphql({ items });
  const inner = global.fetch;
  /** @type {any[]} */
  const subCalls = [];
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    const { query, variables } = JSON.parse(String(init.body));
    if (query.includes("subIssues")) {
      stub.captured.calls++;
      subCalls.push(variables);
      const page = pages[subCalls.length - 1];
      if (page instanceof Error) throw page;
      return { ok: true, status: 200, json: async () => ({ data: { node: { subIssues: page } } }) };
    }
    return inner(url, init);
  };
  return { ...stub, subCalls };
}

test("listEpicTickets: pages sub-issues, maps refs + board stages", async () => {
  const onBoard = gqlIssue(50);
  const noStatus = gqlIssue(52);
  const foreign = gqlIssue(7, { id: "I_F7", repository: { nameWithOwner: "acme/other" } });
  const items = [card(TYPED_EPIC, "Todo"), card(onBoard, "In Review"), card(noStatus, null), card(foreign, "Todo")];
  const pages = [
    { nodes: [{ id: "I_50", number: 50, title: "a", state: "OPEN", repository: { nameWithOwner: REPO } }, { id: "I_51", number: 51, title: "b", state: "CLOSED", repository: { nameWithOwner: REPO } }], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    { nodes: [{ id: "I_F7", number: 7, title: "c", state: "OPEN", repository: { nameWithOwner: "acme/other" } }, { id: "I_52", number: 52, title: "d", state: "OPEN", repository: { nameWithOwner: REPO } }], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  const { subCalls, restore } = stubSubIssues(items, pages);
  let tickets;
  try {
    tickets = await adapter().listEpicTickets?.("10");
  } finally {
    restore();
  }
  assert.deepEqual(subCalls, [
    { id: "I_10", after: null },
    { id: "I_10", after: "c1" },
  ]);
  assert.deepEqual(
    tickets?.map((t) => [t.ref, t.displayId, t.stage, t.completed]),
    [
      ["50", "#50", "In Review", false],
      ["51", "#51", null, true],
      ["acme/other#7", "acme/other#7", "Todo", false],
      ["52", "#52", "", false],
    ],
  );
});

test("listEpicTickets: bad ref → [] with no fetch; not on board / not an epic / GraphQL error → []", async () => {
  const { captured, restore } = stubSubIssues([card(TYPED_EPIC, "Todo"), card(PLAIN_PARENT, "Todo")], [new Error("boom")]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const a = adapter();
    for (const bad of ["1.2", "../x", "", "10a"]) assert.deepEqual(await a.listEpicTickets?.(bad), []);
    assert.equal(captured.calls, 0, "no request for an invalid ref");
    assert.deepEqual(await a.listEpicTickets?.("99"), []);
    assert.deepEqual(await a.listEpicTickets?.("12"), []);
    assert.deepEqual(await a.listEpicTickets?.("10"), []);
  } finally {
    restore();
    console.warn = warn;
  }
});
