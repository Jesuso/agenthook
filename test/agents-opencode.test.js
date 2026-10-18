import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The OpenCode agent adapter — pure-unit coverage (no real `opencode` spawn): argv, the JSONL
// parser over a recorded run (test/fixtures/opencode-stream.jsonl, a real `opencode run --format
// json -m opencode/deepseek-v4.1-flash-free` capture, ids/paths anonymised, tool output trimmed),
// both pricing branches of the usage record, resume from usage.jsonl (no transcripts), and one
// end-to-end dispatch through a stand-in `opencode` script that replays the fixture.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-opencode-"));
process.env.HOME = HOME;
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { buildOpencodeArgs, createOpencodeParser, buildOpencodeUsageRecord, opencode } = await import("../src/agents/opencode.js");
const { AGENTS } = await import("../src/agents/index.js");
const { listSessions, agentSessions } = await import("../src/sessions.js");
const { resumeCommand, resumeArgs, lookedIn } = await import("../src/commands/resume.js");
const { transcriptDirs } = await import("../src/commands/follow.js");
const { worktreePath } = await import("../src/worktree.js");
const { claudeProjectDir } = await import("../src/paths.js");
const { createDispatcher } = await import("../src/dispatch.js");
const { createStore } = await import("../src/store.js");

const FIXTURE = fs.readFileSync(new URL("./fixtures/opencode-stream.jsonl", import.meta.url), "utf8");
// The same run on a paid provider: each step_finish reports its own cost.
const PRICED = FIXTURE.replace('"cost":0}', '"cost":0.25}').replace('"cost":0}', '"cost":0.5}');
const SID = "ses_00000000000000000000000001";

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

test("buildOpencodeArgs: run --format json, prompt last; no --auto/-m/--variant unless asked", () => {
  assert.deepEqual(buildOpencodeArgs({ prompt: "hi" }), ["run", "--format", "json", "hi"]);
});

test("buildOpencodeArgs: --auto only under fullAuto, -m provider/model, effort verbatim as --variant", () => {
  assert.deepEqual(buildOpencodeArgs({ prompt: "hi", model: "ollama/qwen3.8:27b-64k", effort: "max", fullAuto: true, maxMs: 60_000 }), [
    "run",
    "--format",
    "json",
    "--auto",
    "-m",
    "ollama/qwen3.8:27b-64k",
    "--variant",
    "max",
    "hi",
  ]);
});

test("buildOpencodeArgs: provider never reaches argv and is warned about", () => {
  /** @type {string[]} */
  let args = [];
  const w = warns(() => (args = buildOpencodeArgs({ prompt: "hi", provider: "ollama-launch" })));
  assert.deepEqual(args, ["run", "--format", "json", "hi"]);
  assert.equal(w.length, 1);
  assert.match(w[0], /provider "ollama-launch"/);
  assert.deepEqual(warns(() => buildOpencodeArgs({ prompt: "hi", effort: "high" })), []);
});

test("parser: recorded run → tool + text in the log, tally summed over steps, session id", () => {
  const p = createOpencodeParser();
  const log = p.push(FIXTURE) + p.flush();
  assert.equal(log, "🔧 read\nhello\n");
  // output = 45 + 13 summed; input/cache = the latest step's context
  assert.deepEqual(p.tally, { input: 108, output: 58, cacheRead: 8704, cacheCreate: 0 });
  assert.equal(p.sessionId, SID);
  assert.deepEqual(p.result, { session_id: SID, tokens: { input: 108, output: 58, cacheRead: 8704, cacheCreate: 0 }, cost: 0 });
});

test("parser: reasoning tokens count as output", () => {
  const p = createOpencodeParser();
  p.push(JSON.stringify({ type: "step_finish", sessionID: "s", part: { tokens: { input: 1, output: 2, reasoning: 30, cache: { read: 4, write: 5 } }, cost: 0 } }) + "\n");
  assert.deepEqual(p.tally, { input: 1, output: 32, cacheRead: 4, cacheCreate: 5 });
});

test("parser: a line split across chunks is buffered; one char at a time gives the same output", () => {
  const p = createOpencodeParser();
  let log = "";
  for (const ch of FIXTURE) log += p.push(ch);
  log += p.flush();
  assert.equal(log, "🔧 read\nhello\n");
  assert.equal(p.tally.output, 58);
  assert.equal(p.sessionId, SID);
});

test("parser: an unterminated final line is handled by flush", () => {
  const p = createOpencodeParser();
  assert.equal(p.push(FIXTURE.trimEnd()), "🔧 read\nhello\n");
  assert.equal(p.tally.output, 45, "the last step_finish waits for flush");
  assert.equal(p.flush(), "");
  assert.equal(p.tally.output, 58);
});

test("parser: unknown event types and non-JSON lines are ignored, never throw", () => {
  const p = createOpencodeParser();
  const out = p.push('not json\n{"type":"mystery","x":1}\n{"type":"text"}\n{"type":"text","part":{"text":5}}\n{"type":"tool_use","part":null}\n[1,2]\nnull\n{"type":"step_finish","part":{"tokens":"x","cost":"free"}}\n');
  assert.equal(out + p.flush(), "");
  assert.equal(p.sessionId, undefined);
  assert.deepEqual(p.tally, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
});

test("parser: result is null until an event, non-null from the first sessionID (so a killed run still records its session)", () => {
  const p = createOpencodeParser();
  assert.equal(p.result, null);
  p.push(FIXTURE.split("\n")[0] + "\n"); // step_start only
  assert.deepEqual(p.result, { session_id: SID, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, cost: 0 });
  const rec = opencode.usageRecord(p.result, { ref: "7", stepId: "code", startedAt: "s", endedAt: "e" });
  assert.equal(rec.sessionId, SID);
});

test("usage record: zero cost (local/free model) → unpriced, no costUsd; bin tagged only when it overrides opencode", () => {
  const p = createOpencodeParser();
  p.push(FIXTURE);
  const ctx = { ref: "7", stepId: "code", startedAt: "s", endedAt: "e" };
  const rec = buildOpencodeUsageRecord({ ...ctx, model: "ollama/qwen3.8:27b-64k", result: p.result });
  assert.deepEqual(rec, {
    ref: "7",
    stepId: "code",
    model: "ollama/qwen3.8:27b-64k",
    startedAt: "s",
    endedAt: "e",
    input: 108,
    output: 58,
    cacheRead: 8704,
    cacheCreate: 0,
    costUsd: undefined,
    sessionId: SID,
    unpriced: true,
  });
  assert.equal(buildOpencodeUsageRecord({ ...ctx, result: p.result }).model, "opencode");
  assert.equal(buildOpencodeUsageRecord({ ...ctx, bin: "opencode", result: p.result }).bin, undefined);
  assert.equal(buildOpencodeUsageRecord({ ...ctx, bin: "/opt/oc", result: p.result }).bin, "/opt/oc");
  const none = opencode.usageRecord(null, ctx);
  assert.deepEqual([none.input, none.output, none.costUsd, none.sessionId, none.unpriced], [0, 0, undefined, undefined, true]);
});

test("usage record: a non-zero summed cost → priced costUsd", () => {
  const p = createOpencodeParser();
  p.push(PRICED);
  assert.equal(p.result.cost, 0.75);
  const rec = opencode.usageRecord(p.result, { ref: "7", stepId: "code", startedAt: "s", endedAt: "e" });
  assert.equal(rec.costUsd, 0.75);
  assert.equal("unpriced" in rec, false);
});

test("adapter: describe, defaults, no transcripts but a top-level resume argv", () => {
  assert.deepEqual(opencode.describe(), { name: "opencode", stdout: "stream-json" });
  assert.deepEqual(opencode.defaults, { bin: "opencode" });
  assert.equal(opencode.sessions, null);
  assert.deepEqual(opencode.resumeCommand?.("ses_1"), ["-s", "ses_1"]);
  assert.throws(() => agentSessions(opencode), /^Error: opencode runs have no transcripts to follow$/);
});

/** @param {Partial<import('../src/types.js').UsageRecord>[]} recs */
const usageStore = (recs) => ({ getRepo: () => undefined, readUsage: () => /** @type {any[]} */ (recs) });

test("listSessions + resume: an all-opencode profile lists its usage.jsonl sessions and never throws", () => {
  const cfg = /** @type {any} */ ({ repoPath: "/o/solo", worktreePrefix: "/o/wt", agent: "opencode", claudeBin: "claude", logDir: path.join(HOME, "logs-o"), pipeline: [{ id: "triage" }, { id: "code" }, { id: "done", manual: true }] });
  const wt = worktreePath(cfg, "390");
  const store = usageStore([
    { ref: "390", stepId: "code", startedAt: "2026-10-18T10:05:00.000Z", sessionId: "ses_code" },
    { ref: "390", stepId: "triage", startedAt: "2026-10-18T10:00:00.000Z", sessionId: "ses_triage" },
    { ref: "390", stepId: "code", startedAt: "2026-10-18T10:09:00.000Z" }, // no session id: skipped
    { ref: "391", stepId: "code", startedAt: "2026-10-18T10:00:00.000Z", sessionId: "ses_other" },
  ]);
  const s = listSessions(cfg, "390", store);
  assert.deepEqual(
    s.map((x) => [x.id, x.step, x.agent, x.msgs, x.prompt]),
    [
      ["ses_triage", "triage", "opencode", 0, ""],
      ["ses_code", "code", "opencode", 0, ""],
    ],
  );
  assert.equal(s[0].at, Date.parse("2026-10-18T10:00:00.000Z"));
  assert.deepEqual(resumeArgs(cfg, s[1]), ["-s", "ses_code"]);
  assert.equal(resumeCommand(cfg, s[1], wt).line, `cd ${wt} && opencode -s ses_code   # code`);
  // no usage / no store: an empty list, not the "no transcripts" throw
  assert.deepEqual(listSessions(cfg, "390"), []);
  assert.equal(lookedIn(cfg, "390", store), "looked in usage.jsonl");
  // follow stays unsupported
  assert.throws(() => transcriptDirs(cfg, [{ id: "default", path: cfg.repoPath, match: [], default: true }]), /opencode runs have no transcripts to follow$/);
});

test("listSessions: an opencode step in a claude profile — transcripts + usage sessions merged by time; claude usage ignored", () => {
  const cfg = /** @type {any} */ ({ repoPath: "/p/solo", worktreePrefix: "/p/wt", claudeBin: "claude", logDir: path.join(HOME, "logs-p"), pipeline: [{ id: "triage" }, { id: "code", agent: "opencode" }] });
  const wt = worktreePath(cfg, "12");
  fs.mkdirSync(claudeProjectDir(wt), { recursive: true });
  const line = { type: "user", timestamp: "2026-10-18T09:00:00.000Z", message: { content: "=== TICKET === triage it" } };
  fs.writeFileSync(path.join(claudeProjectDir(wt), "cl-1.jsonl"), JSON.stringify(line) + "\n");
  const store = usageStore([
    { ref: "12", stepId: "triage", startedAt: "2026-10-18T09:00:00.000Z", sessionId: "cl-1" }, // claude: from its transcript
    { ref: "12", stepId: "code", startedAt: "2026-10-18T09:30:00.000Z", sessionId: "ses_c" },
  ]);
  const s = listSessions(cfg, "12", store);
  assert.deepEqual(
    s.map((x) => [x.id, x.agent]),
    [
      ["cl-1", "claude"],
      ["ses_c", "opencode"],
    ],
  );
  assert.deepEqual(resumeArgs(cfg, s[0]), ["-r", "cl-1"]);
  assert.equal(resumeCommand(cfg, s[1], wt).line, `cd ${wt} && opencode -s ses_c   # code`);
  assert.match(lookedIn(cfg, "12", store), /^looked in .*\.claude/);
});

test("lookedIn: an agent with neither transcripts nor a resume argv keeps its plain error", async (t) => {
  const { getAgent } = await import("../src/agents/index.js");
  AGENTS.blind = { ...getAgent("hermes"), describe: () => ({ name: "blind", stdout: "text" }) };
  t.after(() => delete AGENTS.blind);
  const cfg = /** @type {any} */ ({ repoPath: "/b/solo", worktreePrefix: "/b/wt", agent: "blind", pipeline: [{ id: "code" }] });
  assert.equal(lookedIn(cfg, "1", undefined), "blind runs have no transcripts to follow/resume");
});

test("dispatch: a stand-in opencode replaying a priced run → live tally, usage record with session id, priced run_end", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-oc-dispatch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, "stream.jsonl");
  fs.writeFileSync(fixture, PRICED);
  const bin = path.join(dir, "opencode");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `fs.writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));\n` +
      `fs.writeFileSync(process.env.AGENTHOOK_VERDICT_FILE, JSON.stringify({ outcome: "advance", reason: "ok" }));\n` +
      `process.stdout.write(fs.readFileSync(${JSON.stringify(fixture)}, "utf8"));\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"commonjs"}');
  const cfg = /** @type {any} */ ({
    pipeline: [{ id: "code", agent: "opencode", bin, model: "ollama/qwen3.8:27b-64k", effort: "high" }, { id: "done", manual: true }],
    claudeBin: path.join(dir, "no-such-claude"),
    repoPath: dir,
    worktreePrefix: path.join(dir, "wt"),
    dataDir: dir,
    logDir: dir,
    instructionsFile: path.join(dir, "none.md"),
  });
  const store = createStore(dir);
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const advanced = [];
  const adapter = /** @type {any} */ ({
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment" }),
    fetchTask: async (/** @type {string} */ ref) => ({ ref, name: "t", description: "d", url: "u", completed: false, assignedToUs: true }),
    advance: async (/** @type {string} */ ref, /** @type {string} */ stepId, /** @type {any} */ verdict) => advanced.push([ref, stepId, verdict.outcome]),
  });
  const emit = (/** @type {string} */ event, /** @type {string} */ ref, /** @type {string} */ step, /** @type {any} */ extra) => events.push({ event, ref, step, ...extra });
  const run = createDispatcher(cfg, adapter, undefined, store, emit);
  const log = console.log;
  console.log = () => {};
  try {
    await run({ kind: "pipeline", ref: "390", stepId: "code", dedupKey: "k:code" });
  } finally {
    console.log = log;
  }

  const argv = JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8"));
  assert.deepEqual(argv.slice(0, 7), ["run", "--format", "json", "-m", "ollama/qwen3.8:27b-64k", "--variant", "high"]);
  assert.equal(argv.length, 8);
  assert.match(argv[7], /Ref: 390/, "the prompt is the last positional");
  const usage = store.readUsage();
  assert.equal(usage.length, 1);
  assert.deepEqual([usage[0].sessionId, usage[0].output, usage[0].costUsd, usage[0].unpriced], [SID, 58, 0.75, undefined]);
  const end = events.find((e) => e.event === "run_end");
  assert.equal(end?.costUsd, 0.75);
  assert.equal(end?.outcome, "advance");
  assert.deepEqual(advanced, [["390", "code", "advance"]]);
  assert.deepEqual(
    listSessions(cfg, "390", store).map((s) => [s.id, s.step]),
    [[SID, "code"]],
  );
});
