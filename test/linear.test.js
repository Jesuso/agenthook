import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Linear adapter — pure-unit coverage (no network: global.fetch is stubbed with a fake GraphQL
// endpoint). The shared contract lives in the conformance suite (test/fixtures/trackers/linear.js);
// this file covers the Linear specifics: linear-signature + the 60 s webhookTimestamp window,
// viewer-based fail-closed scoping, the strict-author `@agent` resume, state-name validation,
// the webhook scrub, and the no-`Bearer` auth header.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createLinearAdapter, parseTeam } from "../src/trackers/linear.js";

const SECRET = "shh";
const US = "user-bot";
const OTHER = "user-other";
const TEAM = "team-eng";
const STATES = ["Backlog", "Todo", "In Progress", "In Review", "Blocked", "Done"];
const pipeline = [
  { id: "code", sourceStatus: "Todo", successStatus: "In Review", failureStatus: "Blocked", holdStatus: "Blocked" },
  { id: "review", manual: true, sourceStatus: "In Review" },
];

/** Minimal Store stub; `held` seeds getHeld. @param {Record<string, any>} [held] */
function makeStore(held = {}) {
  const m = new Map();
  return {
    getSecret: (/** @type {string} */ k) => m.get(k),
    setSecret: (/** @type {string} */ k, /** @type {string} */ v) => m.set(k, v),
    getHeld: (/** @type {string} */ ref) => held[ref],
    getAttempt: () => 0,
  };
}

/**
 * Stub global.fetch with a fake Linear GraphQL API. `opts.issues` maps identifier → assignee id
 * (null = unassigned); `opts.viewerFails` makes the viewer lookup error; `opts.hooks` is the
 * workspace webhook list. Returns the recorded calls; restore with the returned `restore`.
 * @param {{issues?: Record<string, string|null>, viewerFails?: boolean, hooks?: any[], createFails?: boolean}} [opts]
 */
function stubFetch(opts = {}) {
  const issues = opts.issues ?? { "ENG-1": US };
  /** @type {Array<{url: string, headers: any, query: string, variables: any}>} */
  const calls = [];
  const orig = globalThis.fetch;
  const reply = (/** @type {any} */ body) => ({ ok: true, status: 200, json: async () => body });
  // @ts-ignore - test stub
  globalThis.fetch = async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ url: String(url), headers: init.headers, query, variables });
    if (query.includes("viewer{ id }")) return opts.viewerFails ? reply({ errors: [{ message: "authentication failed" }] }) : reply({ data: { viewer: { id: US } } });
    if (query.includes("teams(filter")) {
      const nodes = STATES.map((name, position) => ({ id: `st-${name}`, name, type: name === "Done" ? "completed" : "started", position }));
      return reply({ data: { teams: { nodes: [{ id: TEAM, key: "ENG", name: "Engineering", states: { nodes } }] } } });
    }
    if (query.includes("webhooks(first")) return reply({ data: { webhooks: { nodes: opts.hooks ?? [] } } });
    if (query.includes("webhookDelete")) return reply({ data: { webhookDelete: { success: true } } });
    if (query.includes("webhookCreate")) return opts.createFails ? reply({ errors: [{ message: "Forbidden: admin required" }] }) : reply({ data: { webhookCreate: { success: true, webhook: { id: "wh-new", enabled: true } } } });
    if (query.includes("issueUpdate")) return reply({ data: { issueUpdate: { success: true } } });
    if (query.includes("issue(id:")) {
      const key = String(variables.id).replace(/^uuid-/, "");
      if (!(key in issues)) return reply({ data: { issue: null } });
      const a = issues[key];
      return reply({ data: { issue: { id: `uuid-${key}`, identifier: key, title: key, url: `https://linear.app/acme/issue/${key}`, assignee: a ? { id: a } : null, state: { id: "st-Todo", name: "Todo", type: "started" } } } });
    }
    return reply({ data: {} });
  };
  return { calls, restore: () => void (globalThis.fetch = orig) };
}

/** @param {Record<string, any>} [pc] @param {Record<string, any>} [held] */
function adapter(pc = {}, held = {}) {
  const providerConfig = { type: "linear", token: "lin_api_KEY", team: "ENG", webhookSecret: SECRET, ...pc };
  return createLinearAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline, providerConfig }), /** @type {any} */ (makeStore(held)));
}

/** A signed EventCtx for `ev` (webhookTimestamp defaults to now). @param {any} ev */
function signed(ev) {
  const raw = JSON.stringify({ webhookTimestamp: Date.now(), ...ev });
  return { pathname: "/linear/", headers: { "linear-signature": crypto.createHmac("sha256", SECRET).update(raw).digest("hex") }, rawBody: raw };
}

/** An Issue state change of `key` into Todo (the code step's source). @param {string} key @param {string|null} assigneeId */
const moved = (key, assigneeId, updatedAt = "2026-10-18T12:00:00.000Z") =>
  signed({ action: "update", type: "Issue", data: { id: `uuid-${key}`, identifier: key, teamId: TEAM, stateId: "st-Todo", assigneeId, updatedAt }, updatedFrom: { stateId: "st-Backlog" } });

/** An `@agent` comment on ENG-1 by `userId`. @param {string} userId */
const comment = (userId) => signed({ action: "create", type: "Comment", data: { id: "c-1", body: "@agent go with option B", userId, issueId: "uuid-ENG-1" } });

// --- authenticate ---

test("authenticate accepts a valid linear-signature", () => {
  assert.deepEqual(adapter().authenticate(moved("ENG-1", US)), { type: "accept" });
});

test("authenticate rejects a tampered body", () => {
  const ctx = moved("ENG-1", US);
  assert.equal(adapter().authenticate({ ...ctx, rawBody: ctx.rawBody.replace("ENG-1", "ENG-2") }).type, "reject");
});

test("authenticate rejects a validly signed delivery whose webhookTimestamp is over 60 s off", () => {
  const a = adapter();
  assert.equal(a.authenticate(signed({ type: "Issue", webhookTimestamp: Date.now() - 61_000 })).type, "reject");
  assert.equal(a.authenticate(signed({ type: "Issue", webhookTimestamp: Date.now() + 61_000 })).type, "reject");
  assert.equal(a.authenticate(signed({ type: "Issue", webhookTimestamp: undefined })).type, "reject", "a missing timestamp is rejected");
  assert.equal(a.authenticate(signed({ type: "Issue", webhookTimestamp: Date.now() - 30_000 })).type, "accept");
});

test("authenticate with webhookSecret:false accepts unsigned", () => {
  assert.equal(adapter({ webhookSecret: false }).authenticate({ pathname: "/linear/", headers: {}, rawBody: "{}" }).type, "accept");
});

// --- processEvents: state changes ---

test("a state change into a source state for OUR issue yields a pipeline job; a re-entry gets a new key", async () => {
  const s = stubFetch();
  try {
    const a = adapter();
    const [job] = await a.processEvents(moved("ENG-1", US));
    assert.deepEqual(job, { kind: "pipeline", ref: "ENG-1", stepId: "code", dedupKey: "secmove:uuid-ENG-1:2026-10-18T12:00:00.000Z" });
    const [again] = await a.processEvents(moved("ENG-1", US, "2026-10-18T13:00:00.000Z"));
    assert.notEqual(again.dedupKey, job.dedupKey, "a later move into the same state (rework loop) must re-fire");
  } finally {
    s.restore();
  }
});

test("a state change for an issue assigned to someone else, or unassigned, yields no job", async () => {
  const s = stubFetch();
  try {
    assert.deepEqual(await adapter().processEvents(moved("ENG-1", OTHER)), []);
    assert.deepEqual(await adapter().processEvents(moved("ENG-1", null)), []);
  } finally {
    s.restore();
  }
});

test("a viewer lookup failure yields no job (fail closed)", async () => {
  const s = stubFetch({ viewerFails: true });
  try {
    assert.deepEqual(await adapter().processEvents(moved("ENG-1", US)), []);
  } finally {
    s.restore();
  }
});

test("an update that didn't change state yields no job", async () => {
  const s = stubFetch();
  try {
    const ctx = signed({ action: "update", type: "Issue", data: { id: "uuid-ENG-1", identifier: "ENG-1", teamId: TEAM, stateId: "st-Todo", assigneeId: US }, updatedFrom: { title: "old" } });
    assert.deepEqual(await adapter().processEvents(ctx), []);
  } finally {
    s.restore();
  }
});

// --- processEvents: the @agent resume ---

test("an @agent comment by a user other than the viewer never resumes — even the assignee, even with assigneeFilter:false", async () => {
  const held = { "ENG-1": { stepId: "code" } };
  const s = stubFetch({ issues: { "ENG-1": OTHER } }); // OTHER is the assignee
  try {
    assert.deepEqual(await adapter({}, held).processEvents(comment(OTHER)), []);
    assert.deepEqual(await adapter({ assigneeFilter: false }, held).processEvents(comment(OTHER)), []);
  } finally {
    s.restore();
  }
});

test("the same @agent comment by the viewer on a held issue yields the resume job", async () => {
  const s = stubFetch();
  try {
    const jobs = await adapter({}, { "ENG-1": { stepId: "code" } }).processEvents(comment(US));
    assert.deepEqual(jobs, [{ kind: "pipeline", ref: "ENG-1", stepId: "code", dedupKey: "trigger:c-1", comment: "@agent go with option B" }]);
  } finally {
    s.restore();
  }
});

test("an @agent comment by the viewer on an issue that isn't ours, or isn't held, yields nothing", async () => {
  const s = stubFetch({ issues: { "ENG-1": OTHER } });
  try {
    assert.deepEqual(await adapter({}, { "ENG-1": { stepId: "code" } }).processEvents(comment(US)), []);
  } finally {
    s.restore();
  }
  const s2 = stubFetch();
  try {
    assert.deepEqual(await adapter().processEvents(comment(US)), []);
  } finally {
    s2.restore();
  }
});

// --- config / team resolution ---

test("an unknown state name throws an error naming the step, key, value and the team's states", async () => {
  const s = stubFetch();
  try {
    const providerConfig = { type: "linear", token: "k", team: "ENG", webhookSecret: SECRET };
    const bad = [{ id: "code", sourceStatus: "Todoo", successStatus: "In Review", failureStatus: "Blocked" }];
    const a = createLinearAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: bad, providerConfig }), /** @type {any} */ (makeStore()));
    await assert.rejects(a.listResting(), (e) => {
      assert.match(e.message, /step "code" sourceStatus "Todoo" is not a state of team ENG/);
      assert.match(e.message, /available: Backlog, Todo, In Progress, In Review, Blocked, Done/);
      return true;
    });
  } finally {
    s.restore();
  }
});

test("state names resolve case-insensitively", async () => {
  const s = stubFetch();
  try {
    const providerConfig = { type: "linear", token: "k", team: "ENG", webhookSecret: SECRET };
    const p = [{ id: "code", sourceStatus: "todo", successStatus: "in review", failureStatus: "BLOCKED" }];
    const a = createLinearAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: p, providerConfig }), /** @type {any} */ (makeStore()));
    await a.advance("ENG-1", "code", { outcome: "advance" });
    const upd = s.calls.find((c) => c.query.includes("issueUpdate"));
    assert.deepEqual(upd?.variables, { id: "ENG-1", input: { stateId: "st-In Review" } });
  } finally {
    s.restore();
  }
});

test("enterStage without assigning refuses an issue that isn't ours, and assigning makes it ours", async () => {
  const s = stubFetch({ issues: { "ENG-2": OTHER } });
  try {
    const a = adapter();
    await assert.rejects(a.enterStage?.("ENG-2", "code", { assign: false }) ?? Promise.resolve(), { name: "MoveRefusedError" });
    assert.ok(!s.calls.some((c) => c.query.includes("issueUpdate")), "a refused enterStage must not move the issue");
    assert.deepEqual(await a.enterStage?.("ENG-2", "code"), { stage: "Todo" });
    const updates = s.calls.filter((c) => c.query.includes("issueUpdate")).map((c) => c.variables.input);
    assert.deepEqual(updates, [{ assigneeId: US }, { stateId: "st-Todo" }]);
  } finally {
    s.restore();
  }
});

test("parseTeam takes a key or a team URL", () => {
  assert.equal(parseTeam("ENG"), "ENG");
  assert.equal(parseTeam("https://linear.app/acme/team/ENG/active"), "ENG");
  assert.equal(parseTeam(undefined), "");
});

// --- webhooks ---

test("unregisterWebhooks deletes only our team's hooks whose url points at /linear", async () => {
  const hooks = [
    { id: "h-ours", url: "https://old.ngrok.app/linear/", team: { id: TEAM } },
    { id: "h-other-url", url: "https://ci.example.com/hook", team: { id: TEAM } },
    { id: "h-other-team", url: "https://old.ngrok.app/linear/", team: { id: "team-ops" } },
  ];
  const s = stubFetch({ hooks });
  try {
    await adapter().unregisterWebhooks();
    const deleted = s.calls.filter((c) => c.query.includes("webhookDelete")).map((c) => c.variables.id);
    assert.deepEqual(deleted, ["h-ours"]);
  } finally {
    s.restore();
  }
});

test("registerWebhook creates a team hook for Issue + Comment signed with the generated secret", async () => {
  const s = stubFetch();
  try {
    const store = makeStore();
    const a = createLinearAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline, providerConfig: { type: "linear", token: "k", team: "ENG" } }), /** @type {any} */ (store));
    await a.registerWebhook("https://hook.example.com");
    const create = s.calls.find((c) => c.query.includes("webhookCreate"));
    assert.deepEqual(create?.variables.input, {
      url: "https://hook.example.com/linear/",
      teamId: TEAM,
      resourceTypes: ["Issue", "Comment"],
      label: "agenthook",
      secret: store.getSecret("linear:webhookSecret"),
    });
    assert.match(String(store.getSecret("linear:webhookSecret")), /^[0-9a-f]{64}$/);
  } finally {
    s.restore();
  }
});

test("registerWebhook prints manual setup (never throws) when the key can't create webhooks", async () => {
  const s = stubFetch({ createFails: true });
  const logged = [];
  const origLog = console.log;
  console.log = (/** @type {any[]} */ ...a) => void logged.push(a.join(" "));
  try {
    await adapter().registerWebhook("https://hook.example.com");
  } finally {
    console.log = origLog;
    s.restore();
  }
  const out = logged.join("\n");
  assert.match(out, /needs a Linear ADMIN/);
  assert.match(out, /https:\/\/hook\.example\.com\/linear\//);
  assert.match(out, new RegExp(`Secret: +${SECRET}`));
});

// --- auth header ---

test("the API key is sent as `Authorization: <key>` with no Bearer prefix", async () => {
  const s = stubFetch();
  try {
    await adapter().fetchTask("ENG-1");
    assert.ok(s.calls.length > 0);
    for (const c of s.calls) {
      assert.equal(c.url, "https://api.linear.app/graphql");
      assert.equal(c.headers.Authorization, "lin_api_KEY");
    }
  } finally {
    s.restore();
  }
});

// --- agenthook init: pipelineBindings ---

test("pipelineBindings maps the wizard state picks to status bindings", () => {
  const a = adapter();
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "Todo", _successStage: "In Review", _failureStage: "Blocked" }), {
    sourceStatus: "Todo",
    successStatus: "In Review",
    failureStatus: "Blocked",
  });
});

test("pipelineBindings returns null when no stage was picked (init keeps the TODO_* skeleton)", () => {
  assert.equal(adapter().pipelineBindings?.({}), null);
});

test("pipelineBindings adds holdStatus only when _holdStage was picked", () => {
  const a = adapter();
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "Todo", _successStage: "In Review", _failureStage: "Blocked", _holdStage: "Blocked" }), {
    sourceStatus: "Todo",
    successStatus: "In Review",
    failureStatus: "Blocked",
    holdStatus: "Blocked",
  });
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "Todo", _successStage: "In Review", _failureStage: "Blocked", _holdStage: "" }), {
    sourceStatus: "Todo",
    successStatus: "In Review",
    failureStatus: "Blocked",
  });
});
