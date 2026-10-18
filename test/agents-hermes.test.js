import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The Hermes agent adapter — pure-unit coverage (no real `hermes` spawn): argv (incl. the
// promptFile requirement), the stderr-driven session-id parser, the always-unpriced usage
// record, and the adapter's describe/defaults.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHermesArgs, createHermesParser, buildHermesUsageRecord, hermes, HERMES_MAX_TURNS, HERMES_REASONING_LEVELS } from "../src/agents/hermes.js";

/** Capture console.warn while fn runs. @param {() => void} fn */
function warns(fn) {
  /** @type {string[]} */
  const out = [];
  const orig = console.warn;
  console.warn = (m) => out.push(m);
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return out;
}

test("buildHermesArgs: no model, no fullAuto", () => {
  assert.deepEqual(buildHermesArgs({ prompt: "hi", promptFile: "/tmp/p.md", isolated: false }), ["chat", "-Q", "--max-turns", String(HERMES_MAX_TURNS), "--query-file", "/tmp/p.md"]);
});

test("buildHermesArgs: model appends -m; --yolo only under fullAuto", () => {
  assert.deepEqual(buildHermesArgs({ prompt: "hi", promptFile: "/tmp/p.md", isolated: false, model: "hermes-4" }), [
    "chat",
    "-Q",
    "--max-turns",
    String(HERMES_MAX_TURNS),
    "--query-file",
    "/tmp/p.md",
    "-m",
    "hermes-4",
  ]);
  assert.deepEqual(buildHermesArgs({ prompt: "hi", promptFile: "/tmp/p.md", isolated: false, fullAuto: true }), [
    "chat",
    "-Q",
    "--yolo",
    "--max-turns",
    String(HERMES_MAX_TURNS),
    "--query-file",
    "/tmp/p.md",
  ]);
});

test("buildHermesArgs: valid effort maps to --reasoning", () => {
  for (const effort of HERMES_REASONING_LEVELS) {
    assert.deepEqual(
      warns(() => assert.deepEqual(buildHermesArgs({ prompt: "hi", promptFile: "/tmp/p.md", isolated: false, effort }), ["chat", "-Q", "--max-turns", String(HERMES_MAX_TURNS), "--query-file", "/tmp/p.md", "--reasoning", effort])),
      []
    );
  }
});

test("buildHermesArgs: out-of-set effort is dropped + warned, no effort = no flag", () => {
  /** @type {string[]} */
  let args = [];
  const w = warns(() => (args = buildHermesArgs({ prompt: "hi", promptFile: "/tmp/p.md", isolated: false, effort: "bogus" })));
  assert.deepEqual(args, ["chat", "-Q", "--max-turns", String(HERMES_MAX_TURNS), "--query-file", "/tmp/p.md"]);
  assert.equal(w.length, 1);
  assert.match(w[0], /invalid effort "bogus"/);
  assert.deepEqual(warns(() => buildHermesArgs({ prompt: "hi", promptFile: "/tmp/p.md", isolated: false })), []);
});

test("buildHermesArgs: provider appends --provider", () => {
  assert.deepEqual(buildHermesArgs({ prompt: "hi", promptFile: "/tmp/p.md", isolated: false, model: "qwen3.8:27b-96k", provider: "ollama-launch" }), [
    "chat",
    "-Q",
    "--max-turns",
    String(HERMES_MAX_TURNS),
    "--query-file",
    "/tmp/p.md",
    "-m",
    "qwen3.8:27b-96k",
    "--provider",
    "ollama-launch",
  ]);
});

test("buildHermesArgs: maxMs maps to --run-budget in whole seconds, floored to at least 1; unset/0 = no flag", () => {
  assert.deepEqual(buildHermesArgs({ prompt: "hi", promptFile: "/tmp/p.md", isolated: false, maxMs: 7_200_000 }), ["chat", "-Q", "--max-turns", String(HERMES_MAX_TURNS), "--query-file", "/tmp/p.md", "--run-budget", "7200"]);
  assert.deepEqual(buildHermesArgs({ prompt: "hi", promptFile: "/tmp/p.md", isolated: false, maxMs: 500 }), ["chat", "-Q", "--max-turns", String(HERMES_MAX_TURNS), "--query-file", "/tmp/p.md", "--run-budget", "1"]);
  assert.deepEqual(buildHermesArgs({ prompt: "hi", promptFile: "/tmp/p.md", isolated: false, maxMs: 0 }), ["chat", "-Q", "--max-turns", String(HERMES_MAX_TURNS), "--query-file", "/tmp/p.md"]);
  assert.deepEqual(buildHermesArgs({ prompt: "hi", promptFile: "/tmp/p.md", isolated: false }), ["chat", "-Q", "--max-turns", String(HERMES_MAX_TURNS), "--query-file", "/tmp/p.md"]);
});

test("buildHermesArgs: throws without promptFile — a dispatch bug, not a user error", () => {
  assert.throws(() => buildHermesArgs({ prompt: "hi" }), /promptFile/);
});

test("parser: stdout text passes through unchanged; tally stays all zeros", () => {
  const p = createHermesParser();
  const out = p.push("hello ") + p.push("world\n") + p.flush();
  assert.equal(out, "hello world\n");
  assert.deepEqual(p.tally, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  assert.equal(p.result, null);
  assert.equal(p.sessionId, undefined);
});

test("parser: session_id on stderr sets sessionId/result, even split across chunks", () => {
  const p = createHermesParser();
  p.pushStderr("some log line\nsession_id: abc-123\nmore log\n");
  assert.equal(p.sessionId, "abc-123");
  assert.deepEqual(p.result, { session_id: "abc-123" });
});

test("parser: session_id split across two stderr chunks is still captured", () => {
  const p = createHermesParser();
  p.pushStderr("prefix session_id: ab");
  p.pushStderr("c-456\n");
  assert.equal(p.sessionId, "abc-456");
});

test("parser: first session_id wins; garbage stderr never throws", () => {
  const p = createHermesParser();
  assert.doesNotThrow(() => p.pushStderr("\0\0 not utf8-friendly junk \n"));
  p.pushStderr("session_id: first\n");
  p.pushStderr("session_id: second\n");
  assert.equal(p.sessionId, "first");
});

test("usage record: always unpriced, zero tokens, no costUsd; bin tagged only when it overrides agent", () => {
  const ctx = { ref: "7", stepId: "code", startedAt: "s", endedAt: "e" };
  const rec = buildHermesUsageRecord({ ...ctx, result: { session_id: "sid-1" } });
  assert.deepEqual(rec, {
    ref: "7",
    stepId: "code",
    model: "hermes",
    startedAt: "s",
    endedAt: "e",
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    costUsd: undefined,
    sessionId: "sid-1",
    unpriced: true,
  });
  assert.equal(buildHermesUsageRecord({ ...ctx, result: null }).sessionId, undefined);
  assert.equal(buildHermesUsageRecord({ ...ctx, model: "hermes-4", result: null }).model, "hermes-4");
  assert.equal(buildHermesUsageRecord({ ...ctx, bin: "hermes", result: null }).bin, undefined);
  assert.equal(buildHermesUsageRecord({ ...ctx, bin: "/opt/hermes-beta", result: null }).bin, "/opt/hermes-beta");
});

test("adapter: describe/defaults/sessions", () => {
  assert.deepEqual(hermes.describe(), { name: "hermes", stdout: "text", promptFile: true });
  assert.deepEqual(hermes.defaults, { bin: "hermes", requireVerdict: true });
  assert.equal(hermes.sessions, null);
});
