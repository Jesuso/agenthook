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

// --- issue blocking (native GitHub dependencies) ---

/** Stub fetch so blocked_by/blocking return the given fixtures, else an empty 200. */
function withDeps(/** @type {(url:string)=>any} */ route) {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => route(String(url)) ?? /** @type {any} */ ({ ok: true, status: 200, json: async () => [] });
  return () => {
    global.fetch = orig;
  };
}

test("block gate: an OPEN blocker rests the issue (opened path emits no job)", async () => {
  const restore = withDeps((u) =>
    u.includes("/issues/37/dependencies/blocked_by") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => [{ number: 36, state: "open" }] }) : null,
  );
  try {
    const jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "opened", issue: { number: 37, labels: [{ name: "agent:code" }], assignees: [] } })));
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("block gate: a CLOSED blocker does not block (blockedBy filters by state — the step fires)", async () => {
  const restore = withDeps((u) =>
    u.includes("/issues/37/dependencies/blocked_by") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => [{ number: 36, state: "closed" }] }) : null,
  );
  try {
    const jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "opened", issue: { number: 37, labels: [{ name: "agent:code" }], assignees: [] } })));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].ref, "37");
    assert.equal(jobs[0].stepId, "code");
  } finally {
    restore();
  }
});

test("block gate also applies to the labeled path", async () => {
  const restore = withDeps((u) =>
    u.includes("/issues/38/dependencies/blocked_by") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => [{ number: 36, state: "open" }] }) : null,
  );
  try {
    const jobs = await adapter().processEvents(
      /** @type {any} */ (evt({ action: "labeled", label: { name: "agent:code" }, issue: { number: 38, labels: [{ name: "agent:code" }], assignees: [] } }, { "x-github-delivery": "g" })),
    );
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("close-release: closing a blocker fires only its now-unblocked, resting, owned dependents", async () => {
  const restore = withDeps((u) => {
    // #36 blocks 37 (ours, agent:code, now unblocked), 39 (ours, agent:code, still blocked by #41),
    // 40 (ours but resting in no source label) → only #37 should fire.
    if (u.includes("/issues/36/dependencies/blocking"))
      return /** @type {any} */ ({
        ok: true,
        status: 200,
        json: async () => [
          { number: 37, state: "open", labels: [{ name: "agent:code" }], assignees: [] },
          { number: 39, state: "open", labels: [{ name: "agent:code" }], assignees: [] },
          { number: 40, state: "open", labels: [{ name: "wontfix" }], assignees: [] },
        ],
      });
    if (u.includes("/issues/39/dependencies/blocked_by")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => [{ number: 41, state: "open" }] });
    return null; // 37 (and any other) blocked_by → empty 200 = unblocked
  });
  try {
    const jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "closed", issue: { number: 36, labels: [], assignees: [] } })));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].ref, "37");
    assert.equal(jobs[0].stepId, "code");
    assert.equal(jobs[0].dedupKey, "unblock:36:37");
  } finally {
    restore();
  }
});

test("close-release: a dependent that is itself CLOSED is never fired (no agent on a closed issue)", async () => {
  const restore = withDeps((u) =>
    // #36 blocks #50 — ours, resting in agent:code, unblocked — but #50 is itself closed.
    u.includes("/issues/36/dependencies/blocking")
      ? /** @type {any} */ ({ ok: true, status: 200, json: async () => [{ number: 50, state: "closed", labels: [{ name: "agent:code" }], assignees: [] }] })
      : null,
  );
  try {
    const jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "closed", issue: { number: 36, labels: [], assignees: [] } })));
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("close-release: a dependent resting in a manual/terminal step is not fired (mirrors listResting)", async () => {
  const pl = [
    { id: "code", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:blocked" },
    { id: "done", sourceLabel: "agent:done", manual: true, closeIssue: true },
  ];
  const a = createGithubAdapter(
    /** @type {any} */ ({ trigger: "@agent", pipeline: pl, providerConfig: { type: "github", token: "t", repository: "o/r", assigneeFilter: false } }),
    /** @type {any} */ (makeStore()),
  );
  const restore = withDeps((u) =>
    // #36 blocks #51 — ours, open, unblocked — but it rests in the manual terminal step agent:done.
    u.includes("/issues/36/dependencies/blocking")
      ? /** @type {any} */ ({ ok: true, status: 200, json: async () => [{ number: 51, state: "open", labels: [{ name: "agent:done" }], assignees: [] }] })
      : null,
  );
  try {
    const jobs = await a.processEvents(/** @type {any} */ (evt({ action: "closed", issue: { number: 36, labels: [], assignees: [] } })));
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("advance closes the issue when entering a terminal step flagged closeIssue (auto-release)", async () => {
  const pl = [
    { id: "review", sourceLabel: "agent:review", successLabel: "agent:done", failureLabel: "agent:blocked" },
    { id: "done", sourceLabel: "agent:done", manual: true, closeIssue: true },
  ];
  const a = createGithubAdapter(
    /** @type {any} */ ({ trigger: "@agent", pipeline: pl, providerConfig: { type: "github", token: "t", repository: "o/r", assigneeFilter: false } }),
    /** @type {any} */ (makeStore()),
  );
  /** @type {string[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    await a.advance("42", "review", { outcome: "advance" });
  } finally {
    global.fetch = orig;
  }
  const patch = calls.find((c) => c.startsWith("PATCH") && c.includes("/issues/42"));
  assert.ok(patch, `expected a PATCH closing the issue on entering the terminal step; got:\n${calls.join("\n")}`);
});

test("advance does NOT close the issue entering a non-terminal step (no closeIssue flag)", async () => {
  /** @type {string[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    // default pipeline: code → agent:review (no review/done step), so no closeIssue applies
    await adapter().advance("42", "code", { outcome: "advance" });
  } finally {
    global.fetch = orig;
  }
  assert.ok(!calls.some((c) => c.startsWith("PATCH")), `expected no close PATCH; got:\n${calls.join("\n")}`);
});

// --- the `@agent` comment trigger (issue_comment → resume the held step) ---

const heldPipeline = [
  { id: "triage", sourceLabel: "agent:triage", successLabel: "agent:code", failureLabel: "agent:blocked", holdLabel: "agent:held" },
  { id: "code", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:blocked", holdLabel: "agent:held" },
];

/** Adapter over a store stub whose held record / attempt count the test controls.
 * assigneeLogin pins "us" to "bot" so no /user fetch is needed (unless overridden).
 * @param {{pc?: object, held?: any, ran?: number}} [o] */
function commentAdapter({ pc = {}, held = { stepId: "triage", heldAt: "2026-09-24T00:00:00.000Z" }, ran = 1 } = {}) {
  const store = { ...makeStore(), getHeld: () => held, getAttempt: () => ran };
  const providerConfig = { type: "github", token: "t", repository: "o/r", assigneeFilter: false, assigneeLogin: "bot", ...pc };
  return createGithubAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: heldPipeline, providerConfig }), /** @type {any} */ (store));
}

/** An issue_comment delivery. @param {{action?: string, login?: string, body?: string, issue?: any}} [o] */
function commentEvt({ action = "created", login = "bot", body = "@agent use Postgres", issue = {} } = {}) {
  const ev = {
    action,
    issue: { number: 42, labels: [{ name: "agent:held" }], assignees: [{ login: "bot" }], ...issue },
    comment: { id: 9001, body, user: { login } },
  };
  return /** @type {any} */ (evt(ev, { "x-github-event": "issue_comment" }));
}

test("issue_comment: an owner's @agent reply on a held issue resumes the held step", async () => {
  const jobs = await commentAdapter().processEvents(commentEvt({ login: "BOT" })); // login match is case-insensitive
  assert.deepEqual(jobs, [{ kind: "pipeline", ref: "42", stepId: "triage", dedupKey: "trigger:9001", comment: "@agent use Postgres" }]);
});

test("issue_comment: resumes under assignee scoping when the issue is ours", async () => {
  const jobs = await commentAdapter({ pc: { assigneeFilter: true } }).processEvents(commentEvt());
  assert.equal(jobs.length, 1);
});

test("issue_comment: assigneeFilter:false still rejects a non-owner author", async () => {
  assert.deepEqual(await commentAdapter().processEvents(commentEvt({ login: "mallory" })), []);
});

test("issue_comment: a body not starting with the trigger yields no job", async () => {
  assert.deepEqual(await commentAdapter().processEvents(commentEvt({ body: "thanks @agent, use Postgres" })), []);
});

test("issue_comment: an issue not assigned to us yields no job (assignee gate)", async () => {
  const a = commentAdapter({ pc: { assigneeFilter: true } });
  assert.deepEqual(await a.processEvents(commentEvt({ issue: { assignees: [{ login: "someone-else" }] } })), []);
});

test("issue_comment: a comment on a PR yields no job", async () => {
  assert.deepEqual(await commentAdapter().processEvents(commentEvt({ issue: { pull_request: { url: "x" } } })), []);
});

test("issue_comment: no held record yields no job", async () => {
  assert.deepEqual(await commentAdapter({ held: null }).processEvents(commentEvt()), []);
});

test("issue_comment: the held step at its attempt cap yields no job (bounds a self-trigger loop)", async () => {
  assert.deepEqual(await commentAdapter({ ran: 3 }).processEvents(commentEvt()), []);
});

test("issue_comment: edited / deleted actions yield no job", async () => {
  assert.deepEqual(await commentAdapter().processEvents(commentEvt({ action: "edited" })), []);
  assert.deepEqual(await commentAdapter().processEvents(commentEvt({ action: "deleted" })), []);
});

test("issue_comment: an unresolvable login fails closed (no job)", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub: /user errors
  global.fetch = async () => /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) });
  try {
    assert.deepEqual(await commentAdapter({ pc: { assigneeLogin: undefined } }).processEvents(commentEvt()), []);
  } finally {
    global.fetch = orig;
  }
});

test("registerWebhook subscribes the hook to issues + issue_comment", async () => {
  /** @type {any} */
  let posted;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/hooks") && init.method === "POST") posted = JSON.parse(String(init.body));
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => (String(url).includes("/hooks?") ? [] : { id: 1, active: true }) });
  };
  try {
    await adapter({ webhookSecret: "s" }).registerWebhook("https://example.test");
  } finally {
    global.fetch = orig;
  }
  assert.deepEqual(posted?.events, ["issues", "issue_comment"]);
});

test("advance on a resumed step drops the hold label too (issue ends with only the target label)", async () => {
  const labels = new Set(["agent:held"]); // resumed from hold: carries the holdLabel, not the sourceLabel
  const orig = global.fetch;
  // @ts-ignore - test stub: a tiny label store for issue 42
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (init.method === "POST" && u.endsWith("/issues/42/labels")) for (const l of JSON.parse(String(init.body)).labels) labels.add(l);
    if (init.method === "DELETE" && u.includes("/issues/42/labels/")) {
      const l = decodeURIComponent(u.split("/labels/")[1]);
      if (!labels.delete(l)) return /** @type {any} */ ({ ok: false, status: 404, json: async () => ({}) });
    }
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({}) });
  };
  try {
    await commentAdapter().advance("42", "triage", { outcome: "advance" });
  } finally {
    global.fetch = orig;
  }
  assert.deepEqual([...labels], ["agent:code"]);
});

test("fetchTask returns #<n> as the displayId", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ title: "T", body: "b", html_url: "u", state: "open" }) });
  let task;
  try {
    task = await adapter().fetchTask("94");
  } finally {
    global.fetch = orig;
  }
  assert.equal(task.displayId, "#94");
  assert.equal(task.name, "T");
});

test("unregisterWebhooks deletes /github hooks but never a forge /forge hook", async () => {
  /** @type {string[]} */
  const deletes = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    if ((init.method || "GET") === "DELETE") deletes.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => [
        { id: 1, config: { url: "https://x.example/github/" } },
        { id: 2, config: { url: "https://x.example/forge" } },
      ],
    };
  };
  try {
    await adapter().unregisterWebhooks();
  } finally {
    global.fetch = orig;
  }
  assert.deepEqual(deletes, ["https://api.github.com/repos/o/r/hooks/1"]);
});

// --- queue-stage pull: listQueued + enterStage leaving the queue label ---
const qPipeline = [{ id: "code", sourceLabel: "agent:code", successLabel: "agent:review", queueLabel: "queue:code" }];
/** @param {any} [pc] */
function queued(pc = {}) {
  const providerConfig = { type: "github", token: "t", repository: "o/r", ...pc };
  return createGithubAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: qPipeline, providerConfig }), /** @type {any} */ (makeStore()));
}

test("listQueued lists the queue label oldest-first, keeping only our open, unblocked issues", async () => {
  /** @type {string[]} */
  const urls = [];
  const orig = global.fetch;
  /** @param {any} data */
  const res = (data) => /** @type {any} */ ({ ok: true, status: 200, json: async () => data });
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith("/user")) return res({ login: "bot" });
    if (u.includes("/issues/5/dependencies/blocked_by")) return res([{ number: 1, state: "open" }]);
    if (u.includes("/dependencies/blocked_by")) return res([]);
    return res([
      { number: 3, assignees: [{ login: "bot" }] },
      { number: 4, assignees: [{ login: "bot" }], pull_request: {} },
      { number: 5, assignees: [{ login: "bot" }] },
      { number: 6, assignees: [{ login: "someone" }] },
      { number: 8, assignee: { login: "Bot" } },
    ]);
  };
  let refs;
  try {
    refs = await queued().listQueued("code");
  } finally {
    global.fetch = orig;
  }
  assert.deepEqual(refs, ["3", "8"]);
  const list = urls.find((u) => u.includes("/issues?"));
  assert.ok(list?.includes("labels=queue%3Acode") && list.includes("assignee=bot") && list.includes("sort=created&direction=asc"), list);
});

test("listQueued fails closed when our login can't be resolved", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) });
  try {
    await assert.rejects(() => queued().listQueued("code"), /\/user 500/);
  } finally {
    global.fetch = orig;
  }
});

test("enterStage on a queue step adds the source label, THEN removes the queue label", async () => {
  /** @type {string[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    // The label add succeeds; the queue-label removal 404s (not on the issue) — tolerated.
    const ok = init.method === "POST";
    return /** @type {any} */ ({ ok, status: ok ? 200 : 404, json: async () => ({}) });
  };
  try {
    await queued({ assigneeFilter: false }).enterStage("42", "code", { assign: false });
  } finally {
    global.fetch = orig;
  }
  const add = calls.findIndex((c) => c.startsWith("POST") && c.endsWith("/issues/42/labels"));
  const del = calls.findIndex((c) => c.startsWith("DELETE") && c.endsWith("/issues/42/labels/queue%3Acode"));
  assert.ok(add >= 0 && del > add, `expected add-then-remove; got:\n${calls.join("\n")}`);
});
