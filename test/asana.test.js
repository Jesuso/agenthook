// Asana adapter — pure-unit coverage (no network): the adapter contract (X-Hook-Signature
// verify, task-added + section_changed routing, advance → addTask — mirrors
// test/github.test.js) plus the `agenthook init` discovery (live section listing and the
// stage-pick → binding mapping).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createAsanaAdapter, extractRouteKeys } from "../src/trackers/asana.js";

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
  const providerConfig = { type: "asana", token: "t" };
  return createAsanaAdapter(/** @type {any} */ ({ trigger: "@agent", providerConfig }), /** @type {any} */ (makeStore()));
}

// --- adapter contract (mirrors test/github.test.js): handshake/signature verify, the
// task-added + section_changed routing, and the advance → addTask mutation. The default
// pipeline binds one `code` step; assigneeFilter:false keeps routing offline (no assignee
// gate), exactly as github.test.js sidesteps the /user lookup.
const pipeline = [{ id: "code", sourceSectionGid: "S1", successSectionGid: "S2", failureSectionGid: "S3" }];

/** Build a pipeline-bound adapter. Defaults to assigneeFilter:false so routing needs no assignee gate. */
function routed(pc = {}) {
  const providerConfig = { type: "asana", token: "t", assigneeFilter: false, ...pc };
  return createAsanaAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline, providerConfig }), /** @type {any} */ (makeStore()));
}

/** A stubbed 200 JSON response. @param {any} data */
const ok = (data) => /** @type {any} */ ({ ok: true, status: 200, json: async () => data });

test("authenticate stores the handshake secret and echoes it back", () => {
  const res = routed().authenticate(/** @type {any} */ ({ pathname: "/mytasks/", headers: { "x-hook-secret": "shh" }, rawBody: "" }));
  assert.equal(res.type, "handshake");
  assert.deepEqual(res.headers, { "X-Hook-Secret": "shh" });
});

test("authenticate accepts a correctly signed body", () => {
  const a = routed();
  a.authenticate(/** @type {any} */ ({ pathname: "/mytasks/", headers: { "x-hook-secret": "shh" }, rawBody: "" })); // handshake stores the secret
  const body = JSON.stringify({ events: [] });
  const sig = crypto.createHmac("sha256", "shh").update(body).digest("hex");
  assert.equal(a.authenticate(/** @type {any} */ ({ pathname: "/mytasks/", headers: { "x-hook-signature": sig }, rawBody: body })).type, "accept");
});

test("authenticate rejects a bad signature", () => {
  const a = routed();
  a.authenticate(/** @type {any} */ ({ pathname: "/mytasks/", headers: { "x-hook-secret": "shh" }, rawBody: "" }));
  assert.equal(a.authenticate(/** @type {any} */ ({ pathname: "/mytasks/", headers: { "x-hook-signature": "deadbeef" }, rawBody: "{}" })).type, "reject");
});

test("a task added in a step's source section routes to that step", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => (String(url).includes("/tasks/G1?") ? ok({ data: { memberships: [{ section: { gid: "S1" } }] } }) : ok({}));
  let jobs;
  try {
    jobs = await routed().processEvents(/** @type {any} */ ({ rawBody: JSON.stringify({ events: [{ action: "added", resource: { resource_type: "task", gid: "G1" } }] }) }));
  } finally {
    global.fetch = orig;
  }
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].ref, "G1");
  assert.equal(jobs[0].stepId, "code");
  assert.equal(jobs[0].dedupKey, "step:code:G1");
});

test("a task added in a non-source section yields no job", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => (String(url).includes("/tasks/G1?") ? ok({ data: { memberships: [{ section: { gid: "ZZ" } }] } }) : ok({}));
  let jobs;
  try {
    jobs = await routed().processEvents(/** @type {any} */ ({ rawBody: JSON.stringify({ events: [{ action: "added", resource: { resource_type: "task", gid: "G1" } }] }) }));
  } finally {
    global.fetch = orig;
  }
  assert.equal(jobs.length, 0);
});

test("a section_changed story routes to the step the task now rests in (secmove dedup key)", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/stories/ST1")) return ok({ data: { resource_subtype: "section_changed", target: { gid: "G1" } } });
    if (u.includes("/tasks/G1?")) return ok({ data: { memberships: [{ section: { gid: "S1" } }] } });
    return ok({});
  };
  let jobs;
  try {
    jobs = await routed().processEvents(/** @type {any} */ ({ rawBody: JSON.stringify({ events: [{ action: "added", resource: { resource_type: "story", gid: "ST1" } }] }) }));
  } finally {
    global.fetch = orig;
  }
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].ref, "G1");
  assert.equal(jobs[0].stepId, "code");
  assert.equal(jobs[0].dedupKey, "secmove:ST1");
});

test("a story that isn't a section_changed yields no job", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => (String(url).includes("/stories/ST1") ? ok({ data: { resource_subtype: "comment_added" } }) : ok({}));
  let jobs;
  try {
    jobs = await routed().processEvents(/** @type {any} */ ({ rawBody: JSON.stringify({ events: [{ action: "added", resource: { resource_type: "story", gid: "ST1" } }] }) }));
  } finally {
    global.fetch = orig;
  }
  assert.equal(jobs.length, 0);
});

test("advance moves the task into the step's success section (addTask)", async () => {
  /** @type {string[]} */
  const calls = [];
  let body;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    if (init.body) body = JSON.parse(String(init.body));
    return ok({ data: {} });
  };
  try {
    await routed().advance("G1", "code", /** @type {any} */ ({ outcome: "advance" }));
  } finally {
    global.fetch = orig;
  }
  assert.ok(
    calls.some((c) => c === "POST https://app.asana.com/api/1.0/sections/S2/addTask"),
    `expected an addTask to the success section; got:\n${calls.join("\n")}`,
  );
  assert.deepEqual(body, { data: { task: "G1" } });
});

test("currentStage returns ANY pipeline section the task rests in (not just source) — backs run's guard", async () => {
  const orig = global.fetch;
  // The task rests in the SUCCESS section (S2), not the source — still in-flight.
  // @ts-ignore - test stub
  global.fetch = async () => ok({ data: { memberships: [{ section: { gid: "S2" } }] } });
  try {
    assert.equal(await routed().currentStage?.("G1"), "S2");
  } finally {
    global.fetch = orig;
  }
});

test("currentStage is null when the task rests in no pipeline section", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => ok({ data: { memberships: [{ section: { gid: "ZZ" } }] } });
  try {
    assert.equal(await routed().currentStage?.("G1"), null);
  } finally {
    global.fetch = orig;
  }
});

test("pipelineBindings maps the wizard stage picks to section-gid bindings", () => {
  const a = adapter();
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "111", _successStage: "222", _failureStage: "333" }), {
    sourceSectionGid: "111",
    successSectionGid: "222",
    failureSectionGid: "333",
  });
});

test("pipelineBindings returns null when no stage was picked (init keeps the placeholder)", () => {
  assert.equal(adapter().pipelineBindings?.({}), null);
});

test("init section discovery lists the chosen project's sections (name + gid)", async () => {
  const orig = global.fetch;
  /** @type {string[]} */
  const urls = [];
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    urls.push(String(url));
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ data: [{ gid: "10", name: "Backlog" }, { gid: "20", name: "In review" }] }) });
  };
  try {
    const steps = adapter().wizardSteps?.({}) || [];
    const source = steps.find((s) => s.key === "_sourceStage");
    assert.ok(source && typeof source.choices === "function", "expected a _sourceStage select with live choices");
    const choices = await /** @type {any} */ (source.choices)({ projectGid: "777" });
    assert.deepEqual(choices, [
      { title: "Backlog (10)", value: "10" },
      { title: "In review (20)", value: "20" },
    ]);
    assert.ok(urls.some((u) => u.includes("/projects/777/sections")), `expected a sections fetch for the chosen project; got:\n${urls.join("\n")}`);
  } finally {
    global.fetch = orig;
  }
});

// --- native task dependencies (the block gate; mirrors github.test.js): a task with an
// incomplete "blocked by" dependency rests in its source section; a blocker completing
// releases each eligible dependent; completeTask on a terminal step completes the task.

/** Build an adapter over a custom pipeline. @param {any[]} pl @param {Record<string, any>} [pc] */
function withPipeline(pl, pc = {}) {
  const providerConfig = { type: "asana", token: "t", assigneeFilter: false, ...pc };
  return createAsanaAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: pl, providerConfig }), /** @type {any} */ (makeStore()));
}

/** Run `fn` with global.fetch stubbed by `stub`, restoring it after. @param {(url: string, init: any) => any} stub @param {() => Promise<any>} fn */
async function withFetch(stub, fn) {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => stub(String(url), init);
  try {
    return await fn();
  } finally {
    global.fetch = orig;
  }
}

// --- the `@agent` comment trigger (story comment_added → resume the held step) ---

/** Adapter over a store stub whose held record / attempt count / seen set the test controls.
 * @param {{pc?: object, held?: any, ran?: number, seen?: string[]}} [o] */
function commentRouted({ pc = {}, held = { stepId: "code", heldAt: "2026-09-24T00:00:00.000Z" }, ran = 1, seen = [] } = {}) {
  const store = { ...makeStore(), getHeld: () => held, getAttempt: () => ran, hasSeen: (/** @type {string} */ k) => seen.includes(k) };
  const providerConfig = { type: "asana", token: "t", assigneeFilter: false, userGid: "U1", ...pc };
  return createAsanaAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline, providerConfig }), /** @type {any} */ (store));
}

/** Run a comment_added story ST1 on task G1 through processEvents with stubbed fetches.
 * @param {any} a @param {{text?: string, author?: string|null, assignee?: string}} [o] */
async function runComment(a, { text = "@agent use Postgres", author = "U1", assignee = "U1" } = {}) {
  /** @type {string[]} */
  const urls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/stories/ST1")) return ok({ data: { resource_subtype: "comment_added", text, created_by: author ? { gid: author } : null, target: { gid: "G1" } } });
    if (u.includes("/tasks/G1")) return ok({ data: { assignee: { gid: assignee } } });
    return ok({});
  };
  try {
    const jobs = await a.processEvents(/** @type {any} */ ({ rawBody: JSON.stringify({ events: [{ action: "added", resource: { resource_type: "story", gid: "ST1" }, parent: { gid: "G1" } }] }) }));
    return { jobs, urls };
  } finally {
    global.fetch = orig;
  }
}

const addedEvent = (gid) => JSON.stringify({ events: [{ action: "added", resource: { resource_type: "task", gid } }] });

test("a task added to a source section with an incomplete dependency rests (no job)", async () => {
  const jobs = await withFetch(
    (u) => {
      if (u.includes("/tasks/G1/dependencies")) return ok({ data: [{ gid: "B1", completed: false }] });
      if (u.includes("/tasks/G1?")) return ok({ data: { memberships: [{ section: { gid: "S1" } }] } });
      return ok({});
    },
    () => routed().processEvents(/** @type {any} */ ({ rawBody: addedEvent("G1") })),
  );
  assert.equal(jobs.length, 0);
});

test("a task whose dependencies are all completed routes as before", async () => {
  const jobs = await withFetch(
    (u) => {
      if (u.includes("/tasks/G1/dependencies")) return ok({ data: [{ gid: "B1", completed: true }] });
      if (u.includes("/tasks/G1?")) return ok({ data: { memberships: [{ section: { gid: "S1" } }] } });
      return ok({});
    },
    () => routed().processEvents(/** @type {any} */ ({ rawBody: addedEvent("G1") })),
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].dedupKey, "step:code:G1");
});

test("a task moved into a source section with an incomplete dependency rests (no job)", async () => {
  const jobs = await withFetch(
    (u) => {
      if (u.includes("/stories/ST1")) return ok({ data: { resource_subtype: "section_changed", target: { gid: "G1" } } });
      if (u.includes("/tasks/G1/dependencies")) return ok({ data: [{ gid: "B1", completed: false }] });
      if (u.includes("/tasks/G1?")) return ok({ data: { memberships: [{ section: { gid: "S1" } }] } });
      return ok({});
    },
    () => routed().processEvents(/** @type {any} */ ({ rawBody: JSON.stringify({ events: [{ action: "added", resource: { resource_type: "story", gid: "ST1" } }] }) })),
  );
  assert.equal(jobs.length, 0);
});

test("a dependencies API error warns and the task fires (fail-open)", async () => {
  /** @type {string[]} */
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => void warnings.push(a.join(" "));
  let jobs;
  try {
    jobs = await withFetch(
      (u) => {
        if (u.includes("/tasks/G1/dependencies")) return /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) });
        if (u.includes("/tasks/G1?")) return ok({ data: { memberships: [{ section: { gid: "S1" } }] } });
        return ok({});
      },
      () => routed().processEvents(/** @type {any} */ ({ rawBody: addedEvent("G1") })),
    );
  } finally {
    console.warn = origWarn;
  }
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].stepId, "code");
  assert.ok(warnings.some((w) => w.includes("dependencies for G1")), `expected a fail-open warning; got:\n${warnings.join("\n")}`);
});

// Release fixture: blocker B1 completes; its dependents cover every eligibility branch.
// Only D1 (ours, open, resting in a non-manual source section, no other open blocker) fires.
const releasePipeline = [
  { id: "code", sourceSectionGid: "S1", successSectionGid: "S2", failureSectionGid: "S3" },
  { id: "done", sourceSectionGid: "S2", manual: true },
];
const releaseDependents = [
  { gid: "D1", completed: false, assignee: { gid: "U" }, memberships: [{ section: { gid: "S1" } }] }, // eligible
  { gid: "D2", completed: false, assignee: { gid: "OTHER" }, memberships: [{ section: { gid: "S1" } }] }, // not ours
  { gid: "D3", completed: true, assignee: { gid: "U" }, memberships: [{ section: { gid: "S1" } }] }, // completed
  { gid: "D4", completed: false, assignee: { gid: "U" }, memberships: [{ section: { gid: "S2" } }] }, // manual step's source
  { gid: "D5", completed: false, assignee: { gid: "U" }, memberships: [{ section: { gid: "ZZ" } }] }, // not a source section
  { gid: "D6", completed: false, assignee: { gid: "U" }, memberships: [{ section: { gid: "S1" } }] }, // another open blocker
];
/** @param {boolean} blockerCompleted @param {string[]} urls */
const releaseStub = (blockerCompleted, urls) => (/** @type {string} */ u) => {
  urls.push(u);
  if (u.includes("/tasks/B1/dependents")) return ok({ data: releaseDependents });
  if (u.includes("/tasks/B1?")) return ok({ data: { completed: blockerCompleted } });
  if (u.includes("/tasks/D6/dependencies")) return ok({ data: [{ gid: "B1", completed: true }, { gid: "B2", completed: false }] });
  if (u.includes("/dependencies")) return ok({ data: [{ gid: "B1", completed: true }] });
  return ok({});
};
const changedEvent = JSON.stringify({ events: [{ action: "changed", resource: { resource_type: "task", gid: "B1" }, change: { field: "completed", action: "changed" } }] });

test("a completed blocker releases exactly its eligible dependents (unblock dedup key)", async () => {
  /** @type {string[]} */
  const urls = [];
  const jobs = await withFetch(releaseStub(true, urls), () =>
    withPipeline(releasePipeline, { assigneeFilter: true, userGid: "U" }).processEvents(/** @type {any} */ ({ rawBody: changedEvent })),
  );
  assert.deepEqual(jobs, [{ kind: "pipeline", ref: "D1", stepId: "code", dedupKey: "unblock:B1:D1" }]);
});

test("a task changed event for a task that is NOT completed releases nothing", async () => {
  /** @type {string[]} */
  const urls = [];
  const jobs = await withFetch(releaseStub(false, urls), () =>
    withPipeline(releasePipeline, { assigneeFilter: true, userGid: "U" }).processEvents(/** @type {any} */ ({ rawBody: changedEvent })),
  );
  assert.equal(jobs.length, 0);
  assert.ok(!urls.some((u) => u.includes("/dependents")), "an incomplete task must not look up its dependents");
});

test("registerWebhook posts four filters, including task changed on `completed`", async () => {
  let body;
  await withFetch(
    (u, init) => {
      if (init.method === "POST" && u.endsWith("/webhooks")) {
        body = JSON.parse(String(init.body));
        return ok({ data: { gid: "W1", active: true } });
      }
      return ok({ data: [] });
    },
    () => routed({ projectGid: "P1", workspaceGid: "WS" }).registerWebhook("https://x.example"),
  );
  assert.deepEqual(body?.data.filters, [
    { resource_type: "task", action: "added" },
    { resource_type: "story", action: "added", resource_subtype: "section_changed" },
    { resource_type: "task", action: "changed", fields: ["completed"] },
    { resource_type: "story", action: "added", resource_subtype: "comment_added" },
  ]);
});

test("listResting omits blocked tasks", async () => {
  const jobs = await withFetch(
    (u) => {
      if (u.includes("/sections/S1/tasks")) return ok({ data: [{ gid: "T1", completed: false }, { gid: "T2", completed: false }] });
      if (u.includes("/tasks/T2/dependencies")) return ok({ data: [{ gid: "B1", completed: false }] });
      if (u.includes("/dependencies")) return ok({ data: [] });
      return ok({});
    },
    () => routed().listResting(),
  );
  assert.deepEqual(
    jobs.map((j) => j.ref),
    ["T1"],
  );
});

/** Record every fetch as `METHOD url body`. @param {string[]} calls @param {string} [assignee] */
const recordStub = (calls, assignee = "U") => (/** @type {string} */ u, /** @type {any} */ init) => {
  calls.push(`${init.method || "GET"} ${u} ${init.body || ""}`);
  return ok({ data: { assignee: { gid: assignee } } });
};

test("advance into a step flagged completeTask marks the task completed", async () => {
  /** @type {string[]} */
  const calls = [];
  const pl = [
    { id: "code", sourceSectionGid: "S1", successSectionGid: "S2" },
    { id: "done", sourceSectionGid: "S2", manual: true, completeTask: true },
  ];
  await withFetch(recordStub(calls), () => withPipeline(pl, { assigneeFilter: true, userGid: "U" }).advance("G1", "code", /** @type {any} */ ({ outcome: "advance" })));
  assert.ok(calls.some((c) => c.startsWith("POST https://app.asana.com/api/1.0/sections/S2/addTask")), calls.join("\n"));
  assert.ok(
    calls.some((c) => c === `PUT https://app.asana.com/api/1.0/tasks/G1 ${JSON.stringify({ data: { completed: true } })}`),
    `expected a completing PUT; got:\n${calls.join("\n")}`,
  );
});

test("advance without the completeTask flag never completes the task", async () => {
  /** @type {string[]} */
  const calls = [];
  const pl = [
    { id: "code", sourceSectionGid: "S1", successSectionGid: "S2" },
    { id: "done", sourceSectionGid: "S2", manual: true },
  ];
  await withFetch(recordStub(calls), () => withPipeline(pl, { assigneeFilter: true, userGid: "U" }).advance("G1", "code", /** @type {any} */ ({ outcome: "advance" })));
  assert.ok(calls.some((c) => c.startsWith("POST https://app.asana.com/api/1.0/sections/S2/addTask")));
  assert.ok(!calls.some((c) => c.startsWith("PUT")), `expected no PUT; got:\n${calls.join("\n")}`);
});

test("a task that isn't ours is never completed (nor moved)", async () => {
  /** @type {string[]} */
  const calls = [];
  const pl = [
    { id: "code", sourceSectionGid: "S1", successSectionGid: "S2" },
    { id: "done", sourceSectionGid: "S2", manual: true, completeTask: true },
  ];
  await withFetch(recordStub(calls, "OTHER"), () => withPipeline(pl, { assigneeFilter: true, userGid: "U" }).advance("G1", "code", /** @type {any} */ ({ outcome: "advance" })));
  assert.ok(!calls.some((c) => c.startsWith("PUT") || c.startsWith("POST")), `expected no mutation; got:\n${calls.join("\n")}`);
});

// --- fetchTask displayId: the human id comes from a custom field (default name "ID").
/** Run fetchTask("G9") against a stubbed task carrying `custom_fields`. @param {any[]} custom_fields @param {object} [pc] */
async function fetchWith(custom_fields, pc = {}) {
  const orig = global.fetch;
  /** @type {string[]} */
  const urls = [];
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    urls.push(String(url));
    return ok({ data: { name: "Fix it", notes: "", permalink_url: "https://app.asana.com/t/G9", completed: false, custom_fields } });
  };
  try {
    return { task: await routed(pc).fetchTask("G9"), urls };
  } finally {
    global.fetch = orig;
  }
}

test("comment_added: the owner's @agent reply on a held task resumes the held step", async () => {
  const { jobs, urls } = await runComment(commentRouted());
  assert.deepEqual(jobs, [{ kind: "pipeline", ref: "G1", stepId: "code", dedupKey: "trigger:ST1", comment: "@agent use Postgres" }]);
  assert.ok(urls.some((u) => u.includes("/stories/ST1") && u.includes("created_by.gid")), "fetchStory must request the author");
});

test("comment_added: resumes under assignee scoping when the task is ours", async () => {
  assert.equal((await runComment(commentRouted({ pc: { assigneeFilter: true } }))).jobs.length, 1);
});

test("comment_added: assigneeFilter:false still rejects a foreign author", async () => {
  assert.deepEqual((await runComment(commentRouted(), { author: "U2" })).jobs, []);
});

test("comment_added: an unset userGid rejects every author (fail-closed)", async () => {
  assert.deepEqual((await runComment(commentRouted({ pc: { userGid: undefined } }))).jobs, []);
});

test("comment_added: a text not starting with the trigger yields no job", async () => {
  assert.deepEqual((await runComment(commentRouted(), { text: "thanks, @agent" })).jobs, []);
});

test("comment_added: a task not assigned to us yields no job (assignee gate)", async () => {
  assert.deepEqual((await runComment(commentRouted({ pc: { assigneeFilter: true } }), { assignee: "U9" })).jobs, []);
});

test("comment_added: no held record yields no job", async () => {
  assert.deepEqual((await runComment(commentRouted({ held: null }))).jobs, []);
});

test("comment_added: the held step at its attempt cap yields no job", async () => {
  assert.deepEqual((await runComment(commentRouted({ ran: 3 }))).jobs, []);
});

test("comment_added: an already-seen trigger:<storyGid> is skipped before any fetch", async () => {
  const { jobs, urls } = await runComment(commentRouted({ seen: ["trigger:ST1"] }));
  assert.deepEqual(jobs, []);
  assert.deepEqual(urls, []);
});

test("registerWebhook's filters include story comment_added (and keep section_changed)", async () => {
  /** @type {any} */
  let posted;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/webhooks") && init.method === "POST") posted = JSON.parse(String(init.body));
    return ok({ data: String(url).includes("/webhooks?") ? [] : { gid: "W1", active: true } });
  };
  try {
    await routed({ projectGid: "P1", workspaceGid: "WS" }).registerWebhook("https://example.test");
  } finally {
    global.fetch = orig;
  }
  const subtypes = (posted?.data?.filters || []).map((/** @type {any} */ f) => f.resource_subtype).filter(Boolean);
  assert.deepEqual(subtypes, ["section_changed", "comment_added"]);
});

test("fetchTask maps displayId from the custom field named ID (case-insensitive)", async () => {
  const { task, urls } = await fetchWith([{ name: "Priority", display_value: "High" }, { name: "id", display_value: "ID-2738" }]);
  assert.equal(task.displayId, "ID-2738");
  assert.equal(task.name, "Fix it");
  assert.ok(urls[0].includes("custom_fields.name,custom_fields.display_value"), "requests the custom fields");
});

test("fetchTask honors a custom displayIdField", async () => {
  const { task } = await fetchWith([{ name: "ID", display_value: "ID-1" }, { name: "Ticket", display_value: "TK-9" }], { displayIdField: "Ticket" });
  assert.equal(task.displayId, "TK-9");
});

test("fetchTask leaves displayId undefined when the field is absent", async () => {
  assert.equal((await fetchWith([{ name: "Priority", display_value: "High" }])).task.displayId, undefined);
  assert.equal((await fetchWith(/** @type {any} */ (undefined))).task.displayId, undefined);
});

// --- routeKeys (multi-repo routing) ---

test("extractRouteKeys reads enum, multi-enum, text, display_value", () => {
  assert.deepEqual(extractRouteKeys([{ name: "Platform", enum_value: { name: "iOS" } }], "Platform"), ["iOS"]);
  assert.deepEqual(
    extractRouteKeys([{ name: "Platform", multi_enum_values: [{ name: "backend" }, { name: "iOS" }] }], "Platform"),
    ["backend", "iOS"],
  );
  assert.deepEqual(extractRouteKeys([{ name: "Platform", text_value: "ios" }], "Platform"), ["ios"]);
  assert.deepEqual(extractRouteKeys([{ name: "Platform", display_value: "Android" }], "Platform"), ["Android"]);
});

test("extractRouteKeys returns [] for unset / missing / unconfigured", () => {
  const unset = { name: "Platform", enum_value: null, multi_enum_values: [], text_value: null, display_value: null };
  assert.deepEqual(extractRouteKeys([unset], "Platform"), []);
  assert.deepEqual(extractRouteKeys([{ name: "Other", text_value: "x" }], "Platform"), []);
  assert.deepEqual(extractRouteKeys([unset], undefined), []);
  assert.deepEqual(extractRouteKeys([{ name: "Platform", text_value: "x" }], ""), []);
  assert.deepEqual(extractRouteKeys(undefined, "Platform"), []);
});

test("extractRouteKeys matches the field name case-insensitively", () => {
  assert.deepEqual(extractRouteKeys([{ name: "Platform", enum_value: { name: "iOS" } }], "platform"), ["iOS"]);
});

test("fetchTask returns routeKeys when routeField set, [] otherwise", async () => {
  const cf = [{ name: "Platform", enum_value: { name: "iOS" } }];
  const on = await fetchWith(cf, { routeField: "Platform" });
  assert.deepEqual(on.task.routeKeys, ["iOS"]);
  assert.ok(on.urls[0].includes("custom_fields.enum_value.name,custom_fields.multi_enum_values.name,custom_fields.text_value"));
  assert.deepEqual((await fetchWith(cf)).task.routeKeys, []);
});

// --- complete (forge merge) ---

test("complete PUTs completed:true on the task", async () => {
  /** @type {string[]} */
  const calls = [];
  let body;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    if (init.body) body = JSON.parse(String(init.body));
    return ok({ data: {} });
  };
  try {
    await routed().complete?.("G1");
  } finally {
    global.fetch = orig;
  }
  assert.deepEqual(calls, ["PUT https://app.asana.com/api/1.0/tasks/G1"]);
  assert.deepEqual(body, { data: { completed: true } });
});

test("complete throws on a non-2xx", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  try {
    await assert.rejects(() => /** @type {any} */ (routed()).complete("G1"), /complete 403/);
  } finally {
    global.fetch = orig;
  }
});

test("complete refuses (no PUT) a task not assigned to us — fail-closed", async () => {
  /** @type {string[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    return ok({ data: { assignee: { gid: "SOMEONE_ELSE" } } });
  };
  try {
    await routed({ assigneeFilter: true, userGid: "ME" }).complete?.("G1");
  } finally {
    global.fetch = orig;
  }
  assert.ok(!calls.some((c) => c.startsWith("PUT")), `unexpected write: ${calls.join("\n")}`);
});

// --- queue-stage pull: listQueued ---
const qPipeline = [{ id: "code", sourceSectionGid: "S1", successSectionGid: "S2", queueSectionGid: "Q1" }];
/** @param {any} [pc] */
const queued = (pc = {}) =>
  createAsanaAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: qPipeline, providerConfig: { type: "asana", token: "t", ...pc } }), /** @type {any} */ (makeStore()));

test("listQueued reads the queue section in API order, keeping only our open tasks", async () => {
  /** @type {string[]} */
  const urls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    urls.push(String(url));
    return ok({
      data: [
        { gid: "t3", completed: false, assignee: { gid: "me" } },
        { gid: "t1", completed: true, assignee: { gid: "me" } },
        { gid: "t2", completed: false, assignee: { gid: "someone" } },
        { gid: "t9", completed: false, assignee: { gid: "me" } },
      ],
    });
  };
  try {
    assert.deepEqual(await queued({ userGid: "me" }).listQueued("code"), ["t3", "t9"]);
    assert.ok(urls[0].includes("/sections/Q1/tasks"), urls[0]);
    // Fail-closed: scoping on but no userGid → nothing is ours.
    assert.deepEqual(await queued().listQueued("code"), []);
  } finally {
    global.fetch = orig;
  }
});

test("listQueued is [] (no API call) for a step without a queue key", async () => {
  let calls = 0;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => (calls++, ok({ data: [] }));
  try {
    assert.deepEqual(await routed().listQueued("code"), []);
  } finally {
    global.fetch = orig;
  }
  assert.equal(calls, 0);
});
