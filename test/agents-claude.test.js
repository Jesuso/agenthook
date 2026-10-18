import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The Claude agent adapter — pure-unit coverage (no real `claude` spawn): the argv builder
// (per-step --model / --effort passthrough, invalid-effort fallback), the stream-json parser,
// and the usage record / unpriced tagging. Moved verbatim from test/dispatch.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs, createStreamParser, buildUsageRecord, isUnpriced } from "../src/agents/claude.js";

// stream-json + --verbose are always present (stdout is the parsed JSONL); they sit
// right after the prompt, ahead of the per-step --model/--effort/--dangerously flags.
const SJ = ["--output-format", "stream-json", "--verbose"];

test("buildClaudeArgs: no model/effort -> prompt + stream-json flags", () => {
  const args = buildClaudeArgs({ prompt: "hi" });
  assert.deepEqual(args, ["-p", "hi", ...SJ]);
});

test("buildClaudeArgs: effort set -> --effort after the stream-json flags", () => {
  const args = buildClaudeArgs({ prompt: "hi", effort: "low" });
  assert.deepEqual(args, ["-p", "hi", ...SJ, "--effort", "low"]);
});

test("buildClaudeArgs: --effort pushed after --model", () => {
  const args = buildClaudeArgs({ prompt: "hi", model: "claude-opus-4-8", effort: "high" });
  assert.deepEqual(args, ["-p", "hi", ...SJ, "--model", "claude-opus-4-8", "--effort", "high"]);
});

test("buildClaudeArgs: every valid effort level is accepted", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(buildClaudeArgs({ prompt: "p", effort: level }), ["-p", "p", ...SJ, "--effort", level]);
  }
});

test("buildClaudeArgs: invalid effort dropped with a warn, no --effort flag", () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const args = buildClaudeArgs({ prompt: "hi", effort: "turbo" });
    assert.deepEqual(args, ["-p", "hi", ...SJ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /invalid effort "turbo"/);
  } finally {
    console.warn = orig;
  }
});

test("buildClaudeArgs: provider is ignored with a warn, argv unchanged", () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const args = buildClaudeArgs({ prompt: "hi", provider: "ollama-launch" });
    assert.deepEqual(args, ["-p", "hi", ...SJ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ignoring provider "ollama-launch"/);
  } finally {
    console.warn = orig;
  }
});

test("buildClaudeArgs: fullAuto adds --dangerously-skip-permissions last", () => {
  const args = buildClaudeArgs({ prompt: "hi", model: "m", effort: "max", fullAuto: true });
  assert.deepEqual(args, ["-p", "hi", ...SJ, "--model", "m", "--effort", "max", "--dangerously-skip-permissions"]);
});

// --- stream-json parser: log rendering + token tally + result capture ---

const fixtureLines = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Looking at the code." }], usage: { input_tokens: 100, output_tokens: 12 } },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Done." },
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
      ],
      usage: { input_tokens: 250, output_tokens: 8 },
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "sess-1",
    duration_ms: 4200,
    total_cost_usd: 0.0321,
    usage: { input_tokens: 250, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 30 },
    modelUsage: { "claude-opus-4-8": { costUSD: 0.0321 } },
  }),
];

test("createStreamParser: renders assistant text only (no raw JSON), captures result + tally", () => {
  const p = createStreamParser();
  const log = fixtureLines.map((l) => p.push(l + "\n")).join("");
  assert.equal(log, "Looking at the code.\nDone.\n", "only text blocks, no tool_use or raw JSON");
  assert.ok(p.result, "result event captured");
  assert.equal(p.result.session_id, "sess-1");
  // final tally mirrors result.usage (output replaced, not summed); cache fields from result event
  assert.deepEqual(p.tally, { input: 250, output: 20, cacheRead: 1000, cacheCreate: 30 });
});

test("createStreamParser: tally grows across assistant events before the result", () => {
  const p = createStreamParser();
  p.push(fixtureLines[0] + "\n");
  assert.deepEqual(p.tally, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  p.push(fixtureLines[1] + "\n");
  assert.deepEqual(p.tally, { input: 100, output: 12, cacheRead: 0, cacheCreate: 0 });
  p.push(fixtureLines[2] + "\n"); // output sums (12+8), input tracks latest turn
  assert.deepEqual(p.tally, { input: 250, output: 20, cacheRead: 0, cacheCreate: 0 });
});

test("createStreamParser: tolerates lines split across chunk boundaries", () => {
  const p = createStreamParser();
  const whole = fixtureLines.join("\n") + "\n";
  // feed one char at a time — no line should be parsed until its newline arrives
  let log = "";
  for (const ch of whole) log += p.push(ch);
  assert.equal(log, "Looking at the code.\nDone.\n");
  assert.deepEqual(p.tally, { input: 250, output: 20, cacheRead: 1000, cacheCreate: 30 });
  assert.equal(p.result.total_cost_usd, 0.0321);
});

test("createStreamParser: skips non-JSON lines without crashing", () => {
  const p = createStreamParser();
  let log = "";
  log += p.push("not json at all\n");
  log += p.push(fixtureLines[1] + "\n");
  log += p.push("{ broken json\n");
  assert.equal(log, "Looking at the code.\n");
  assert.deepEqual(p.tally, { input: 100, output: 12, cacheRead: 0, cacheCreate: 0 });
});

test("createStreamParser: flush() processes a final line with no trailing newline", () => {
  const p = createStreamParser();
  p.push(fixtureLines[1]); // no newline — stays buffered
  assert.deepEqual(p.tally, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, "unterminated line not parsed yet");
  const tail = p.flush();
  assert.equal(tail, "Looking at the code.\n");
  assert.deepEqual(p.tally, { input: 100, output: 12, cacheRead: 0, cacheCreate: 0 });
});

test("createStreamParser: cache_read/cache_creation tokens captured in tally from result event", () => {
  const p = createStreamParser();
  for (const l of fixtureLines) p.push(l + "\n");
  // result event has cache_read=1000, cache_creation=30 → tally reflects them
  assert.equal(p.tally.cacheRead, 1000);
  assert.equal(p.tally.cacheCreate, 30);
});

test("createStreamParser: cache tokens from assistant event tracked live before result", () => {
  const cacheAssistant = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "Hi." }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 500000, cache_creation_input_tokens: 20000 },
    },
  });
  const p = createStreamParser();
  p.push(cacheAssistant + "\n");
  assert.equal(p.tally.cacheRead, 500000);
  assert.equal(p.tally.cacheCreate, 20000);
});

test("buildUsageRecord: extracts totals/cost/session from the result event", () => {
  const p = createStreamParser();
  for (const l of fixtureLines) p.push(l + "\n");
  const rec = buildUsageRecord({
    ref: "56",
    stepId: "code",
    model: undefined, // no explicit --model -> derive from modelUsage
    startedAt: "2026-06-30T00:00:00.000Z",
    endedAt: "2026-06-30T00:01:00.000Z",
    result: p.result,
  });
  assert.deepEqual(rec, {
    ref: "56",
    stepId: "code",
    model: "claude-opus-4-8",
    startedAt: "2026-06-30T00:00:00.000Z",
    endedAt: "2026-06-30T00:01:00.000Z",
    durationMs: 4200,
    input: 250,
    output: 20,
    cacheRead: 1000,
    cacheCreate: 30,
    costUsd: 0.0321,
    sessionId: "sess-1",
  });
});

test("buildUsageRecord: explicit step model wins over modelUsage key", () => {
  const rec = buildUsageRecord({
    ref: "1",
    stepId: "code",
    model: "claude-sonnet-5",
    startedAt: "a",
    endedAt: "b",
    result: { usage: {}, modelUsage: { "claude-opus-4-8": {} } },
  });
  assert.equal(rec.model, "claude-sonnet-5");
  assert.deepEqual([rec.input, rec.output, rec.cacheRead, rec.cacheCreate], [0, 0, 0, 0]);
});

// --- isUnpriced / unpriced usage records (local models) ---

test("isUnpriced: Claude models and the CLI default are priced", () => {
  assert.equal(isUnpriced({}), false, "unset model + no bin");
  for (const model of ["claude-sonnet-4-5", "opus", "sonnet[1m]", "Haiku", "default", "opusplan", "best", "us.anthropic.claude-sonnet-4-5-v1:0", "claude-opus-4-1@20250805"]) {
    assert.equal(isUnpriced({ model }), false, model);
  }
});

test("isUnpriced: non-Claude models are unpriced", () => {
  for (const model of ["qwen3-coder", "llama3", "gpt-oss:20b", "sonnet-ish"]) assert.equal(isUnpriced({ model }), true, model);
});

test("isUnpriced: a bin other than claudeBin is unpriced even on a Claude model; the same bin is not", () => {
  assert.equal(isUnpriced({ model: "claude-sonnet-4-5", bin: "claude-local", claudeBin: "claude" }), true);
  assert.equal(isUnpriced({ bin: "claude-local", claudeBin: "claude" }), true);
  assert.equal(isUnpriced({ model: "opus", bin: "claude", claudeBin: "claude" }), false);
});

test("buildUsageRecord: a priced record has no bin/unpriced keys", () => {
  const rec = buildUsageRecord({ ref: "1", stepId: "code", bin: "claude", claudeBin: "claude", startedAt: "a", endedAt: "b", result: { usage: {}, total_cost_usd: 0.5, modelUsage: { "claude-opus-4-8": {} } } });
  assert.equal("bin" in rec, false);
  assert.equal("unpriced" in rec, false);
  assert.equal(rec.costUsd, 0.5);
});

test("buildUsageRecord: an unpriced record is tagged and keeps its raw cost (audit)", () => {
  const byModel = buildUsageRecord({ ref: "1", stepId: "triage", claudeBin: "claude", startedAt: "a", endedAt: "b", result: { usage: { input_tokens: 9 }, total_cost_usd: 0.5, modelUsage: { "qwen3-coder": {} } } });
  assert.equal(byModel.unpriced, true);
  assert.equal("bin" in byModel, false);
  assert.equal(byModel.input, 9);
  assert.equal(byModel.costUsd, 0.5);
  const byBin = buildUsageRecord({ ref: "1", stepId: "triage", model: "sonnet", bin: "claude-local", claudeBin: "claude", startedAt: "a", endedAt: "b", result: { usage: {} } });
  assert.equal(byBin.unpriced, true);
  assert.equal(byBin.bin, "claude-local");
});

test("claude sandbox hook: only this cwd's transcript dir (receiver-owned for a cwd it doesn't own), at the container HOME's projects path; no-autoupdate env", async () => {
  const { claude: adapter, sandboxCredentialProblem } = await import("../src/agents/claude.js");
  const os = await import("node:os");
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  const home = fsm.mkdtempSync(pathm.join(os.tmpdir(), "ah-claude-sbx-"));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const sbx = /** @type {NonNullable<typeof adapter.sandbox>} */ (adapter.sandbox);
    const stateDir = pathm.join(home, "state");
    const got = sbx({ cfg: /** @type {any} */ ({ stateDir }), step: { id: "code" }, cwd: "/w/agenthook-worktrees/42", ownsCwd: true, home: "/home/agent" });
    assert.deepEqual(got.mounts, [{ path: pathm.join(home, ".claude", "projects", "-w-agenthook-worktrees-42"), dst: "/home/agent/.claude/projects/-w-agenthook-worktrees-42" }]);
    assert.ok(fsm.statSync(got.mounts[0].path).isDirectory(), "created on the host first");
    assert.deepEqual(got.env, { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    // A cwd the run doesn't own (no worktree: the main checkout) never mounts the host's dir for
    // it (the operator's sessions + auto-memory) — a receiver-owned one under the state dir instead.
    const shared = sbx({ cfg: /** @type {any} */ ({ stateDir }), step: { id: "triage" }, cwd: "/w/repo", ownsCwd: false, home: "/home/agent" });
    assert.deepEqual(shared.mounts, [{ path: pathm.join(stateDir, "sandbox-transcripts", "-w-repo"), dst: "/home/agent/.claude/projects/-w-repo" }]);
    assert.ok(!shared.mounts.some((m) => m.path.startsWith(pathm.join(home, ".claude"))));
    assert.ok(fsm.statSync(shared.mounts[0].path).isDirectory());
    assert.equal(adapter.sessions?.sandboxTranscriptDir?.(stateDir, "/w/repo"), shared.mounts[0].path, "follow reads where it was written");
  } finally {
    process.env.HOME = saved;
  }
  const pre = /** @type {NonNullable<typeof adapter.preflight>} */ (adapter.preflight);
  assert.equal(pre({ cfg: /** @type {any} */ ({}), step: { id: "code" }, sandboxed: false, env: {} }), undefined, "unsandboxed: the host login works");
  assert.match(pre({ cfg: /** @type {any} */ ({}), step: { id: "code" }, sandboxed: true, env: {} }) ?? "", /claude setup-token/);
  assert.equal(pre({ cfg: /** @type {any} */ ({}), step: { id: "code" }, sandboxed: true, env: { ANTHROPIC_API_KEY: "k" } }), undefined);
  assert.equal(sandboxCredentialProblem({ CLAUDE_CODE_USE_BEDROCK: "1" }), undefined);
});
