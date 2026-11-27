import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Unit tests for the run-turns.js turn runners pulled out of step.js's runStep (#864):
// spawnOptions (the three spawnAgent() option variants) and verdict.js's peekVerdict/
// isNoValidVerdict (the guarded-read pair every turn runner shares).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnOptions } from "../src/dispatch/run-turns.js";
import { peekVerdict, isNoValidVerdict, NO_VALID_VERDICT } from "../src/dispatch/verdict.js";

/** @type {any} */
const baseRc = {
  agent: { describe: () => ({ name: "claude" }) },
  cwd: "/tmp/cwd",
  logPath: "/tmp/run.log",
  promptFile: undefined,
  model: "opus",
  effort: "high",
  provider: "anthropic",
  step: { isolated: true, allow: ["Bash"], deny: ["Edit"], idleMinutes: undefined },
  spawnStep: { toolsets: ["git"], bin: "claude" },
  agentEnv: { FOO: "bar" },
  creds: null,
  verdictFile: "/tmp/verdict.json",
  sandboxedRun: undefined,
  executor: { name: "host" },
  onPid: () => {},
  onTally: () => {},
};

test("spawnOptions: the first turn passes no resumeSessionId key at all (absent, not undefined)", () => {
  const opts = spawnOptions(baseRc, { prompt: "p", maxMs: 123000 });
  assert.equal(opts.prompt, "p");
  assert.equal(opts.maxMs, 123000);
  assert.ok(!("resumeSessionId" in opts), "resumeSessionId must be absent, not just undefined");
  assert.equal(opts.toolsets, baseRc.spawnStep.toolsets);
  assert.equal(opts.isolated, true);
  assert.equal(opts.allow, baseRc.step.allow);
  assert.equal(opts.deny, baseRc.step.deny);
  assert.equal(opts.bin, "claude");
  assert.equal(opts.agentEnv, baseRc.agentEnv);
  assert.equal(opts.env, undefined); // spawnStep.env was never set here
  assert.equal(opts.verdictFile, baseRc.verdictFile);
  assert.equal(opts.sandboxed, baseRc.sandboxedRun);
  assert.equal(opts.executor, baseRc.executor);
});

test("spawnOptions: a verdict-repair turn always carries resumeSessionId", () => {
  const opts = spawnOptions(baseRc, { prompt: "repair", maxMs: 0, resumeSessionId: "sess-1" });
  assert.equal(opts.resumeSessionId, "sess-1");
  assert.equal(opts.maxMs, 0);
});

test("spawnOptions: a gate-repair turn omits resumeSessionId when it can't resume (canResume false)", () => {
  const opts = spawnOptions(baseRc, { prompt: "gate-repair", maxMs: 5000, resumeSessionId: undefined });
  assert.ok(!("resumeSessionId" in opts), "resumeSessionId must be absent when canResume is false");
});

test("spawnOptions: step.idleMinutes becomes idleMs only when set", () => {
  const withIdle = { ...baseRc, step: { ...baseRc.step, idleMinutes: 5 } };
  assert.equal(spawnOptions(withIdle, { prompt: "p", maxMs: 1 }).idleMs, 300000);
  assert.ok(!("idleMs" in spawnOptions(baseRc, { prompt: "p", maxMs: 1 })));
});

// --- peekVerdict / isNoValidVerdict ---

test("peekVerdict: the sandbox guard (oversize file removal) runs only for a non-host executor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-peek-verdict-"));
  const verdictFile = path.join(dir, "verdict.json");
  // Bigger than MAX_SANDBOX_VERDICT_BYTES (1 MiB) — guardSandboxVerdict rm's it, a host read
  // never looks at the size at all.
  fs.writeFileSync(verdictFile, "x".repeat(1024 * 1024 + 1));
  const readVerdict = (code, file) => ({ outcome: fs.existsSync(file) ? "advance" : "hold", reason: fs.existsSync(file) ? undefined : NO_VALID_VERDICT });

  const hostRc = { executor: { name: "host" }, localVerdictFile: verdictFile, step: {}, agent: {}, readVerdict };
  assert.equal(peekVerdict(hostRc, 0).outcome, "advance", "host never guards — the oversize file survives");
  assert.ok(fs.existsSync(verdictFile));

  const sandboxRc = { ...hostRc, executor: { name: "sandbox" } };
  assert.equal(peekVerdict(sandboxRc, 0).outcome, "hold", "sandbox guards — the oversize file is removed first");
  assert.ok(!fs.existsSync(verdictFile));
});

test("isNoValidVerdict: true only for hold + NO_VALID_VERDICT, false for every other verdict", () => {
  assert.equal(isNoValidVerdict({ outcome: "hold", reason: NO_VALID_VERDICT }), true);
  assert.equal(isNoValidVerdict({ outcome: "hold", reason: "something else" }), false);
  assert.equal(isNoValidVerdict({ outcome: "advance" }), false);
  assert.equal(isNoValidVerdict({ outcome: "fail", reason: NO_VALID_VERDICT }), false);
});
