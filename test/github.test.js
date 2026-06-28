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
