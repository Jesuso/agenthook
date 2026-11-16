import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub adapter (split from the former github.test.js): HMAC authenticate, label-driven
// processEvents routing, pipelineBindings, init label discovery, describe()/runCredentials/
// listStages, and enterStage's source/failure/manual label handling (incl. a custom pipeline).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createGithubAdapter } from "../src/trackers/github.js";
import { adapter, evt, makeStore, pipeline, withDeps } from "./_github-helpers.js";

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
  const restore = withDeps((u) => (u.endsWith("/issues/42") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:code" }] }) }) : null));
  let jobs;
  try {
    jobs = await adapter().processEvents(
      /** @type {any} */ (evt({ action: "labeled", label: { name: "agent:code" }, issue: { number: 42, labels: [{ name: "agent:code" }], assignees: [] } }, { "x-github-delivery": "guid-1" })),
    );
  } finally {
    restore();
  }
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].ref, "42");
  assert.equal(jobs[0].stepId, "code");
  assert.equal(jobs[0].dedupKey, "secmove:guid-1");
});

test("labeled event with an unknown label yields no job", async () => {
  const jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "labeled", label: { name: "wontfix" }, issue: { number: 9, labels: [{ name: "wontfix" }], assignees: [] } })));
  assert.equal(jobs.length, 0);
});

test("labeled event: a delayed delivery whose live issue no longer carries the label yields no job (stale payload snapshot)", async () => {
  const restore = withDeps((u) => (u.endsWith("/issues/42") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:review" }] }) }) : null));
  let jobs;
  try {
    jobs = await adapter().processEvents(
      /** @type {any} */ (evt({ action: "labeled", label: { name: "agent:code" }, issue: { number: 42, labels: [{ name: "agent:code" }], assignees: [] } }, { "x-github-delivery": "guid-2" })),
    );
  } finally {
    restore();
  }
  assert.equal(jobs.length, 0);
});

test("opened event routes by the issue's current labels (state-based dedup key)", async () => {
  const restore = withDeps((u) => (u.endsWith("/issues/7") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:code" }] }) }) : null));
  let jobs;
  try {
    jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "opened", issue: { number: 7, labels: [{ name: "agent:code" }], assignees: [] } })));
  } finally {
    restore();
  }
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

test("pipelineBindings adds holdLabel only when _holdStage was picked", () => {
  const a = adapter();
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "agent:code", _successStage: "agent:review", _failureStage: "agent:blocked", _holdStage: "agent:hold" }), {
    sourceLabel: "agent:code",
    successLabel: "agent:review",
    failureLabel: "agent:blocked",
    holdLabel: "agent:hold",
  });
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "agent:code", _successStage: "agent:review", _failureStage: "agent:blocked", _holdStage: "" }), {
    sourceLabel: "agent:code",
    successLabel: "agent:review",
    failureLabel: "agent:blocked",
  });
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

test("describe().stageKeys names the label binding family", () => {
  assert.deepEqual(adapter().describe().stageKeys, {
    source: "sourceLabel",
    success: "successLabel",
    failure: "failureLabel",
    hold: "holdLabel",
    queue: "queueLabel",
  });
});

test("describe(): comments go through gh with --repo, and ownerHint names assigneeLogin (#474)", () => {
  const m = adapter().describe();
  assert.equal(m.commentHowTo, `post a comment with: gh issue comment <number> --repo o/r --body "<text>" (gh is already authenticated)`);
  assert.equal(m.readCommentsHowTo, "gh issue view <number> --repo o/r --comments");
  assert.doesNotMatch(`${m.commentHowTo} ${m.readCommentsHowTo}`, /curl|\$GITHUB_TOKEN/);
  assert.equal(m.ownerHint, undefined, "no assigneeLogin → #471's wording");
  assert.equal(adapter({ assigneeLogin: "alice" }).describe().ownerHint, "@alice");
});

test("runCredentials: null under a personal token (the #470 env applies)", async () => {
  const a = adapter();
  assert.equal(await a.runCredentials?.(/** @type {any} */ ({ ref: "1", step: { id: "code" }, task: { url: "https://github.com/o/r/issues/1" }, repoPath: "/nope", dir: "/nope", log: () => {} })), null);
});

test("listStages returns only the repo's existing labels, excluding the synthetic defaults", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    if (String(url).includes("/labels")) {
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => [{ name: "bug" }, { name: "agent:code" }, { name: "enhancement" }] });
    }
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => [] });
  };
  try {
    const stages = await adapter().listStages?.();
    assert.deepEqual(stages, [
      { id: "bug", label: "bug" },
      { id: "agent:code", label: "agent:code" },
      { id: "enhancement", label: "enhancement" },
    ]);
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

test("enterStage drops the step's failure label after adding the source one (retry leaves the failure lane)", async () => {
  /** @param {any[]} pl */
  const run = async (pl) => {
    /** @type {string[]} */
    const calls = [];
    const orig = global.fetch;
    // @ts-ignore - test stub
    global.fetch = async (url, init = {}) => {
      calls.push(`${init.method || "GET"} ${decodeURIComponent(String(url))}`);
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
    };
    try {
      const a = createGithubAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: pl, providerConfig: { type: "github", token: "t", repository: "o/r", assigneeFilter: false } }), /** @type {any} */ (makeStore()));
      await /** @type {any} */ (a).enterStage("42", "code", { assign: false });
    } finally {
      global.fetch = orig;
    }
    return calls;
  };
  const calls = await run(pipeline);
  const add = calls.findIndex((c) => c.startsWith("POST") && c.includes("/issues/42/labels"));
  const drop = calls.findIndex((c) => c.startsWith("DELETE") && c.endsWith("/issues/42/labels/agent:blocked"));
  assert.ok(add >= 0 && drop > add, `expected add source, then drop agent:blocked; got:\n${calls.join("\n")}`);
  // A failure label that is another step's source fires that step: never dropped.
  const routed = await run([{ id: "code", sourceLabel: "agent:code", failureLabel: "agent:fix" }, { id: "fix", sourceLabel: "agent:fix" }]);
  assert.ok(!routed.some((c) => c.startsWith("DELETE")), `expected no label drop; got:\n${routed.join("\n")}`);
});

test("enterStage drops a manual (terminal) step's source label after adding the entered step's one, but never a non-manual step's (#672)", async () => {
  /** @param {any[]} pl */
  const run = async (pl) => {
    /** @type {string[]} */
    const calls = [];
    const orig = global.fetch;
    // @ts-ignore - test stub
    global.fetch = async (url, init = {}) => {
      calls.push(`${init.method || "GET"} ${decodeURIComponent(String(url))}`);
      return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
    };
    try {
      const a = createGithubAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: pl, providerConfig: { type: "github", token: "t", repository: "o/r", assigneeFilter: false } }), /** @type {any} */ (makeStore()));
      await /** @type {any} */ (a).enterStage("42", "code", { assign: false });
    } finally {
      global.fetch = orig;
    }
    return calls;
  };
  const withDone = [
    { id: "code", sourceLabel: "agent:code", successLabel: "agent:review" },
    { id: "review", sourceLabel: "agent:review", successLabel: "agent:done" },
    { id: "done", sourceLabel: "agent:done", manual: true },
  ];
  const calls = await run(withDone);
  const add = calls.findIndex((c) => c.startsWith("POST") && c.includes("/issues/42/labels"));
  const drop = calls.findIndex((c) => c.startsWith("DELETE") && c.endsWith("/issues/42/labels/agent:done"));
  assert.ok(add >= 0 && drop > add, `expected add agent:code, then drop manual agent:done; got:\n${calls.join("\n")}`);
  // "review" isn't manual: its source label must never be dropped this way.
  assert.ok(!calls.some((c) => c.startsWith("DELETE") && c.endsWith("/issues/42/labels/agent:review")), `expected agent:review untouched; got:\n${calls.join("\n")}`);
});

test("enterStage throws on an unknown step", async () => {
  await assert.rejects(() => /** @type {any} */ (adapter()).enterStage("42", "nope", { assign: false }), /unknown step/);
});
