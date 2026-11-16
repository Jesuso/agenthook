import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub Projects v2 adapter — pure-unit coverage (no network): `agenthook run`'s enterStage
// (assign + set source Status, add-to-project if needed), `agenthook init`'s wizardSteps
// discovery + pipelineBindings, webhook lifecycle (org auto-register/scrub, user + missing-
// scope fallbacks), and the queue-stage pull (listQueued). The adapter is GraphQL-only, so
// the fetch stubs route by inspecting the posted `query` string.
import test from "node:test";
import assert from "node:assert/strict";
import { createGithubProjectsAdapter, extractRouteKeys } from "../src/trackers/github-projects.js";
import { adapter, makeStore, stubGraphql, STATUS_OPTIONS } from "./_github-projects-helpers.js";

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

test("pipelineBindings adds holdStatus only when _holdStage was picked", () => {
  const a = adapter();
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "In Progress", _successStage: "In Review", _failureStage: "Blocked", _holdStage: "Waiting" }), {
    sourceStatus: "In Progress",
    successStatus: "In Review",
    failureStatus: "Blocked",
    holdStatus: "Waiting",
  });
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "In Progress", _successStage: "In Review", _failureStage: "Blocked", _holdStage: "" }), {
    sourceStatus: "In Progress",
    successStatus: "In Review",
    failureStatus: "Blocked",
  });
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

test("registerWebhook on an org project scrubs our stale hooks then creates one signed projects_v2_item + issue_comment hook", async () => {
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
  assert.deepEqual(calls.posts[0].events, ["projects_v2_item", "issue_comment"]);
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
  const out = lines.join("\n");
  assert.match(out, /"Projects v2 item" \+ "Issue comments"/, "the org hook lists both events");
  assert.match(out, /REPO hook/, "and names the repo-hook alternative for the @agent resume");
  assert.match(out, /Payload URL:\s+https:\/\/new\.example\/github-projects\//);
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
  assert.ok(lines.some((l) => /USER-owned/.test(l) && /ORGANIZATION-level/.test(l)));
  assert.ok(!lines.some((l) => /GitHub App/.test(l)), "never suggests a GitHub App fixes a user-owned board (it doesn't)");
  const out = lines.join("\n");
  assert.match(out, /REPO hook/, "prints the per-repo issue_comment hook for the @agent resume");
  assert.match(out, /"Issue comments"/);
  assert.match(out, /Payload URL:\s+https:\/\/new\.example\/github-projects\//);
  assert.match(out, /Content type: application\/json/);
  assert.match(out, /Secret:\s+[0-9a-f]{64}/, "with the generated secret");
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

