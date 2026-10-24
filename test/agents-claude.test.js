import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The Claude agent adapter — pure-unit coverage (no real `claude` spawn): the argv builder
// (per-step --model / --effort passthrough, invalid-effort fallback), the stream-json parser,
// and the usage record / unpriced tagging. Moved verbatim from test/dispatch.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs, claudePolicyArgs, claudePermissionArgs, claudeSettingsGuardArgs, claude, createStreamParser, buildUsageRecord, isUnpriced } from "../src/agents/claude.js";

// stream-json + --verbose are always present (stdout is the parsed JSONL); they sit
// right after the prompt, ahead of the per-step --model/--effort/--dangerously flags.
const SJ = ["--output-format", "stream-json", "--verbose"];
// A non-fullAuto run with no cwd/verdictFile: the pinned mode and setting sources only (#476).
const PIN = ["--setting-sources", "user,project", "--permission-mode", "dontAsk"];

test("buildClaudeArgs: no model/effort -> prompt + stream-json flags + the pinned mode", () => {
  const args = buildClaudeArgs({ prompt: "hi" });
  assert.deepEqual(args, ["-p", "hi", ...SJ, ...PIN]);
});

test("buildClaudeArgs: effort set -> --effort after the stream-json flags", () => {
  const args = buildClaudeArgs({ prompt: "hi", effort: "low" });
  assert.deepEqual(args, ["-p", "hi", ...SJ, "--effort", "low", ...PIN]);
});

test("buildClaudeArgs: --effort pushed after --model", () => {
  const args = buildClaudeArgs({ prompt: "hi", model: "claude-opus-4-8", effort: "high" });
  assert.deepEqual(args, ["-p", "hi", ...SJ, "--model", "claude-opus-4-8", "--effort", "high", ...PIN]);
});

test("buildClaudeArgs: every valid effort level is accepted", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    assert.deepEqual(buildClaudeArgs({ prompt: "p", effort: level }), ["-p", "p", ...SJ, "--effort", level, ...PIN]);
  }
});

test("buildClaudeArgs: invalid effort dropped with a warn, no --effort flag", () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const args = buildClaudeArgs({ prompt: "hi", effort: "turbo" });
    assert.deepEqual(args, ["-p", "hi", ...SJ, ...PIN]);
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
    assert.deepEqual(args, ["-p", "hi", ...SJ, ...PIN]);
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

// --- step allow/deny policy (#475) ---

test("claudePolicyArgs: allow → dontAsk + cwd-scoped reads, both command forms, writable paths, then the verdict file", () => {
  assert.deepEqual(claudePolicyArgs({ allow: { commands: ["git", "npm test"], paths: ["src/**"] }, cwd: "/w", verdictFile: "/d/v.json" }), [
    "--permission-mode", "dontAsk", "--allowedTools", "Read(//w/**)", "Bash(git)", "Bash(git *)", "Bash(npm test)", "Bash(npm test *)", "Edit(//w/src/**)", "Edit(//d/v.json)",
  ]);
  // No allow.paths: only the verdict file is writable (a reviewer).
  assert.deepEqual(claudePolicyArgs({ allow: { commands: ["gh pr"] }, cwd: "/w", verdictFile: "/d/v.json" }), [
    "--permission-mode", "dontAsk", "--allowedTools", "Read(//w/**)", "Bash(gh pr)", "Bash(gh pr *)", "Edit(//d/v.json)",
  ]);
  assert.deepEqual(claudePolicyArgs({ cwd: "/w" }), []);
});

test("buildClaudeArgs: allow drops --dangerously-skip-permissions even under fullAuto (allow rules do nothing in bypass)", () => {
  const args = buildClaudeArgs({ prompt: "hi", model: "m", fullAuto: true, allow: { commands: ["git"] }, cwd: "/w", verdictFile: "/d/v.json" });
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.deepEqual(args, ["-p", "hi", ...SJ, "--model", "m", ...PIN, "--allowedTools", "Read(//w/**)", "Bash(git)", "Bash(git *)", "Edit(//d/v.json)", "--disallowedTools", "Edit(//w/.claude/settings.json)", "Edit(//w/.claude/settings.local.json)"]);
});

test("buildClaudeArgs: deny alone keeps fullAuto's bypass and appends --disallowedTools last", () => {
  const args = buildClaudeArgs({ prompt: "hi", fullAuto: true, deny: { commands: ["curl"], paths: [".env*"] }, cwd: "/w", verdictFile: "/d/v.json" });
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.deepEqual(args.slice(-5),["--disallowedTools", "Bash(curl)", "Bash(curl *)", "Read(//w/.env*)", "Edit(//w/.env*)"]);
});

test("buildClaudeArgs: fullAuto without a policy → argv unchanged by cwd/verdictFile", () => {
  assert.deepEqual(buildClaudeArgs({ prompt: "hi", model: "m", effort: "max", fullAuto: true, cwd: "/w", verdictFile: "/d/v.json" }), ["-p", "hi", ...SJ, "--model", "m", "--effort", "max", "--dangerously-skip-permissions"]);
});

test("buildClaudeArgs: not fullAuto, no policy → the pinned tail (verdict writable, settings files not)", () => {
  assert.deepEqual(buildClaudeArgs({ prompt: "hi", cwd: "/w", verdictFile: "/d/v.json" }), [
    "-p", "hi", ...SJ, ...PIN, "--allowedTools", "Edit(//d/v.json)", "--disallowedTools", "Edit(//w/.claude/settings.json)", "Edit(//w/.claude/settings.local.json)",
  ]);
});

// --- pinned permission mode (#476) ---

const GUARD = ["Edit(//w/.claude/settings.json)", "Edit(//w/.claude/settings.local.json)"];
const DENY = { commands: ["curl"], paths: [".env*"] };
const DENY_RULES = ["Bash(curl)", "Bash(curl *)", "Read(//w/.env*)", "Edit(//w/.env*)"];

test("claudePermissionArgs: not fullAuto → pinned dontAsk, the verdict file allowed, the settings files denied", () => {
  assert.deepEqual(claudePermissionArgs({ fullAuto: false, cwd: "/w", verdictFile: "/d/v.json" }), [
    "--setting-sources", "user,project", "--permission-mode", "dontAsk", "--allowedTools", "Edit(//d/v.json)", "--disallowedTools", "Edit(//w/.claude/settings.json)", "Edit(//w/.claude/settings.local.json)",
  ]);
});

test("claudePermissionArgs: fullAuto bypass is byte-identical — the skip flag, plus only #475's deny group", () => {
  assert.deepEqual(claudePermissionArgs({ fullAuto: true, cwd: "/w", verdictFile: "/d/v.json" }), ["--dangerously-skip-permissions"]);
  assert.deepEqual(claudePermissionArgs({ fullAuto: true, deny: DENY, cwd: "/w", verdictFile: "/d/v.json" }), ["--dangerously-skip-permissions", "--disallowedTools", ...DENY_RULES]);
});

test("claudePermissionArgs: allow (either fullAuto) → pinned, one --disallowedTools with deny + settings-file rules", () => {
  for (const fullAuto of [true, false]) {
    const plain = claudePermissionArgs({ fullAuto, allow: { commands: ["git"] }, cwd: "/w", verdictFile: "/d/v.json" });
    assert.ok(!plain.includes("--dangerously-skip-permissions"));
    assert.deepEqual(plain, [...PIN, "--allowedTools", "Read(//w/**)", "Bash(git)", "Bash(git *)", "Edit(//d/v.json)", "--disallowedTools", ...GUARD]);
    const both = claudePermissionArgs({ fullAuto, allow: { commands: ["git"] }, deny: DENY, cwd: "/w", verdictFile: "/d/v.json" });
    assert.deepEqual(both.slice(0, 2), ["--setting-sources", "user,project"]);
    assert.equal(both.filter((a) => a === "--disallowedTools").length, 1);
    assert.deepEqual(both.slice(both.indexOf("--disallowedTools") + 1), [...DENY_RULES, ...GUARD]);
  }
});

test("claudePermissionArgs: not fullAuto + deny only → the pinned tail, deny and settings-file rules in one group", () => {
  assert.deepEqual(claudePermissionArgs({ fullAuto: false, deny: DENY, cwd: "/w", verdictFile: "/d/v.json" }), [
    ...PIN, "--allowedTools", "Edit(//d/v.json)", "--disallowedTools", ...DENY_RULES, ...GUARD,
  ]);
});

test("claudePermissionArgs: no cwd → no settings-file rules; no verdictFile → no verdict rule (empty flags omitted)", () => {
  assert.deepEqual(claudePermissionArgs({ cwd: "/w" }), [...PIN, "--disallowedTools", ...GUARD]);
  assert.deepEqual(claudePermissionArgs({ verdictFile: "/d/v.json" }), [...PIN, "--allowedTools", "Edit(//d/v.json)"]);
  assert.deepEqual(claudePermissionArgs({}), PIN);
  assert.deepEqual(claudeSettingsGuardArgs({}), { sources: ["--setting-sources", "user,project"], disallow: [] });
  assert.deepEqual(claudeSettingsGuardArgs({ cwd: "/w" }).disallow, GUARD);
});

test("claude adapter declares it enforces both policies", () => {
  assert.deepEqual(claude.describe().policy, { allow: true, deny: true });
});

test("claude adapter env: disables the background-wait kill ceiling; a step env still wins (layered after)", () => {
  assert.deepEqual(claude.env({ cfg: {}, step: undefined }), { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" });
  const merged = { ...claude.env({ cfg: {}, step: {} }), ...{ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "60000" } };
  assert.equal(merged.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, "60000");
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

test("createStreamParser: a second result event sums usage/duration, keeps the latest session_id and cumulative cost", () => {
  const p = createStreamParser();
  p.push(JSON.stringify({ type: "result", session_id: "sess-1", duration_ms: 600000, total_cost_usd: 10, usage: { input_tokens: 500, output_tokens: 1000, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } }) + "\n");
  p.push(JSON.stringify({ type: "result", session_id: "sess-2", duration_ms: 3476, total_cost_usd: 22.29, usage: { input_tokens: 50, output_tokens: 115, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } }) + "\n");
  assert.equal(p.result.session_id, "sess-2");
  assert.equal(p.result.total_cost_usd, 22.29);
  assert.equal(p.result.duration_ms, 603476);
  assert.equal(p.result.usage.output_tokens, 1115);
  assert.equal(p.result.usage.input_tokens, 550);
  assert.equal(p.result.usage.cache_read_input_tokens, 105);
  assert.equal(p.result.usage.cache_creation_input_tokens, 12);
  assert.deepEqual(p.tally, { input: 550, output: 1115, cacheRead: 105, cacheCreate: 12 });
  const rec = buildUsageRecord({ ref: "1", stepId: "code", startedAt: "a", endedAt: "b", result: p.result });
  assert.equal(rec.output, 1115);
  assert.equal(rec.durationMs, 603476);
  assert.equal(rec.costUsd, 22.29);
  assert.equal(rec.sessionId, "sess-2");
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
    assert.deepEqual(got.env, { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_TMPDIR: "/home/agent/.tmp" });
    // A cwd the run doesn't own (no worktree: the main checkout) never mounts the host's dir for
    // it (the operator's sessions + auto-memory) — a receiver-owned one under the state dir instead.
    const shared = sbx({ cfg: /** @type {any} */ ({ stateDir }), step: { id: "triage" }, cwd: "/w/repo", ownsCwd: false, home: "/home/agent" });
    assert.deepEqual(shared.mounts, [{ path: pathm.join(stateDir, "sandbox-transcripts", "-w-repo"), dst: "/home/agent/.claude/projects/-w-repo" }]);
    assert.ok(!shared.mounts.some((m) => m.path.startsWith(pathm.join(home, ".claude"))));
    assert.ok(fsm.statSync(shared.mounts[0].path).isDirectory());
    assert.deepEqual(shared.env, { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_TMPDIR: "/home/agent/.tmp" });
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
