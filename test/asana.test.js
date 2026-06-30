// Asana adapter — pure-unit coverage (no network) for the `agenthook init` discovery
// added in this change: live section listing and the stage-pick → binding mapping.
import test from "node:test";
import assert from "node:assert/strict";
import { createAsanaAdapter } from "../src/trackers/asana.js";

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
