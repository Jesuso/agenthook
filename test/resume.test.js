import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook resume` — the pure command builder: a session's step `bin`/`env` (#357) pick the
// binary it resumes with, and env values are never printed (only the keys).
import test from "node:test";
import assert from "node:assert/strict";
import { resumeCommand, drainedReason } from "../src/commands/resume.js";

const cfg = /** @type {any} */ ({
  claudeBin: "claude",
  pipeline: [{ id: "triage" }, { id: "code", bin: "/opt/claude-local", env: { API_KEY: "sk-SECRET", CLAUDE_CONFIG_DIR: "/x" } }],
});

test("resumeCommand: a step without bin uses cfg.claudeBin and the claude adapter's own env (bg-wait ceiling)", () => {
  const c = resumeCommand(cfg, { id: "s1", step: "triage" }, "/wt/12");
  assert.deepEqual(c, {
    bin: "claude",
    env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" },
    line: "cd /wt/12 && CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 claude -r s1   # triage",
    envNote: null,
  });
});

test("resumeCommand: the session's step bin is printed; its env is passed for --exec but only its keys are shown", () => {
  const c = resumeCommand(cfg, { id: "s2", step: "code" }, "/wt/12");
  assert.equal(c.bin, "/opt/claude-local");
  assert.equal(c.line, "cd /wt/12 && CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 /opt/claude-local -r s2   # code");
  assert.deepEqual(c.env, { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0", API_KEY: "sk-SECRET", CLAUDE_CONFIG_DIR: "/x" });
  assert.match(String(c.envNote), /API_KEY, CLAUDE_CONFIG_DIR/);
  assert.doesNotMatch(c.line + c.envNote, /sk-SECRET|\/x\b/);
});

test("resumeCommand: an unknown step (renamed since) falls back to cfg.claudeBin", () => {
  assert.equal(resumeCommand(cfg, { id: "s3", step: "?" }, "/wt").bin, "claude");
});

test("drainedReason: claude and cursor (they keep transcripts) find the session by cwd", () => {
  assert.equal(drainedReason(cfg, { id: "s1", step: "triage" }), "claude finds the session by its working directory");
  assert.equal(drainedReason({ ...cfg, pipeline: [{ id: "triage", agent: "cursor" }] }, { id: "s1", step: "triage" }), "cursor finds the session by its working directory");
});

test("drainedReason: opencode (no transcripts, resumes from usage.jsonl) just needs to run in the worktree — never says claude", () => {
  const reason = drainedReason({ ...cfg, pipeline: [{ id: "triage", agent: "opencode" }] }, { id: "s1", step: "triage" });
  assert.equal(reason, "opencode runs in the worktree");
  assert.doesNotMatch(reason, /claude/i);
});

test("drainedReason: an isolated hermes step names hermes and its own HERMES_HOME", () => {
  const c = { ...cfg, stateDir: "/state/dev", pipeline: [{ id: "triage", agent: "hermes" }] };
  const reason = drainedReason(c, { id: "s1", step: "triage" });
  assert.equal(reason, "hermes runs in the worktree; its session lives in HERMES_HOME=/state/dev/hermes-home, which the command sets");
});

test("resumeCommand: an agent without transcripts refuses with a plain message", async (t) => {
  const { AGENTS, getAgent } = await import("../src/agents/index.js");
  AGENTS.blind = { ...getAgent("claude"), describe: () => ({ name: "blind", stdout: "text" }), sessions: null };
  t.after(() => delete AGENTS.blind);
  const c = { ...cfg, pipeline: [{ id: "code", agent: "blind" }] };
  assert.throws(() => resumeCommand(c, { id: "s4", step: "code" }, "/wt"), /^Error: blind runs have no transcripts to follow\/resume$/);
  // the session's step picks the agent: a claude step of the same profile still resumes
  assert.equal(resumeCommand({ ...c, pipeline: [...c.pipeline, { id: "review" }] }, { id: "s5", step: "review" }, "/wt").line, "cd /wt && CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 claude -r s5   # review");
});
