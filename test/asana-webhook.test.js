import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Asana adapter — pure-unit coverage (no network): the adapter contract (X-Hook-Signature
// verify, task-added + section_changed routing — mirrors test/github-webhook.test.js;
// advance → addTask mutation and currentStage — mirrors test/github-stage.test.js) plus the
// `agenthook init` discovery (live section listing and the stage-pick → binding mapping).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createAsanaAdapter } from "../src/trackers/asana.js";
import { makeStore, ok, routed } from "./_asana-helpers.js";

/** Build an adapter with only the init-probe config ({type, token}), as init does. */
function adapter() {
  const providerConfig = { type: "asana", token: "t" };
  return createAsanaAdapter(/** @type {any} */ ({ trigger: "@agent", providerConfig }), /** @type {any} */ (makeStore()));
}

// --- adapter contract: handshake/signature verify, the task-added + section_changed routing —
// mirrors test/github-webhook.test.js; the advance → addTask mutation and currentStage —
// mirrors test/github-stage.test.js. The default pipeline binds one `code` step;
// assigneeFilter:false keeps routing offline (no assignee gate), exactly as
// github-webhook.test.js sidesteps the /user lookup.

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

test("pipelineBindings adds holdSectionGid only when _holdStage was picked", () => {
  const a = adapter();
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "111", _successStage: "222", _failureStage: "333", _holdStage: "444" }), {
    sourceSectionGid: "111",
    successSectionGid: "222",
    failureSectionGid: "333",
    holdSectionGid: "444",
  });
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "111", _successStage: "222", _failureStage: "333", _holdStage: "" }), {
    sourceSectionGid: "111",
    successSectionGid: "222",
    failureSectionGid: "333",
  });
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

test("describe().stageKeys names the section-gid binding family", () => {
  assert.deepEqual(adapter().describe().stageKeys, {
    source: "sourceSectionGid",
    success: "successSectionGid",
    failure: "failureSectionGid",
    hold: "holdSectionGid",
    queue: "queueSectionGid",
  });
});

test("listStages fetches the configured project's sections", async () => {
  const orig = global.fetch;
  /** @type {string[]} */
  const urls = [];
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    urls.push(String(url));
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ data: [{ gid: "10", name: "Backlog" }, { gid: "20", name: "In review" }] }) });
  };
  try {
    const a = routed({ projectGid: "777" });
    const stages = await a.listStages?.();
    assert.deepEqual(stages, [
      { id: "10", label: "Backlog" },
      { id: "20", label: "In review" },
    ]);
    assert.ok(urls.some((u) => u.includes("/projects/777/sections")), `expected a sections fetch for the configured project; got:\n${urls.join("\n")}`);
  } finally {
    global.fetch = orig;
  }
});
