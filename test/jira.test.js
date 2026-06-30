// Jira adapter — pure-unit coverage (no network) for the `agenthook init` discovery
// added in this change. Note: site/email are collected BY the wizard, so the status
// discovery rebuilds base+auth from the answers (not the factory's cached pair) — the
// test asserts it hits the answered site/project, and dedups statuses across issue types.
import test from "node:test";
import assert from "node:assert/strict";
import { createJiraAdapter } from "../src/trackers/jira.js";

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
  const providerConfig = { type: "jira", token: "t" };
  return createJiraAdapter(/** @type {any} */ ({ trigger: "@agent", providerConfig }), /** @type {any} */ (makeStore()));
}

test("pipelineBindings maps the wizard stage picks to status bindings", () => {
  const a = adapter();
  assert.deepEqual(a.pipelineBindings?.({ _sourceStage: "To Do", _successStage: "In Review", _failureStage: "Blocked" }), {
    sourceStatus: "To Do",
    successStatus: "In Review",
    failureStatus: "Blocked",
  });
});

test("pipelineBindings returns null when no stage was picked (init keeps the placeholder)", () => {
  assert.equal(adapter().pipelineBindings?.({}), null);
});

test("init status discovery hits the answered site/project and dedups statuses across issue types", async () => {
  const orig = global.fetch;
  /** @type {string[]} */
  const urls = [];
  // @ts-ignore - test stub
  global.fetch = async (url) => {
    urls.push(String(url));
    // The /statuses endpoint groups by issue type; "To Do" appears under both.
    return /** @type {any} */ ({
      ok: true,
      status: 200,
      json: async () => [
        { name: "Story", statuses: [{ name: "To Do" }, { name: "In Review" }] },
        { name: "Bug", statuses: [{ name: "To Do" }, { name: "Blocked" }] },
      ],
    });
  };
  try {
    const steps = adapter().wizardSteps?.({}) || [];
    const source = steps.find((s) => s.key === "_sourceStage");
    assert.ok(source && typeof source.choices === "function", "expected a _sourceStage select with live choices");
    const choices = await /** @type {any} */ (source.choices)({ site: "acme", email: "bot@x.com", projectKey: "CAHUI" });
    assert.deepEqual(
      choices.map((/** @type {any} */ c) => c.value),
      ["To Do", "In Review", "Blocked"],
    );
    assert.ok(urls.some((u) => u.includes("https://acme.atlassian.net") && u.includes("/project/CAHUI/statuses")), `expected a statuses fetch on the answered site/project; got:\n${urls.join("\n")}`);
  } finally {
    global.fetch = orig;
  }
});
