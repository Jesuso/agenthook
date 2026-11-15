import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffConfig } from "../src/config-reload.js";

/** @param {any} a @param {any} b */
const d = (a, b) => {
  const r = diffConfig(a, b);
  return { changed: [...r.changed].sort(), restartRequired: [...r.restartRequired].sort() };
};

/** A minimal full-ish config. @param {any} [o] */
const cfg = (o = {}) => ({
  name: "t",
  stateId: "t",
  repoPath: "/tmp/r",
  maxConcurrent: 4,
  quota: { pauseAboveSevenDay: 0.9 },
  tracker: { type: "github", owner: "o", repo: "r" },
  pipeline: [{ id: "code", sourceLabel: "s", successLabel: "d", harness: "h", model: "sonnet" }],
  sandbox: { enabled: true, egress: false },
  harnesses: { h: { command: ["claude"], env: { A: "1" } } },
  ...o,
});

test("diffConfig: reloadable top-level keys (maxConcurrent, quota) are changed; anything else restart-required", () => {
  assert.deepEqual(d(cfg(), cfg({ maxConcurrent: 8 })), { changed: ["maxConcurrent"], restartRequired: [] });
  assert.deepEqual(d(cfg(), cfg({ quota: { pauseAboveSevenDay: 0.5 } })), { changed: ["quota"], restartRequired: [] });
  assert.deepEqual(d(cfg(), cfg({ name: "other" })), { changed: [], restartRequired: ["name"] });
  assert.deepEqual(d(cfg(), cfg({ repoPath: "/elsewhere" })), { changed: [], restartRequired: ["repoPath"] });
  assert.deepEqual(d(cfg(), cfg({ overlapGuard: true })), { changed: [], restartRequired: ["overlapGuard"] });
});

test("diffConfig: derived keys are never diffed directly, even when they differ", () => {
  const a = cfg();
  const b = cfg({
    stateDir: "/x/other",
    configPath: "/x/c.json",
    provider: "asana",
    providerConfig: { type: "asana" },
    tracker: { type: "github", owner: "other", repo: "r" },
    pipeline: cfg().pipeline,
  });
  // `tracker.owner` differs → restart-required; the aliases provider/providerConfig/pipeline (and
  // the other derived paths) are ignored even though they differ.
  assert.deepEqual(d(a, b), { changed: [], restartRequired: ["tracker.owner"] });
});

test("diffConfig: sandbox — egress is reloadable; other sandbox fields and adding/removing the block need a restart", () => {
  assert.deepEqual(d(cfg(), cfg({ sandbox: { enabled: true, egress: true } })), { changed: ["sandbox.egress"], restartRequired: [] });
  assert.deepEqual(d(cfg(), cfg({ sandbox: { enabled: false, egress: false } })), { changed: [], restartRequired: ["sandbox.enabled"] });
  assert.deepEqual(d(cfg({ sandbox: undefined }), cfg({ sandbox: { enabled: true, egress: false } })), { changed: [], restartRequired: ["sandbox"] });
  assert.deepEqual(d(cfg({ sandbox: { enabled: true, egress: false } }), cfg({ sandbox: undefined })), { changed: [], restartRequired: ["sandbox"] });
});

test("diffConfig: harnesses — add/remove/rename and field changes are reloadable; a `remote` change and a block add/remove restart", () => {
  const H = () => ({ command: ["claude"], env: { A: "1" } });
  // add a harness
  assert.deepEqual(
    d(cfg(), cfg({ harnesses: { h: H(), g: { command: ["cursor"] } } })),
    { changed: ["harnesses.g"], restartRequired: [] },
  );
  // remove a harness
  assert.deepEqual(
    d(cfg({ harnesses: { h: H(), g: {} } }), cfg({ harnesses: { h: H() } })),
    { changed: ["harnesses.g"], restartRequired: [] },
  );
  // a field change
  assert.deepEqual(d(cfg(), cfg({ harnesses: { h: { ...H(), env: { A: "2" } } } })), { changed: ["harnesses.h"], restartRequired: [] });
  // remote change → restart
  assert.deepEqual(
    d(cfg(), cfg({ harnesses: { h: { ...H(), remote: { host: "x" } } } })),
    { changed: [], restartRequired: ["harnesses.h.remote"] },
  );
  // adding the first block (or removing the last) → restart
  assert.deepEqual(d(cfg({ harnesses: undefined }), cfg({ harnesses: { h: {} } })), { changed: [], restartRequired: ["harnesses"] });
  assert.deepEqual(d(cfg({ harnesses: { h: {} } }), cfg({ harnesses: undefined })), { changed: [], restartRequired: ["harnesses"] });
});

test("diffConfig: pipeline — reloadable step fields are changed; manual/unknown/add/remove/reorder restart", () => {
  const step = { id: "code", sourceLabel: "s", successLabel: "d", harness: "h", model: "sonnet" };
  const withSteps = (steps) => cfg({ pipeline: steps });
  assert.deepEqual(d(withSteps([step]), withSteps([{ ...step, model: "opus" }])), { changed: ["pipeline[code].model"], restartRequired: [] });
  assert.deepEqual(d(withSteps([step]), withSteps([{ ...step, egress: true }])), { changed: ["pipeline[code].egress"], restartRequired: [] });
  assert.deepEqual(d(withSteps([step]), withSteps([{ ...step, manual: true }])), { changed: [], restartRequired: ["pipeline"] });
  assert.deepEqual(d(withSteps([step]), withSteps([{ ...step, sourceLabel: "other" }])), { changed: [], restartRequired: ["pipeline[code].sourceLabel"] });
  // add / remove / reorder → restart
  const second = { id: "review", sourceLabel: "r", successLabel: "d" };
  assert.deepEqual(d(withSteps([step]), withSteps([step, second])), { changed: [], restartRequired: ["pipeline"] });
  assert.deepEqual(d(withSteps([step, second]), withSteps([step])), { changed: [], restartRequired: ["pipeline"] });
  assert.deepEqual(d(withSteps([step, second]), withSteps([second, step])), { changed: [], restartRequired: ["pipeline"] });
});

test("diffConfig: tracker — a non-pipeline field change is restart-required; its pipeline is ignored (handled by diffPipeline)", () => {
  assert.deepEqual(d(cfg(), cfg({ tracker: { type: "github", owner: "other", repo: "r" } })), { changed: [], restartRequired: ["tracker.owner"] });
  // The tracker's pipeline object differs but is not flagged (the top-level pipeline is what runs).
  const a = cfg();
  const b = cfg({ tracker: { type: "github", owner: "o", repo: "r", pipeline: [{ id: "code" }] } });
  assert.deepEqual(d(a, b), { changed: [], restartRequired: [] });
});

test("diffConfig: no differences → both lists empty", () => {
  assert.deepEqual(d(cfg(), cfg()), { changed: [], restartRequired: [] });
});
