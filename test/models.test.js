import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// src/models.js — context-window resolution for the live context gauge (#658).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contextWindowOf, resolveContextWindow, CONTEXT_WINDOWS } from "../src/models.js";

test("contextWindowOf: Claude family, aliases, [1m] suffix, unknown → null", () => {
  assert.equal(contextWindowOf("claude-opus-5-5"), 200000);
  assert.equal(contextWindowOf("sonnet"), 200000);
  assert.equal(contextWindowOf("SONNET"), 200000, "case-insensitive");
  assert.equal(contextWindowOf("claude-sonnet-5-5[1m]"), 1000000);
  assert.equal(contextWindowOf("claude-sonnet-5-5[1M]"), 1000000, "case-insensitive suffix");
  assert.equal(contextWindowOf("qwen3-coder"), null);
  assert.equal(contextWindowOf("auto/claude-opus-5-5"), 200000, "provider/model tail fallback");
  assert.equal(contextWindowOf(undefined), null);
  assert.equal(contextWindowOf(""), null);
});

test("CONTEXT_WINDOWS: every key resolves through contextWindowOf", () => {
  for (const k of Object.keys(CONTEXT_WINDOWS)) {
    const bare = k.replace(/\*$/, k.includes("*") ? "x" : "");
    assert.equal(typeof contextWindowOf(bare), "number", bare);
  }
});

test("resolveContextWindow: explicit step.contextTokens wins over everything, including opencodeConfig", () => {
  assert.equal(resolveContextWindow({ step: { contextTokens: 64000 }, model: "claude-opus-5-5" }), 64000);
  assert.equal(resolveContextWindow({ step: { contextTokens: 64000 }, model: "qwen3-coder" }), 64000);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-models-explicit-"));
  const cfgPath = path.join(dir, "opencode.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ provider: { anthropic: { models: { "claude-opus-5-5": { limit: { context: 131072 } } } } } }));
  const step = { contextTokens: 64000, opencodeConfig: cfgPath };
  assert.equal(resolveContextWindow({ step, model: "anthropic/claude-opus-5-5", agentName: "opencode" }), 64000);
});

test("resolveContextWindow: opencodeConfig's limit.context wins over the built-in table", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-models-"));
  const cfgPath = path.join(dir, "opencode.json");
  // anthropic/claude-opus-5-5 is in the built-in table at 200000 — opencodeConfig must still override it.
  fs.writeFileSync(cfgPath, JSON.stringify({ provider: { anthropic: { models: { "claude-opus-5-5": { limit: { context: 64000 } } } } } }));
  const step = { opencodeConfig: cfgPath };
  assert.equal(resolveContextWindow({ step, model: "anthropic/claude-opus-5-5", agentName: "opencode" }), 64000);
  // Not opencode: the opencodeConfig is never consulted, even though it's set — falls through to the table.
  assert.equal(resolveContextWindow({ step, model: "anthropic/claude-opus-5-5", agentName: "claude" }), 200000);
});

test("resolveContextWindow: an unreadable or invalid opencodeConfig falls through to the table, never throws", () => {
  const stepMissing = { opencodeConfig: "/no/such/file.json" };
  assert.equal(resolveContextWindow({ step: stepMissing, model: "anthropic/claude-opus-5-5", agentName: "opencode" }), 200000);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-models-bad-"));
  const badJson = path.join(dir, "bad.json");
  fs.writeFileSync(badJson, "{not json");
  assert.equal(resolveContextWindow({ step: { opencodeConfig: badJson }, model: "anthropic/claude-opus-5-5", agentName: "opencode" }), 200000);

  const noLimit = path.join(dir, "no-limit.json");
  fs.writeFileSync(noLimit, JSON.stringify({ provider: { ollama: { models: { "qwen3-coder": {} } } } }));
  assert.equal(resolveContextWindow({ step: { opencodeConfig: noLimit }, model: "ollama/qwen3-coder", agentName: "opencode" }), null);
});

test("resolveContextWindow: falls back to the built-in table, then to null for an unknown/local model", () => {
  assert.equal(resolveContextWindow({ step: {}, model: "claude-opus-5-5" }), 200000);
  assert.equal(resolveContextWindow({ step: {}, model: "sonnet" }), 200000);
  assert.equal(resolveContextWindow({ step: {}, model: "claude-sonnet-5-5[1m]" }), 1000000);
  assert.equal(resolveContextWindow({ step: {}, model: "qwen3-coder" }), null);
  assert.equal(resolveContextWindow({ step: {} }), null);
});
