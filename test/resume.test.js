import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook resume` — the pure command builder: a session's step `bin`/`env` (#357) pick the
// binary it resumes with, and env values are never printed (only the keys).
import test from "node:test";
import assert from "node:assert/strict";
import { resumeCommand } from "../src/commands/resume.js";

const cfg = /** @type {any} */ ({
  claudeBin: "claude",
  pipeline: [{ id: "triage" }, { id: "code", bin: "/opt/claude-local", env: { API_KEY: "sk-SECRET", CLAUDE_CONFIG_DIR: "/x" } }],
});

test("resumeCommand: a step without bin uses cfg.claudeBin and no env", () => {
  const c = resumeCommand(cfg, { id: "s1", step: "triage" }, "/wt/12");
  assert.deepEqual(c, { bin: "claude", env: undefined, line: "cd /wt/12 && claude -r s1   # triage", envNote: null });
});

test("resumeCommand: the session's step bin is printed; its env is passed for --exec but only its keys are shown", () => {
  const c = resumeCommand(cfg, { id: "s2", step: "code" }, "/wt/12");
  assert.equal(c.bin, "/opt/claude-local");
  assert.equal(c.line, "cd /wt/12 && /opt/claude-local -r s2   # code");
  assert.deepEqual(c.env, { API_KEY: "sk-SECRET", CLAUDE_CONFIG_DIR: "/x" });
  assert.match(String(c.envNote), /API_KEY, CLAUDE_CONFIG_DIR/);
  assert.doesNotMatch(c.line + c.envNote, /sk-SECRET|\/x\b/);
});

test("resumeCommand: an unknown step (renamed since) falls back to cfg.claudeBin", () => {
  assert.equal(resumeCommand(cfg, { id: "s3", step: "?" }, "/wt").bin, "claude");
});
