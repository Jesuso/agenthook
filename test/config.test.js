// Config load — pure-unit coverage of the completeOnMerge / forge validation. Each case
// writes a throwaway config to a temp dir and expects loadConfig to REJECT it; rejection
// happens before any state dir is created, so nothing lands in ~/.agenthook.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

/** Write a config and load it. @param {any} over @param {any[]} pipeline */
function load(pipeline, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cfg-"));
  const file = path.join(dir, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify({ name: "ah-cfg-test", repoPath: dir, tracker: { type: "asana", pipeline }, ...over }));
  return () => loadConfig({ configPath: file });
}

test("completeOnMerge on a non-manual step is rejected", () => {
  assert.throws(load([{ id: "code", completeOnMerge: true }]), /completeOnMerge requires manual/);
});

test("more than one completeOnMerge step is rejected", () => {
  const pl = [
    { id: "done", manual: true, completeOnMerge: true },
    { id: "done2", manual: true, completeOnMerge: true },
  ];
  assert.throws(load(pl), /only one pipeline step may set completeOnMerge/);
});

test("a forge block without a type is rejected", () => {
  assert.throws(load([{ id: "code" }], { forge: { repository: "o/r" } }), /forge\.type/);
});

test("a queue key equal to the step's own source is rejected (self-loop)", () => {
  assert.throws(load([{ id: "code", sourceSectionGid: "S1", queueSectionGid: "S1" }]), /queueSectionGid must differ from its own sourceSectionGid/);
  assert.throws(load([{ id: "code", sourceStatus: "In Progress", queueStatus: "in progress " }]), /queueStatus must differ/);
  assert.throws(load([{ id: "code", sourceLabel: "agent:code", queueLabel: "Agent:Code" }]), /queueLabel must differ/);
});

test("a queue key on a manual step is rejected", () => {
  assert.throws(load([{ id: "done", manual: true, queueLabel: "queue:done" }]), /queueLabel is not allowed on a manual step/);
});

test("a non-boolean overlapGuard is rejected", () => {
  assert.throws(load([{ id: "code" }], { overlapGuard: "yes" }), /"overlapGuard" must be true or false/);
});
