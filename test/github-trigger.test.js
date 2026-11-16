import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub adapter (split from the former github.test.js): native-dependency issue blocking
// (block gate + close-release), closeIssue on a terminal step, the `@agent` comment trigger
// (issue_comment → resume the held step), webhook (un)registration, and fetchTask's displayId.
import test from "node:test";
import assert from "node:assert/strict";
import { createGithubAdapter } from "../src/trackers/github.js";
import { adapter, evt, heldPipeline, makeStore, withDeps } from "./_github-helpers.js";

// --- issue blocking (native GitHub dependencies) ---

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

