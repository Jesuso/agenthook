import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// GitHub adapter (split from the former github.test.js): GitHub App auth (installation token
// + human assigneeLogin scoping, including the `@agent` resume and init repo discovery), and
// the done signal (#585) — fetchTask().completed and board_done on a close of ours.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createGithubAdapter } from "../src/trackers/github.js";
import { resetGithubAuthCache } from "../src/github/auth.js";
import { adapter, evt, heldPipeline, makeStore, withDeps } from "./_github-helpers.js";

// --- GitHub App auth (src/github/auth.js): installation token + human assigneeLogin ---

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
