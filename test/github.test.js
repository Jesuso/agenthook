// GitHub adapter — pure-unit coverage (no network): HMAC authenticate, label-driven
// processEvents routing, and the crash-safe add-before-remove ordering in advance.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createGithubAdapter } from "../src/trackers/github.js";

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

const pipeline = [{ id: "code", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:blocked" }];

/** Build an adapter. Defaults to assigneeFilter:false so routing needs no /user fetch. */
function adapter(pc = {}) {
  const providerConfig = { type: "github", token: "t", repository: "o/r", assigneeFilter: false, ...pc };
  return createGithubAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline, providerConfig }), /** @type {any} */ (makeStore()));
}

/** @param {object} ev @param {Record<string,string>} [headers] */
function evt(ev, headers = {}) {
  return { pathname: "/github/", headers: { "x-github-event": "issues", ...headers }, rawBody: JSON.stringify(ev) };
}

test("authenticate accepts a correctly signed body", () => {
  const a = adapter({ webhookSecret: "s3cr3t" });
  const body = JSON.stringify({ hello: 1 });
  const sig = "sha256=" + crypto.createHmac("sha256", "s3cr3t").update(body).digest("hex");
  assert.equal(a.authenticate(/** @type {any} */ ({ rawBody: body, headers: { "x-hub-signature-256": sig } })).type, "accept");
});

test("authenticate rejects a bad signature", () => {
  const a = adapter({ webhookSecret: "s3cr3t" });
  const body = JSON.stringify({ hello: 1 });
  assert.equal(a.authenticate(/** @type {any} */ ({ rawBody: body, headers: { "x-hub-signature-256": "sha256=deadbeef" } })).type, "reject");
});

test("authenticate accepts unsigned when webhookSecret:false", () => {
  const a = adapter({ webhookSecret: false });
  assert.equal(a.authenticate(/** @type {any} */ ({ rawBody: "{}", headers: {} })).type, "accept");
});

test("labeled event routes to the step whose sourceLabel was added", async () => {
  const jobs = await adapter().processEvents(
    /** @type {any} */ (evt({ action: "labeled", label: { name: "agent:code" }, issue: { number: 42, labels: [{ name: "agent:code" }], assignees: [] } }, { "x-github-delivery": "guid-1" })),
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].ref, "42");
  assert.equal(jobs[0].stepId, "code");
  assert.equal(jobs[0].dedupKey, "secmove:guid-1");
});

test("labeled event with an unknown label yields no job", async () => {
  const jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "labeled", label: { name: "wontfix" }, issue: { number: 9, labels: [{ name: "wontfix" }], assignees: [] } })));
  assert.equal(jobs.length, 0);
});

test("opened event routes by the issue's current labels (state-based dedup key)", async () => {
  const jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "opened", issue: { number: 7, labels: [{ name: "agent:code" }], assignees: [] } })));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].dedupKey, "step:code:7");
});

test("a non-issues delivery is ignored", async () => {
  const jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "opened", issue: { number: 1, labels: [{ name: "agent:code" }] } }, { "x-github-event": "push" })));
  assert.equal(jobs.length, 0);
});

test("ensureLabels POSTs each unique pipeline label and ignores 422 already-exists", async () => {
  /** @type {string[]} */
  const created = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/labels") && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      created.push(body.name);
      // pretend agent:code already exists (422); the rest are freshly created (201).
      const exists = body.name === "agent:code";
      return /** @type {any} */ ({ ok: !exists, status: exists ? 422 : 201, json: async () => ({}) });
    }
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    await adapter().ensureLabels?.();
  } finally {
    global.fetch = orig;
  }
  // The default pipeline names three distinct labels; a 422 must not throw.
  assert.deepEqual(created.sort(), ["agent:blocked", "agent:code", "agent:review"]);
});

test("pipelineBindings maps the wizard stage picks to label bindings", () => {
  const a = adapter();
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "agent:code", _successStage: "agent:review", _failureStage: "agent:blocked" }), {
    sourceLabel: "agent:code",
    successLabel: "agent:review",
    failureLabel: "agent:blocked",
  });
});

test("pipelineBindings returns null when no stage was picked (init keeps the placeholder)", () => {
  assert.equal(adapter().pipelineBindings?.({}), null);
});

test("init label discovery offers the agenthook defaults first, then the repo's own labels", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    if (String(url).includes("/labels")) {
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => [{ name: "bug" }, { name: "agent:code" }, { name: "enhancement" }] });
    }
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => [] });
  };
  try {
    const steps = adapter().wizardSteps?.({}) || [];
    const source = steps.find((s) => s.key === "_sourceStage");
    assert.ok(source && typeof source.choices === "function", "expected a _sourceStage select with live choices");
    assert.equal(source.default, "agent:code");
    const choices = await /** @type {any} */ (source.choices)({ repository: "o/r" });
    // Defaults lead and are not duplicated by the repo's own "agent:code"; "bug"/"enhancement" follow.
    assert.deepEqual(
      choices.map((/** @type {any} */ c) => c.value),
      ["agent:code", "agent:review", "agent:blocked", "bug", "enhancement"],
    );
  } finally {
    global.fetch = orig;
  }
});

test("enterStage assigns to us then adds the step's source label (run command)", async () => {
  /** @type {string[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    if (String(url).endsWith("/user")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ login: "bot" }) });
    return /** @type {any} */ ({ ok: true, status: 201, json: async () => ({}) });
  };
  let stage;
  try {
    ({ stage } = await /** @type {any} */ (adapter()).enterStage("42", "code"));
  } finally {
    global.fetch = orig;
  }
  assert.equal(stage, "agent:code");
  const assign = calls.findIndex((c) => c.startsWith("POST") && c.includes("/issues/42/assignees"));
  const label = calls.findIndex((c) => c.startsWith("POST") && c.includes("/issues/42/labels"));
  assert.ok(assign >= 0, `expected an assignees POST; got:\n${calls.join("\n")}`);
  assert.ok(label >= 0, `expected a labels POST; got:\n${calls.join("\n")}`);
  assert.ok(assign < label, `assign must precede entering the stage; got:\n${calls.join("\n")}`);
});

test("enterStage with assign:false skips the assignee call but still enters the stage", async () => {
  /** @type {string[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    return /** @type {any} */ ({ ok: true, status: 201, json: async () => ({}) });
  };
  try {
    await /** @type {any} */ (adapter()).enterStage("42", "code", { assign: false });
  } finally {
    global.fetch = orig;
  }
  assert.ok(!calls.some((c) => c.includes("/assignees")), `expected no assignees call; got:\n${calls.join("\n")}`);
  assert.ok(calls.some((c) => c.startsWith("POST") && c.includes("/issues/42/labels")), `expected the stage's label POST; got:\n${calls.join("\n")}`);
});

test("enterStage throws on an unknown step", async () => {
  await assert.rejects(() => /** @type {any} */ (adapter()).enterStage("42", "nope", { assign: false }), /unknown step/);
});

test("forgeCatchup exposes the matched step when the issue rests in a source label", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    if (String(url).includes("/issues/42")) {
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ number: 42, labels: [{ name: "agent:code" }], assignees: [] }) });
    }
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    const forged = await adapter().forgeCatchup?.("42");
    assert.equal(forged?.stepId, "code");
    assert.equal(forged?.dedupKey, "step:code:42");
  } finally {
    global.fetch = orig;
  }
});

test("forgeCatchup leaves stepId undefined when the issue is in no source label (catchup detects the no-op)", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    if (String(url).includes("/issues/7")) {
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ number: 7, labels: [{ name: "wontfix" }], assignees: [] }) });
    }
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    const forged = await adapter().forgeCatchup?.("7");
    assert.equal(forged?.stepId, undefined);
    assert.equal(forged?.dedupKey, "issue:7:opened");
  } finally {
    global.fetch = orig;
  }
});

test("advance adds the target label before removing the source (crash-safe)", async () => {
  /** @type {string[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    await adapter().advance("42", "code", { outcome: "advance" });
  } finally {
    global.fetch = orig;
  }
  const add = calls.findIndex((c) => c.startsWith("POST") && c.includes("/issues/42/labels"));
  const del = calls.findIndex((c) => c.startsWith("DELETE") && c.includes("/issues/42/labels/agent%3Acode"));
  assert.ok(add >= 0, `expected an add-label POST; got:\n${calls.join("\n")}`);
  assert.ok(del >= 0, `expected a remove-label DELETE; got:\n${calls.join("\n")}`);
  assert.ok(add < del, `add must precede remove; got:\n${calls.join("\n")}`);
});

test("currentStage returns ANY pipeline label the issue carries (not just source) — backs run's guard", async () => {
  const orig = global.fetch;
  // The issue rests in the SUCCESS label (agent:review), not the source — still in-flight.
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ labels: [{ name: "agent:review" }, { name: "bug" }] }) });
  try {
    assert.equal(await adapter().currentStage?.("42"), "agent:review");
  } finally {
    global.fetch = orig;
  }
});

test("currentStage is null when the issue carries no pipeline label (clean backlog item)", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ labels: [{ name: "wontfix" }] }) });
  try {
    assert.equal(await adapter().currentStage?.("7"), null);
  } finally {
    global.fetch = orig;
  }
});
