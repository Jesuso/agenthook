import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub Projects v2 adapter — the `@agent` comment trigger (issue_comment → resume the held
// step), GitHub App auth (src/github-auth.js: installation token + human assigneeLogin), and
// the done signal (fetchTask().completed mirrors the issue's native closed flag). The adapter
// is GraphQL-only, so the fetch stubs route by inspecting the posted `query` string.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createGithubProjectsAdapter } from "../src/trackers/github-projects.js";
import { resetGithubAuthCache } from "../src/github-auth.js";
import { adapter, makeStore, stubGraphql, evt, PROJECT_ID } from "./_github-projects-helpers.js";

// --- the `@agent` comment trigger (issue_comment → resume the held step) ---

const heldPipeline = [
  { id: "triage", sourceStatus: "Triage", successStatus: "Code", failureStatus: "Blocked", holdStatus: "Held" },
  { id: "code", sourceStatus: "Code", successStatus: "In Review", failureStatus: "Blocked" }, // no holdStatus: the card stays put
];

/** Adapter over a store stub whose held record / attempt count the test controls. "Us" is
 * the GraphQL `viewer` (no assigneeLogin), so each case runs under `withProjects`'s stub.
 * @param {{pc?: object, held?: any, ran?: number}} [o] */
function commentAdapter({ pc = {}, held = { stepId: "triage", heldAt: "2026-10-18T00:00:00.000Z" }, ran = 1 } = {}) {
  const store = { ...makeStore(), getHeld: () => held, getAttempt: () => ran };
  const providerConfig = { type: "github-projects", token: "t", project: "acme/7", webhookSecret: false, ...pc };
  return createGithubProjectsAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: heldPipeline, providerConfig }), /** @type {any} */ (store));
}

/** An issue_comment delivery on issue #42 (node I_42).
 * @param {{author?: string, body?: string, id?: number, action?: string, pr?: boolean}} [o] */
function commentEvt({ author = "bot", body = "@agent use Postgres", id = 9001, action = "created", pr = false } = {}) {
  const ev = { action, issue: { number: 42, node_id: "I_42", ...(pr ? { pull_request: { url: "x" } } : {}) }, comment: { id, body, user: { login: author } } };
  return /** @type {any} */ ({ rawBody: JSON.stringify(ev), headers: { "x-github-event": "issue_comment" } });
}

/** Run `fn` with a fake GraphQL: `viewer` → `me` (or no login when null), the project probe
 * → PROJECT_ID, and the Issue projectItems lookup of I_42 → `assignee` + `cards` (default: one
 * card on our board in `status`). Returns the posted queries alongside fn's result.
 * @template T @param {{me?: string|null, assignee?: string, status?: string, cards?: any[]}} o @param {() => Promise<T>} fn */
async function withProjects({ me = "bot", assignee = "bot", status = "Held", cards }, fn) {
  /** @type {string[]} */
  const queries = [];
  const orig = global.fetch;
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  const items = cards ?? [{ id: "PVTI_42", project: { id: PROJECT_ID }, status: { name: status } }];
  // @ts-ignore - test stub
  global.fetch = async (_url, init = {}) => {
    const q = JSON.parse(String(init.body)).query;
    queries.push(q);
    /** @param {any} data */
    const ok = (data) => /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ data }) });
    if (q.includes("viewer{ login")) return ok({ viewer: me ? { login: me } : null });
    if (q.includes("organization(login")) return ok({ organization: { projectV2: { id: PROJECT_ID } }, user: null });
    if (q.includes("projectItems(first:50")) return ok({ node: { number: 42, assignees: { nodes: [{ login: assignee }] }, projectItems: { nodes: items } } });
    return ok({});
  };
  try {
    return { result: await fn(), queries };
  } finally {
    global.fetch = orig;
    console.log = log;
    console.error = error;
  }
}

test("issue_comment: an owner's @agent reply on a held card resumes the held step", async () => {
  const { result, queries } = await withProjects({}, () => commentAdapter().processEvents(commentEvt()));
  assert.deepEqual(result, [{ kind: "pipeline", ref: "42", stepId: "triage", dedupKey: "trigger:9001", comment: "@agent use Postgres" }]);
  assert.ok(queries.some((q) => q.includes("projectItems(first:50")), "board membership is read off the issue");
  assert.ok(!queries.some((q) => q.includes("items(first:100")), "the board is never scanned");
});

test("issue_comment: a leading-whitespace trigger still matches", async () => {
  const { result } = await withProjects({}, () => commentAdapter().processEvents(commentEvt({ body: "  \n@agent go" })));
  assert.equal(result.length, 1);
  assert.equal(result[0].comment, "  \n@agent go");
});

test("issue_comment: a non-owner author yields no job — including with assigneeFilter:false", async () => {
  for (const pc of [{}, { assigneeFilter: false }]) {
    const { result, queries } = await withProjects({}, () => commentAdapter({ pc }).processEvents(commentEvt({ author: "mallory" })));
    assert.deepEqual(result, [], JSON.stringify(pc));
    assert.ok(!queries.some((q) => q.includes("projectItems")), "no issue lookup for a non-owner");
  }
});

test("issue_comment: an unresolvable viewer fails closed (no job)", async () => {
  const { result } = await withProjects({ me: null }, () => commentAdapter().processEvents(commentEvt()));
  assert.deepEqual(result, []);
});

test("issue_comment: no held record, the held step at its attempt cap, or a manual held step yields no job", async () => {
  assert.deepEqual((await withProjects({}, () => commentAdapter({ held: null }).processEvents(commentEvt()))).result, []);
  assert.deepEqual((await withProjects({}, () => commentAdapter({ ran: 3 }).processEvents(commentEvt()))).result, []);
  const store = { ...makeStore(), getHeld: () => ({ stepId: "review" }), getAttempt: () => 0 };
  const manual = createGithubProjectsAdapter(
    /** @type {any} */ ({ trigger: "@agent", pipeline: [...heldPipeline, { id: "review", manual: true, sourceStatus: "Review" }], providerConfig: { type: "github-projects", token: "t", project: "acme/7", webhookSecret: false } }),
    /** @type {any} */ (store),
  );
  assert.deepEqual((await withProjects({ status: "Review" }, () => manual.processEvents(commentEvt()))).result, []);
});

test("issue_comment: a body not starting with the trigger yields no job and costs no API call", async () => {
  const { result, queries } = await withProjects({}, () => commentAdapter().processEvents(commentEvt({ body: "thanks @agent, use Postgres" })));
  assert.deepEqual(result, []);
  assert.deepEqual(queries, []);
});

test("issue_comment: an issue assigned to someone else yields no job", async () => {
  const { result } = await withProjects({ assignee: "someone-else" }, () => commentAdapter().processEvents(commentEvt()));
  assert.deepEqual(result, []);
});

test("issue_comment: an issue not on our board (no card, or only another project's card) yields no job", async () => {
  assert.deepEqual((await withProjects({ cards: [] }, () => commentAdapter().processEvents(commentEvt()))).result, []);
  const other = [{ id: "PVTI_x", project: { id: "PVT_other" }, status: { name: "Held" } }];
  assert.deepEqual((await withProjects({ cards: other }, () => commentAdapter().processEvents(commentEvt()))).result, []);
});

test("issue_comment: a card moved out of the held step's holdStatus yields no job", async () => {
  const { result } = await withProjects({ status: "Triage" }, () => commentAdapter().processEvents(commentEvt()));
  assert.deepEqual(result, []);
});

test("issue_comment: a held step with no holdStatus relies on the held record (card never moved)", async () => {
  const { result } = await withProjects({ status: "Code" }, () => commentAdapter({ held: { stepId: "code" } }).processEvents(commentEvt()));
  assert.deepEqual(result, [{ kind: "pipeline", ref: "42", stepId: "code", dedupKey: "trigger:9001", comment: "@agent use Postgres" }]);
});

test("issue_comment: a PR comment or a non-created action is ignored", async () => {
  assert.deepEqual((await withProjects({}, () => commentAdapter().processEvents(commentEvt({ pr: true })))).result, []);
  for (const action of ["edited", "deleted"]) assert.deepEqual((await withProjects({}, () => commentAdapter().processEvents(commentEvt({ action })))).result, [], action);
});

test("issue_comment: a duplicate delivery of the same comment carries the same dedupKey", async () => {
  const a = commentAdapter();
  const { result } = await withProjects({}, async () => [...(await a.processEvents(commentEvt())), ...(await a.processEvents(commentEvt()))]);
  assert.equal(result.length, 2);
  assert.equal(result[0].dedupKey, result[1].dedupKey);
  assert.equal(result[0].dedupKey, "trigger:9001");
});

// --- GitHub App auth (src/github-auth.js): installation token + human assigneeLogin ---

const APP_PEM = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const APP_PC = { token: undefined, auth: { type: "app", appId: "101", installationId: "202", privateKey: APP_PEM }, assigneeLogin: "alice" };

/** Wrap the currently stubbed global.fetch: mint "inst-tok" on the access_tokens endpoint, answer
 * `user(login:)` with U_<login>, record every other call's Authorization + GraphQL query, and pass
 * it on. Call AFTER the inner stub is installed; restore() BEFORE the inner one's restore. */
function withAppToken() {
  resetGithubAuthCache();
  /** @type {{url: string, auth: string, query?: string}[]} */
  const calls = [];
  const inner = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/app/installations/202/access_tokens")) {
      return /** @type {any} */ ({ ok: true, status: 201, json: async () => ({ token: "inst-tok", expires_at: new Date(Date.now() + 3600e3).toISOString() }) });
    }
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(url), auth: init.headers?.Authorization, query: body.query });
    if (body.query?.includes("user(login:$login){ id }")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ data: { user: { id: `U_${body.variables.login}` } } }) });
    return inner(url, init);
  };
  return { calls, restore: () => (global.fetch = inner) };
}

test("App auth: GraphQL carries Bearer <installation token>; enterStage assigns the human via user(login:), never viewer", async () => {
  const { captured, restore } = stubGraphql({ status: "In Review" });
  const app = withAppToken();
  try {
    await adapter(APP_PC).enterStage("42", "code", {});
  } finally {
    app.restore();
    restore();
  }
  assert.ok(app.calls.length > 0);
  for (const c of app.calls) assert.equal(c.auth, "Bearer inst-tok", c.query);
  assert.deepEqual(captured.assigned.u, ["U_alice"], "assigned the human's user id");
  assert.ok(!app.calls.some((c) => c.query?.includes("viewer")), "no viewer query under App auth");
});

test("App auth scoping: an item assigned to the human is acted on; a foreign or [bot] assignee is not", async () => {
  for (const [assignee, want] of /** @type {const} */ ([["alice", 1], ["mallory", 0], ["my-app[bot]", 0]])) {
    const { restore } = stubGraphql({ status: "In Progress", assignees: [assignee], viewer: "my-app[bot]" });
    const app = withAppToken();
    try {
      const jobs = await adapter({ ...APP_PC, assigneeFilter: true }).processEvents(
        /** @type {any} */ (evt({ action: "created", projects_v2_item: { node_id: "PVTI_42", content_type: "Issue" } })),
      );
      assert.equal(jobs.length, want, assignee);
      assert.ok(!app.calls.some((c) => c.query?.includes("viewer")), "identity never comes from viewer");
    } finally {
      app.restore();
      restore();
    }
  }
});

test("App auth @agent: the human's reply resumes; the App's [bot] login or another user does not", async () => {
  for (const [author, want] of /** @type {const} */ ([["alice", 1], ["my-app[bot]", 0], ["mallory", 0]])) {
    const { result, queries } = await withProjects({ me: "my-app[bot]", assignee: "alice" }, async () => {
      const app = withAppToken();
      try {
        return await commentAdapter({ pc: APP_PC }).processEvents(commentEvt({ author }));
      } finally {
        app.restore();
      }
    });
    assert.equal(result.length, want, author);
    assert.ok(!queries.some((q) => q.includes("viewer")), "identity never comes from viewer");
  }
});

test("App auth init: the board is typed as org/number (no viewer listing)", () => {
  const steps = /** @type {any} */ (adapter(APP_PC)).wizardSteps();
  const project = steps.filter((/** @type {any} */ s) => s.key === "project");
  assert.equal(project.length, 2);
  const [listed, typed] = project;
  assert.equal(listed.when({}), false, "the viewer-backed picker is skipped");
  assert.equal(typed.when({}), true);
  assert.equal(typed.validate("acme/7"), true);
  assert.notEqual(typed.validate("acme"), true);
});

// --- done signal (#585): fetchTask().completed is the issue's native closed flag ---

test("fetchTask().completed: OPEN → false, CLOSED → true", async () => {
  for (const [state, want] of [["OPEN", false], ["CLOSED", true]]) {
    const content = { __typename: "Issue", id: "I_42", number: 42, title: "t", body: "", url: "u", state, assignees: { nodes: [] } };
    const { restore } = stubGraphql({ items: [{ id: "PVTI_42", content, status: { name: "In Progress" } }] });
    try {
      assert.equal((await adapter().fetchTask("42")).completed, want, state);
    } finally {
      restore();
    }
  }
});
