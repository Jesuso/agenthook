import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub adapter — pure-unit coverage (no network): HMAC authenticate, label-driven
// processEvents routing, and the crash-safe add-before-remove ordering in advance.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createGithubAdapter, epicChangeFromEvent, extractRouteKeys, isEpicIssue, mapEpics, mapEpicTickets } from "../src/trackers/github.js";
import { MoveRefusedError } from "../src/trackers/owner.js";
import { ticketBucket } from "../src/epics.js";
import { resetGithubAuthCache } from "../src/github-auth.js";

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

// --- #506: delayed delivery with a stale payload label/assignee snapshot ---

const triagePipeline = [
  { id: "triage", sourceLabel: "agent:triage", successLabel: "agent:code" },
  { id: "code", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:blocked" },
  { id: "review", sourceLabel: "agent:review", successLabel: "agent:done" },
];
/** Adapter with a 3-step pipeline (triage -> code -> review), assigneeFilter off. */
function triageAdapter() {
  return createGithubAdapter(
    /** @type {any} */ ({ trigger: "@agent", pipeline: triagePipeline, providerConfig: { type: "github", token: "t", repository: "o/r", assigneeFilter: false } }),
    /** @type {any} */ (makeStore()),
  );
}

test("assigned event ignores a stale payload label snapshot and routes by the live issue", async () => {
  const restore = withDeps((u) =>
    u.endsWith("/issues/501") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:code" }] }) }) : null,
  );
  try {
    const jobs = await triageAdapter().processEvents(
      /** @type {any} */ (evt({ action: "assigned", issue: { number: 501, labels: [{ name: "agent:triage" }], assignees: [] } })),
    );
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].stepId, "code");
    assert.equal(jobs[0].dedupKey, "step:code:501");
  } finally {
    restore();
  }
});

test("opened event: a closed live issue yields no job", async () => {
  const restore = withDeps((u) =>
    u.endsWith("/issues/55") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "closed", labels: [{ name: "agent:code" }] }) }) : null,
  );
  try {
    const jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "opened", issue: { number: 55, labels: [{ name: "agent:code" }], assignees: [] } })));
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("assigned event: a live issue no longer assigned to us (assigneeFilter on) yields no job", async () => {
  const a = adapter({ assigneeFilter: true, assigneeLogin: "bot" });
  const restore = withDeps((u) =>
    u.endsWith("/issues/56")
      ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:code" }], assignees: [{ login: "someone-else" }] }) })
      : null,
  );
  try {
    const jobs = await a.processEvents(/** @type {any} */ (evt({ action: "assigned", issue: { number: 56, labels: [{ name: "agent:code" }], assignees: [{ login: "bot" }] } })));
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("opened event: a failed live fetch (500) yields no job (fail closed)", async () => {
  const restore = withDeps((u) => (u.endsWith("/issues/57") ? /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) }) : null));
  try {
    const jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "opened", issue: { number: 57, labels: [{ name: "agent:code" }], assignees: [] } })));
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("replay-then-webhook ordering: a forged catchup and a late assigned webhook share the dedupKey while the step is live; once the issue has moved on, the late webhook is a no-op", async () => {
  const a = adapter();
  const restoreUser = withDeps(() => null); // lets ourLogin()'s /user call in forgeCatchup resolve harmlessly
  /** @type {any} */
  let forged;
  try {
    forged = await a.forgeCatchup("99", "code");
  } finally {
    restoreUser();
  }
  assert.equal(forged.dedupKey, "step:code:99");

  const restoreLive = withDeps((u) =>
    u.endsWith("/issues/99") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:code" }], assignees: [] }) }) : null,
  );
  try {
    const jobs = await a.processEvents(/** @type {any} */ (evt({ action: "assigned", issue: { number: 99, labels: [{ name: "agent:code" }], assignees: [] } })));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].dedupKey, forged.dedupKey);
  } finally {
    restoreLive();
  }

  const restoreMoved = withDeps((u) =>
    u.endsWith("/issues/99") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:review" }], assignees: [] }) }) : null,
  );
  try {
    const jobs = await a.processEvents(/** @type {any} */ (evt({ action: "assigned", issue: { number: 99, labels: [{ name: "agent:code" }], assignees: [] } })));
    assert.equal(jobs.length, 0);
  } finally {
    restoreMoved();
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

test("advance throws not_ours (and never relabels) for an issue assigned to someone else", async () => {
  /** @type {string[]} */
  const calls = [];
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ assignees: [{ login: "someone-else" }] }) });
  };
  try {
    await assert.rejects(
      adapter({ assigneeFilter: true, assigneeLogin: "bot" }).advance("42", "code", { outcome: "advance" }),
      (e) => e instanceof MoveRefusedError && e.reason === "not_ours",
    );
  } finally {
    global.fetch = orig;
  }
  assert.ok(!calls.some((c) => !c.startsWith("GET")), `expected no mutation; got:\n${calls.join("\n")}`);
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
  const restore = withDeps((u) => {
    if (u.endsWith("/issues/37")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:code" }] }) });
    if (u.includes("/issues/37/dependencies/blocked_by")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => [{ number: 36, state: "open" }] });
    return null;
  });
  try {
    const jobs = await adapter().processEvents(/** @type {any} */ (evt({ action: "opened", issue: { number: 37, labels: [{ name: "agent:code" }], assignees: [] } })));
    assert.equal(jobs.length, 0);
  } finally {
    restore();
  }
});

test("block gate: a CLOSED blocker does not block (blockedBy filters by state — the step fires)", async () => {
  const restore = withDeps((u) => {
    if (u.endsWith("/issues/37")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:code" }] }) });
    if (u.includes("/issues/37/dependencies/blocked_by")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => [{ number: 36, state: "closed" }] });
    return null;
  });
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
  const restore = withDeps((u) => {
    if (u.endsWith("/issues/38")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:code" }] }) });
    if (u.includes("/issues/38/dependencies/blocked_by")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => [{ number: 36, state: "open" }] });
    return null;
  });
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
    // The close-release jobs only (#36 is ours here, so a `board_done` rides along).
    const jobs = (await adapter().processEvents(/** @type {any} */ (evt({ action: "closed", issue: { number: 36, labels: [], assignees: [] } })))).filter((j) => j.kind === "pipeline");
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
    // The close-release jobs only (#36 is ours here, so a `board_done` rides along).
    const jobs = (await adapter().processEvents(/** @type {any} */ (evt({ action: "closed", issue: { number: 36, labels: [], assignees: [] } })))).filter((j) => j.kind === "pipeline");
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
    // The close-release jobs only (#36 is ours here, so a `board_done` rides along).
    const jobs = (await a.processEvents(/** @type {any} */ (evt({ action: "closed", issue: { number: 36, labels: [], assignees: [] } })))).filter((j) => j.kind === "pipeline");
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

test("registerWebhook subscribes the hook to issues + issue_comment + sub_issues", async () => {
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
  assert.deepEqual(posted?.events, ["issues", "issue_comment", "sub_issues"]);
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

test("extractRouteKeys: prefix match, case-insensitive, pipeline labels never returned", () => {
  const labels = [{ name: "Platform:iOS" }, "platform:web", { name: "platform:" }, { name: "bug" }, { name: "agent:code" }];
  assert.deepEqual(extractRouteKeys(labels, "platform:"), ["iOS", "web"]);
  assert.deepEqual(extractRouteKeys([{ name: "agent:code" }, { name: "agent:x" }], "agent:", ["agent:code"]), ["x"]);
  assert.deepEqual(extractRouteKeys([{ name: "platform:ios" }], "platform:", ["Platform:IOS"]), []);
  assert.deepEqual(extractRouteKeys(labels, undefined), []);
  assert.deepEqual(extractRouteKeys(undefined, "platform:"), []);
});

test("fetchTask returns routeKeys from labels; [] when routeField unset", async () => {
  const issue = { title: "t", body: "", html_url: "u", state: "open", labels: [{ name: "agent:code" }, { name: "platform:ios" }, { name: "platform:web" }] };
  const restore = withDeps((u) => (u.endsWith("/issues/5") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => issue }) : null));
  try {
    assert.deepEqual((await adapter({ routeField: "platform:" }).fetchTask("5")).routeKeys, ["ios", "web"]);
    assert.deepEqual((await adapter().fetchTask("5")).routeKeys, []);
  } finally {
    restore();
  }
});

// --- listResting: the list-by-label index lags label changes; the live issue read decides ---

/** @param {Record<string, any>} routes  url-suffix → body (or {status}) */
function restingAdapter(routes) {
  const a = createGithubAdapter(
    /** @type {any} */ ({ trigger: "@agent", pipeline: [{ id: "code", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:blocked" }], providerConfig: { type: "github", token: "t", repository: "o/r", assigneeFilter: false } }),
    /** @type {any} */ (makeStore()),
  );
  const restore = withDeps((u) => {
    const hit = Object.entries(routes).find(([suffix]) => u.includes(suffix));
    if (!hit) return null;
    const r = hit[1];
    return /** @type {any} */ ({ ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.body });
  });
  return { a, restore };
}

test("listResting: a ticket the stale list index still shows under the label, but that already moved on, is NOT resting", async () => {
  const { a, restore } = restingAdapter({
    "/dependencies/blocked_by": { body: [] },
    "/issues?state=open&labels=agent%3Acode": { body: [{ number: 10, labels: [{ name: "agent:code" }], assignees: [] }, { number: 11, labels: [{ name: "agent:code" }], assignees: [] }] },
    "/issues/10": { body: { number: 10, state: "open", labels: [{ name: "agent:blocked" }] } }, // moved on: the list is stale
    "/issues/11": { body: { number: 11, state: "open", labels: [{ name: "agent:code" }] } },
  });
  try {
    const jobs = await a.listResting();
    assert.deepEqual(jobs.map((j) => j.ref), ["11"]);
  } finally {
    restore();
  }
});

test("listResting: a closed ticket, and a live read that fails, are not resting (fail closed)", async () => {
  const { a, restore } = restingAdapter({
    "/dependencies/blocked_by": { body: [] },
    "/issues?state=open&labels=agent%3Acode": { body: [{ number: 20, labels: [{ name: "agent:code" }], assignees: [] }, { number: 21, labels: [{ name: "agent:code" }], assignees: [] }, { number: 22, labels: [{ name: "Agent:Code" }], assignees: [] }] },
    "/issues/20": { body: { number: 20, state: "closed", labels: [{ name: "agent:code" }] } },
    "/issues/21": { status: 502, body: {} },
    "/issues/22": { body: { number: 22, state: "open", labels: [{ name: "Agent:Code" }] } }, // label match is case-insensitive
  });
  try {
    assert.deepEqual((await a.listResting()).map((j) => j.ref), ["22"]);
  } finally {
    restore();
  }
});

// --- epics (#309): isEpicIssue / mapEpics / mapEpicTickets, fetchTask, list filters ---

test("isEpicIssue: typed, labelled (any case), custom type/label, plain parent is not an epic", () => {
  assert.equal(isEpicIssue({ type: { name: "Epic" } }, "Epic", "epic"), true);
  assert.equal(isEpicIssue({ labels: [{ name: "Epic" }] }, "Epic", "epic"), true);
  assert.equal(isEpicIssue({ labels: ["EPIC"] }, "Epic", "epic"), true);
  assert.equal(isEpicIssue({ type: { name: "Bug" }, labels: [{ name: "bug" }], sub_issues_summary: { total: 3 } }, "Epic", "epic"), false);
  assert.equal(isEpicIssue({ type: { name: "Initiative" } }, "Initiative", "big"), true);
  assert.equal(isEpicIssue({ labels: [{ name: "big" }] }, "Initiative", "big"), true);
  assert.equal(isEpicIssue({ labels: [{ name: "epic" }] }, "Initiative", "big"), false);
});

test("mapEpics: typed + labelled fixtures each listed once (dedupe by number), PRs dropped, closed → status/completed", () => {
  const epics = mapEpics(
    [
      { number: 1, title: "A", html_url: "ua", state: "open", type: { name: "Epic" } },
      { number: 1, title: "A", html_url: "ua", state: "open", type: { name: "Epic" } }, // same epic via the other path
      { number: 2, title: "B", html_url: "ub", state: "closed", labels: [{ name: "epic" }] },
      { number: 3, title: "PR", html_url: "up", state: "open", type: { name: "Epic" }, pull_request: {} },
      { number: 4, title: "Plain", html_url: "u4", state: "open" },
    ],
    "Epic",
    "epic",
  );
  assert.deepEqual(epics, [
    { ref: "1", name: "A", url: "ua", displayId: "#1", status: "open", completed: false },
    { ref: "2", name: "B", url: "ub", displayId: "#2", status: "closed", completed: true },
  ]);
});

test("mapEpicTickets: in-pipeline stage, no-pipeline-label same-repo, other-repo, PR dropped, closed", () => {
  const stageLabels = new Map([["agent:review", "agent:review"]]);
  const repoApiUrl = "https://api.github.com/repos/o/r";
  const tickets = mapEpicTickets(
    [
      { number: 10, title: "in pipeline", state: "open", repository_url: repoApiUrl, html_url: "https://github.com/o/r/issues/10", labels: [{ name: "agent:review" }] },
      { number: 11, title: "no stage", state: "open", repository_url: repoApiUrl, html_url: "https://github.com/o/r/issues/11", labels: [{ name: "bug" }] },
      { number: 12, title: "other repo", state: "closed", repository_url: "https://api.github.com/repos/o/other", html_url: "https://github.com/o/other/issues/12" },
      { number: 13, title: "pr", state: "open", repository_url: repoApiUrl, pull_request: {} },
    ],
    repoApiUrl,
    stageLabels,
  );
  assert.deepEqual(tickets, [
    { ref: "10", displayId: "#10", name: "in pipeline", completed: false, stage: "agent:review", url: "https://github.com/o/r/issues/10" },
    { ref: "11", displayId: "#11", name: "no stage", completed: false, stage: "", url: "https://github.com/o/r/issues/11" },
    { ref: "o/other#12", displayId: "o/other#12", name: "other repo", completed: true, stage: null, url: "https://github.com/o/other/issues/12" },
  ]);
  assert.equal(ticketBucket(tickets[1], null, [], false), "backlog");
  const openOtherRepo = mapEpicTickets(
    [{ number: 20, title: "other repo open", state: "open", repository_url: "https://api.github.com/repos/o/other" }],
    repoApiUrl,
    stageLabels,
  )[0];
  assert.equal(ticketBucket(openOtherRepo, null, [], false), "untracked");
});

test("fetchTask: no parent_issue_url makes exactly 1 call and sets no epic", async () => {
  const calls = [];
  const restore = withDeps((u) => {
    calls.push(u);
    return u.endsWith("/issues/5") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ title: "t", body: "", html_url: "u", state: "open" }) }) : null;
  });
  try {
    const task = await adapter().fetchTask("5");
    assert.equal(calls.length, 1);
    assert.equal(task.epic, undefined);
    assert.equal(task.isEpic, false);
  } finally {
    restore();
  }
});

test("fetchTask: epic parent sets Task.epic (2 calls)", async () => {
  const calls = [];
  const restore = withDeps((u) => {
    calls.push(u);
    if (u.endsWith("/issues/5")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ title: "t", body: "", html_url: "u", state: "open", parent_issue_url: "x" }) });
    if (u.endsWith("/issues/5/parent")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ number: 7, title: "Epic 7", html_url: "u7", type: { name: "Epic" }, repository_url: "https://api.github.com/repos/o/r" }) });
    return null;
  });
  try {
    const task = await adapter().fetchTask("5");
    assert.equal(calls.length, 2);
    assert.deepEqual(task.epic, { ref: "7", name: "Epic 7", url: "u7", displayId: "#7" });
  } finally {
    restore();
  }
});

test("fetchTask: parent is a plain (non-epic) issue sets no epic", async () => {
  const restore = withDeps((u) => {
    if (u.endsWith("/issues/5")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ title: "t", body: "", html_url: "u", state: "open", parent_issue_url: "x" }) });
    if (u.endsWith("/issues/5/parent")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ number: 7, title: "Plain parent", html_url: "u7", repository_url: "https://api.github.com/repos/o/r" }) });
    return null;
  });
  try {
    assert.equal((await adapter().fetchTask("5")).epic, undefined);
  } finally {
    restore();
  }
});

test("fetchTask: parent 404 sets no epic and does not throw", async () => {
  const restore = withDeps((u) => {
    if (u.endsWith("/issues/5")) return /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ title: "t", body: "", html_url: "u", state: "open", parent_issue_url: "x" }) });
    if (u.endsWith("/issues/5/parent")) return /** @type {any} */ ({ ok: false, status: 404, json: async () => ({}) });
    return null;
  });
  try {
    assert.equal((await adapter().fetchTask("5")).epic, undefined);
  } finally {
    restore();
  }
});

test("fetchTask: labelled issue is isEpic:true", async () => {
  const restore = withDeps((u) => (u.endsWith("/issues/5") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ title: "t", body: "", html_url: "u", state: "open", labels: [{ name: "epic" }] }) }) : null));
  try {
    assert.equal((await adapter().fetchTask("5")).isEpic, true);
  } finally {
    restore();
  }
});

test("listResting drops an epic-labelled and a typed-Epic issue, keeps the rest", async () => {
  const { a, restore } = restingAdapter({
    "/dependencies/blocked_by": { body: [] },
    "/issues?state=open&labels=agent%3Acode": {
      body: [
        { number: 1, labels: [{ name: "agent:code" }], assignees: [] },
        { number: 2, labels: [{ name: "agent:code" }, { name: "epic" }], assignees: [] },
        { number: 3, labels: [{ name: "agent:code" }], type: { name: "Epic" }, assignees: [] },
      ],
    },
    "/issues/1": { body: { number: 1, state: "open", labels: [{ name: "agent:code" }] } },
  });
  try {
    assert.deepEqual((await a.listResting()).map((j) => j.ref), ["1"]);
  } finally {
    restore();
  }
});

test("listQueued drops an epic-labelled and a typed-Epic issue, keeps the rest", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    const res = (data) => /** @type {any} */ ({ ok: true, status: 200, json: async () => data });
    if (u.includes("/dependencies/blocked_by")) return res([]);
    return res([
      { number: 1, assignees: [] },
      { number: 2, assignees: [], labels: [{ name: "epic" }] },
      { number: 3, assignees: [], type: { name: "Epic" } },
    ]);
  };
  try {
    assert.deepEqual(await queued({ assigneeFilter: false }).listQueued("code"), ["1"]);
  } finally {
    global.fetch = orig;
  }
});

test("listEpics returns [] (no throw) on an API error", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) });
  try {
    assert.deepEqual(await adapter().listEpics(), []);
  } finally {
    global.fetch = orig;
  }
});

test("listEpicTickets returns [] (no throw) on an API error", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async () => /** @type {any} */ ({ ok: false, status: 500, json: async () => ({}) });
  try {
    assert.deepEqual(await adapter().listEpicTickets("7"), []);
  } finally {
    global.fetch = orig;
  }
});

test("listEpics merges label-path and type-path results through mapEpics (post-filtered, deduped)", async () => {
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    const res = (data) => /** @type {any} */ ({ ok: true, status: 200, json: async () => data });
    if (u.includes("labels=epic")) return res([{ number: 1, title: "A", html_url: "ua", state: "open", labels: [{ name: "epic" }] }]);
    if (u.includes("type=Epic")) return res([{ number: 1, title: "A", html_url: "ua", state: "open", labels: [{ name: "epic" }] }, { number: 2, title: "B", html_url: "ub", state: "open", type: { name: "Epic" } }]);
    return res([]);
  };
  try {
    const epics = await adapter().listEpics();
    assert.deepEqual(
      epics.map((e) => e.ref),
      ["1", "2"],
    );
  } finally {
    global.fetch = orig;
  }
});

test("listEpics: type path 422 (no issue types on this repo) logs once at info level, never warns, and stops querying type= on later calls", async () => {
  const orig = global.fetch;
  const warn = console.warn;
  const log = console.log;
  let typeCalls = 0;
  /** @type {any[]} */
  const warnings = [];
  /** @type {any[]} */
  const infos = [];
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    const res = (data, status = 200) => /** @type {any} */ ({ ok: status < 400, status, json: async () => data });
    if (u.includes("type=Epic")) {
      typeCalls++;
      return res({}, 422);
    }
    if (u.includes("labels=epic")) return res([{ number: 1, title: "A", html_url: "ua", state: "open", labels: [{ name: "epic" }] }]);
    return res([]);
  };
  console.warn = (...args) => warnings.push(args);
  console.log = (...args) => infos.push(args);
  try {
    const a = adapter();
    const first = await a.listEpics();
    const second = await a.listEpics();
    assert.deepEqual(first.map((e) => e.ref), ["1"]);
    assert.deepEqual(second.map((e) => e.ref), ["1"]);
    assert.equal(typeCalls, 1);
    assert.equal(warnings.length, 0);
    assert.equal(infos.length, 1);
  } finally {
    global.fetch = orig;
    console.warn = warn;
    console.log = log;
  }
});

test("listEpics: type path 500 warns and is retried on every call", async () => {
  const orig = global.fetch;
  const warn = console.warn;
  let typeCalls = 0;
  /** @type {any[]} */
  const warnings = [];
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    const u = String(url);
    const res = (data, status = 200) => /** @type {any} */ ({ ok: status < 400, status, json: async () => data });
    if (u.includes("type=Epic")) {
      typeCalls++;
      return res({}, 500);
    }
    if (u.includes("labels=epic")) return res([{ number: 1, title: "A", html_url: "ua", state: "open", labels: [{ name: "epic" }] }]);
    return res([]);
  };
  console.warn = (...args) => warnings.push(args);
  try {
    const a = adapter();
    await a.listEpics();
    await a.listEpics();
    assert.equal(typeCalls, 2);
    assert.equal(warnings.length, 2);
  } finally {
    global.fetch = orig;
    console.warn = warn;
  }
});

// --- epic_changed (#310): sub_issues + issues typed/untyped → a signal job, never a pipeline job ---

const OUR_REPO = "https://api.github.com/repos/o/r";
const epicParent = { number: 12, repository_url: OUR_REPO, type: { name: "Epic" }, labels: [] };
const subIssue = { id: 9001, number: 40, repository_url: OUR_REPO, labels: [{ name: "agent:code" }], assignees: [] };
/** @param {string} action @param {object} [over] */
const subIssuesEvt = (action, over = {}) => ({ action, parent_issue: epicParent, parent_issue_repo: { url: OUR_REPO, full_name: "o/r" }, sub_issue: subIssue, sub_issue_repo: { url: OUR_REPO }, ...over });

for (const action of ["sub_issue_added", "sub_issue_removed", "parent_issue_added", "parent_issue_removed"]) {
  test(`sub_issues ${action} on an epic parent → one epic_changed for the parent, no pipeline job`, async () => {
    const jobs = await adapter().processEvents(/** @type {any} */ (evt(subIssuesEvt(action), { "x-github-event": "sub_issues", "x-github-delivery": "d-1" })));
    assert.deepEqual(jobs, [{ kind: "epic_changed", ref: "12", stepId: "", dedupKey: "epic:d-1" }]);
  });
}

test("issues typed → Epic, and untyped from Epic → one epic_changed for the issue (assignee gate not consulted)", async () => {
  const typed = { action: "typed", type: { name: "Epic" }, issue: { number: 12, type: { name: "Epic" }, labels: [], assignees: [] } };
  const untyped = { action: "untyped", type: { name: "Epic" }, issue: { number: 12, type: null, labels: [], assignees: [] } };
  const a = adapter({ assigneeFilter: true, assigneeLogin: "someone-else" });
  assert.deepEqual(await a.processEvents(/** @type {any} */ (evt(typed, { "x-github-delivery": "d-2" }))), [{ kind: "epic_changed", ref: "12", stepId: "", dedupKey: "epic:d-2" }]);
  assert.deepEqual(await a.processEvents(/** @type {any} */ (evt(untyped, { "x-github-delivery": "d-3" }))), [{ kind: "epic_changed", ref: "12", stepId: "", dedupKey: "epic:d-3" }]);
});

test("epic_changed without a delivery header falls back to ref:action:sub_issue.id", async () => {
  const jobs = await adapter().processEvents(/** @type {any} */ (evt(subIssuesEvt("sub_issue_added"), { "x-github-event": "sub_issues" })));
  assert.deepEqual(jobs, [{ kind: "epic_changed", ref: "12", stepId: "", dedupKey: "epic:12:sub_issue_added:9001" }]);
});

test("a non-epic parent, a cross-repo parent, a non-epic type change, a labelled epic retyped → as expected", async () => {
  const hdr = { "x-github-event": "sub_issues", "x-github-delivery": "d-4" };
  const plain = { ...epicParent, type: null };
  assert.deepEqual(await adapter().processEvents(/** @type {any} */ (evt(subIssuesEvt("sub_issue_added", { parent_issue: plain }), hdr))), []);
  const foreign = { ...epicParent, repository_url: "https://api.github.com/repos/x/y" };
  assert.deepEqual(await adapter().processEvents(/** @type {any} */ (evt(subIssuesEvt("sub_issue_added", { parent_issue: foreign, parent_issue_repo: { url: "https://api.github.com/repos/x/y" } }), hdr))), []);
  const bug = { action: "typed", type: { name: "Bug" }, issue: { number: 5, type: { name: "Bug" }, labels: [], assignees: [] } };
  assert.deepEqual(await adapter().processEvents(/** @type {any} */ (evt(bug))), []);
  const labelled = { action: "typed", type: { name: "Bug" }, issue: { number: 6, type: { name: "Bug" }, labels: [{ name: "epic" }], assignees: [] } };
  assert.deepEqual((await adapter().processEvents(/** @type {any} */ (evt(labelled, { "x-github-delivery": "d-5" })))).map((j) => [j.kind, j.ref]), [["epic_changed", "6"]]);
});

test("epicChangeFromEvent: unknown sub_issues action / missing repo evidence / repo URL case → null|ref", () => {
  const o = { epicType: "Epic", epicLabel: "epic", repoApiUrl: OUR_REPO };
  assert.equal(epicChangeFromEvent("sub_issues", subIssuesEvt("something_else"), o), null);
  assert.equal(epicChangeFromEvent("sub_issues", subIssuesEvt("sub_issue_added", { parent_issue: { ...epicParent, repository_url: undefined }, parent_issue_repo: undefined }), o), null);
  assert.equal(epicChangeFromEvent("sub_issues", subIssuesEvt("sub_issue_added", { parent_issue: { ...epicParent, repository_url: OUR_REPO.toUpperCase() } }), o), "12");
  assert.equal(epicChangeFromEvent("issues", { action: "labeled", issue: epicParent }, o), null);
});

test("a sub_issues delivery with a bad / absent signature is rejected", () => {
  const a = adapter({ webhookSecret: "s3cr3t" });
  const body = JSON.stringify(subIssuesEvt("sub_issue_added"));
  assert.equal(a.authenticate(/** @type {any} */ ({ rawBody: body, headers: { "x-github-event": "sub_issues", "x-hub-signature-256": "sha256=deadbeef" } })).type, "reject");
  assert.equal(a.authenticate(/** @type {any} */ ({ rawBody: body, headers: { "x-github-event": "sub_issues" } })).type, "reject");
});

// --- GitHub App auth (src/github-auth.js): installation token + human assigneeLogin ---

const APP_PEM = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const APP_AUTH = { type: "app", appId: "101", installationId: "202", privateKey: APP_PEM };

/** Stub global.fetch: the access_tokens endpoint mints "inst-tok"; every other call is recorded
 * (method, url, Authorization) and answered by `route` (default: 201, `[]` for a GET, `{}` otherwise).
 * @param {(url: string, init: any) => any} [route] */
function stubAppFetch(route) {
  resetGithubAuthCache();
  /** @type {{method: string, url: string, auth: string, body: any}[]} */
  const calls = [];
  let mints = 0;
  const orig = global.fetch;
  // @ts-ignore - test stub
  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/app/installations/202/access_tokens")) {
      mints++;
      return /** @type {any} */ ({ ok: true, status: 201, json: async () => ({ token: "inst-tok", expires_at: new Date(Date.now() + 3600e3).toISOString() }) });
    }
    calls.push({ method: init.method || "GET", url: String(url), auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
    return /** @type {any} */ (route?.(String(url), init) ?? { ok: true, status: 201, json: async () => (init.method ? {} : []) });
  };
  return { calls, mints: () => mints, restore: () => (global.fetch = orig) };
}

/** An App-auth adapter acting for the human "alice" (assignee scoping on). @param {object} [pc] @param {any} [store] */
function appAdapter(pc = {}, store = makeStore()) {
  const providerConfig = { type: "github", auth: APP_AUTH, assigneeLogin: "alice", repository: "o/r", ...pc };
  return createGithubAdapter(/** @type {any} */ ({ trigger: "@agent", pipeline: heldPipeline, providerConfig }), /** @type {any} */ (store));
}

test("App auth: every API call carries Bearer <installation token>; enterStage assigns the human, never /user", async () => {
  const { calls, mints, restore } = stubAppFetch();
  try {
    await /** @type {any} */ (appAdapter()).enterStage("42", "code");
  } finally {
    restore();
  }
  assert.ok(calls.length >= 2, `calls: ${JSON.stringify(calls)}`);
  for (const c of calls) assert.equal(c.auth, "Bearer inst-tok", `${c.method} ${c.url}`);
  assert.equal(mints(), 1, "one installation token served every call");
  const assign = calls.find((c) => c.url.endsWith("/issues/42/assignees"));
  assert.deepEqual(assign?.body, { assignees: ["alice"] });
  assert.ok(!calls.some((c) => c.url.endsWith("/user")), "identity is never looked up from the App token");
});

test("App auth scoping: an issue assigned to the human is acted on; a foreign assignee is not", async () => {
  const { calls, restore } = stubAppFetch((url) =>
    url.endsWith("/issues/42") ? { ok: true, status: 200, json: async () => ({ state: "open", labels: [{ name: "agent:code" }] }) } : undefined,
  );
  try {
    const a = appAdapter();
    /** @param {string} login */
    const labeled = (login) => /** @type {any} */ (evt({ action: "labeled", label: { name: "agent:code" }, issue: { number: 42, labels: [{ name: "agent:code" }], assignees: [{ login }] } }, { "x-github-delivery": `d-${login}` }));
    assert.equal((await a.processEvents(labeled("Alice"))).length, 1);
    assert.deepEqual(await a.processEvents(labeled("mallory")), []);
    assert.deepEqual(await a.processEvents(labeled("my-app[bot]")), []);
  } finally {
    restore();
  }
  assert.ok(!calls.some((c) => c.url.endsWith("/user")));
});

test("App auth @agent: the human's reply resumes; the App's [bot] login or another user does not", async () => {
  const { calls, restore } = stubAppFetch();
  const store = { ...makeStore(), getHeld: () => ({ stepId: "triage", heldAt: "2026-09-24T00:00:00.000Z" }), getAttempt: () => 1 };
  try {
    const a = appAdapter({}, store);
    /** @param {string} login @param {number} id */
    const comment = (login, id) =>
      /** @type {any} */ (evt({ action: "created", issue: { number: 42, labels: [{ name: "agent:held" }], assignees: [{ login: "alice" }] }, comment: { id, body: "@agent go", user: { login } } }, { "x-github-event": "issue_comment" }));
    assert.deepEqual(await a.processEvents(comment("alice", 1)), [{ kind: "pipeline", ref: "42", stepId: "triage", dedupKey: "trigger:1", comment: "@agent go" }]);
    assert.deepEqual(await a.processEvents(comment("my-app[bot]", 2)), []);
    assert.deepEqual(await a.processEvents(comment("mallory", 3)), []);
  } finally {
    restore();
  }
  assert.ok(!calls.some((c) => c.url.endsWith("/user")));
});

test("App auth without assigneeLogin fails closed: nothing is ours and /user is never called", async () => {
  const { calls, restore } = stubAppFetch();
  try {
    const a = appAdapter({ assigneeLogin: undefined });
    const ev = /** @type {any} */ (evt({ action: "labeled", label: { name: "agent:code" }, issue: { number: 42, labels: [{ name: "agent:code" }], assignees: [{ login: "alice" }] } }));
    assert.deepEqual(await a.processEvents(ev), []);
  } finally {
    restore();
  }
  assert.ok(!calls.some((c) => c.url.endsWith("/user")));
});

test("App auth init discovery lists the installation's repos (GET /installation/repositories)", async () => {
  const { calls, restore } = stubAppFetch((url) => (url.includes("/installation/repositories") ? { ok: true, status: 200, json: async () => ({ repositories: [{ full_name: "o/r" }, { full_name: "o/s" }] }) } : undefined));
  let choices;
  try {
    const step = /** @type {any} */ (appAdapter()).wizardSteps().find((/** @type {any} */ s) => s.key === "repository");
    choices = await step.choices({});
  } finally {
    restore();
  }
  assert.deepEqual(choices, [{ title: "o/r", value: "o/r" }, { title: "o/s", value: "o/s" }]);
  assert.ok(!calls.some((c) => c.url.includes("/user/repos")));
});

// --- done signal (#585): fetchTask().completed is the native flag; a close of ours → board_done ---

test("fetchTask().completed: open → false, closed → true", async () => {
  for (const [state, completed] of [["open", false], ["closed", true]]) {
    const restore = withDeps((u) => (u.endsWith("/issues/5") ? /** @type {any} */ ({ ok: true, status: 200, json: async () => ({ title: "t", body: "", html_url: "u", state }) }) : null));
    try {
      assert.equal((await adapter().fetchTask("5")).completed, completed, state);
    } finally {
      restore();
    }
  }
});

test("board_done: closing an issue of ours yields one board_done (keyed by delivery), alongside the close-release; not ours → none", async () => {
  const restore = withDeps(() => null); // no dependents
  try {
    const a = adapter({ assigneeFilter: true, assigneeLogin: "bot" });
    const ours = await a.processEvents(
      /** @type {any} */ (evt({ action: "closed", issue: { number: 36, labels: [], assignees: [{ login: "bot" }] } }, { "x-github-delivery": "d-1" })),
    );
    assert.deepEqual(ours, [{ kind: "board_done", ref: "36", stepId: "", dedupKey: "done:d-1" }]);
    const theirs = await a.processEvents(
      /** @type {any} */ (evt({ action: "closed", issue: { number: 36, labels: [], assignees: [{ login: "someone" }] } }, { "x-github-delivery": "d-2" })),
    );
    assert.deepEqual(theirs, []);
  } finally {
    restore();
  }
});
