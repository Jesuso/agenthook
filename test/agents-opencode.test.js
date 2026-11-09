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
  assert.deepEqual(buildOpencodeArgs({ prompt: "hi" }), ["run", "--format", "json", "--", "hi"]);
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
    "--",
    "hi",
  ]);
});

test("buildOpencodeArgs: a dash-led prompt (bullet, YAML front-matter) sits behind -- so it is never read as flags", () => {
  for (const prompt of ["- hello", "---\ntitle: x\n---\nhello"]) {
    const args = buildOpencodeArgs({ prompt, model: "m" });
    assert.deepEqual(args.slice(-2), ["--", prompt]);
  }
});

test("buildOpencodeArgs: provider never reaches argv and is warned about", () => {
  /** @type {string[]} */
  let args = [];
  const w = warns(() => (args = buildOpencodeArgs({ prompt: "hi", provider: "ollama-launch" })));
  assert.deepEqual(args, ["run", "--format", "json", "--", "hi"]);
  assert.equal(w.length, 1);
  assert.match(w[0], /provider "ollama-launch"/);
  assert.deepEqual(warns(() => buildOpencodeArgs({ prompt: "hi", effort: "high" })), []);
});

test("parser: recorded run → tool + text in the log, tally summed over steps, session id", () => {
  const p = createOpencodeParser();
  const log = p.push(FIXTURE) + p.flush();
  assert.equal(log, "🔧 read\nhello\n");
  // output = 45 + 13 summed; input/cache = the latest step's context
  // turns/firstContext/peakContext/lastContext (#645): 2 step_finish events, ctx 6925+1792=8717 then 108+8704=8812
  assert.deepEqual(p.tally, { input: 108, output: 58, cacheRead: 8704, cacheCreate: 0, compactions: 0, turns: 2, firstContext: 8717, peakContext: 8812, lastContext: 8812 });
  assert.equal(p.sessionId, SID);
  assert.deepEqual(p.result, { session_id: SID, tokens: { input: 108, output: 58, cacheRead: 8704, cacheCreate: 0, compactions: 0, turns: 2, firstContext: 8717, peakContext: 8812, lastContext: 8812 }, cost: 0 });
});

test("parser: reasoning tokens count as output", () => {
  const p = createOpencodeParser();
  p.push(JSON.stringify({ type: "step_finish", sessionID: "s", part: { tokens: { input: 1, output: 2, reasoning: 30, cache: { read: 4, write: 5 } }, cost: 0 } }) + "\n");
  assert.deepEqual(p.tally, { input: 1, output: 32, cacheRead: 4, cacheCreate: 5, compactions: 0, turns: 1, firstContext: 10, peakContext: 10, lastContext: 10 });
});

test("parser: 3 step_finish events give turns/firstContext/peakContext/lastContext (#645)", () => {
  const p = createOpencodeParser();
  const finish = (input, read, write) => JSON.stringify({ type: "step_finish", sessionID: "s", part: { tokens: { input, output: 1, cache: { read, write } }, cost: 0 } });
  p.push(finish(1000, 0, 0) + "\n");
  p.push(finish(2000, 1000, 0) + "\n");
  p.push(finish(500, 0, 0) + "\n");
  assert.equal(p.tally.turns, 3);
  assert.equal(p.tally.firstContext, 1000);
  assert.equal(p.tally.peakContext, 3000);
  assert.equal(p.tally.lastContext, 500);
});

// --- compaction heuristic (#657): a ≥20% context drop between step_finish events ---

test("parser: step_finish ctx 30,000 → 61,992 → 25,099 renders exactly one 🗜 compaction", () => {
  const p = createOpencodeParser();
  const finish = (input) => JSON.stringify({ type: "step_finish", sessionID: "s", part: { tokens: { input, output: 1, cache: { read: 0, write: 0 } }, cost: 0 } });
  let log = p.push(finish(30000) + "\n");
  log += p.push(finish(61992) + "\n");
  log += p.push(finish(25099) + "\n");
  assert.equal(log, "🗜 compaction (ctx 61,992 → 25,099)\n");
  assert.equal(p.tally.compactions, 1);
});

test("parser: a monotonically increasing context stream gives 0 compactions and no marker", () => {
  const p = createOpencodeParser();
  const finish = (input) => JSON.stringify({ type: "step_finish", sessionID: "s", part: { tokens: { input, output: 1, cache: { read: 0, write: 0 } }, cost: 0 } });
  let log = p.push(finish(1000) + "\n");
  log += p.push(finish(2000) + "\n");
  log += p.push(finish(3000) + "\n");
  assert.equal(log, "");
  assert.equal(p.tally.compactions, 0);
});

test("parser: a zero-token step_finish neither counts a compaction nor resets the baseline", () => {
  const p = createOpencodeParser();
  const finish = (input) => JSON.stringify({ type: "step_finish", sessionID: "s", part: { tokens: { input, output: 1, cache: { read: 0, write: 0 } }, cost: 0 } });
  const errored = JSON.stringify({ type: "step_finish", sessionID: "s", part: { tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } }, cost: 0 } });
  p.push(finish(10000) + "\n");
  const log = p.push(errored + "\n");
  assert.equal(log, "", "a zero-ctx step_finish doesn't count");
  assert.equal(p.tally.compactions, 0);
  // the baseline is still the last nonzero ctx (10000, not 0) — a real drop below it still counts
  const log2 = p.push(finish(2000) + "\n");
  assert.equal(log2, "🗜 compaction (ctx 10,000 → 2,000)\n");
  assert.equal(p.tally.compactions, 1);
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
  // the malformed step_finish still counts as a turn (every step_finish is one, #645),
  // just with a zero context (its tokens field isn't an object)
  assert.deepEqual(p.tally, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, compactions: 0, turns: 1, firstContext: 0, peakContext: 0, lastContext: 0 });
});

test("parser: an error event becomes a one-line ⚠ in the log, never throws on odd shapes", () => {
  const p = createOpencodeParser();
  const line = JSON.stringify({ type: "error", sessionID: SID, error: { name: "ProviderModelNotFoundError", data: { message: "model ollama/nope not found" } } });
  assert.equal(p.push(line + "\n"), "⚠ ProviderModelNotFoundError: model ollama/nope not found\n");
  assert.equal(p.sessionId, SID);
  assert.equal(p.push('{"type":"error"}\n{"type":"error","error":{"name":5,"data":"x"}}\n{"type":"error","error":{"name":"E"}}\n'), "⚠ error\n⚠ error\n⚠ E\n");
});

test("parser: result is null until an event, non-null from the first sessionID (so a killed run still records its session)", () => {
  const p = createOpencodeParser();
  assert.equal(p.result, null);
  p.push(FIXTURE.split("\n")[0] + "\n"); // step_start only
  assert.deepEqual(p.result, { session_id: SID, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, compactions: 0 }, cost: 0 });
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

test("sandbox: no opencodeConfig → no files, non-essential-traffic env only", () => {
  const own = opencode.sandbox({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code" }), cwd: "/wt", ownsCwd: true, home: "/home/agent" });
  assert.deepEqual(own.mounts, []);
  assert.deepEqual(own.files, []);
  assert.deepEqual(own.env, { OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" });
});

test("sandbox: opencodeConfig is read and copied to .config/opencode/opencode.json under home", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-cfg-"));
  const cfgPath = path.join(dir, "opencode.json");
  const content = JSON.stringify({ provider: { ollama: { options: { baseURL: "http://localhost:11434/v1" } } } });
  fs.writeFileSync(cfgPath, content);
  try {
    const own = opencode.sandbox({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ id: "code", opencodeConfig: cfgPath }), cwd: "/wt", ownsCwd: true, home: "/home/agent" });
    assert.deepEqual(own.files, [{ dst: "/home/agent/.config/opencode/opencode.json", content, mode: 0o600 }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox: a missing, non-regular, oversized or invalid-JSON opencodeConfig throws `opencodeConfig <path>: …`", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-cfg-bad-"));
  try {
    const missing = path.join(dir, "nope.json");
    assert.throws(() => opencode.sandbox({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ opencodeConfig: missing }), cwd: "/wt", ownsCwd: true, home: "/home/agent" }), new RegExp(`^Error: opencodeConfig ${missing}:`));

    const dirAsConfig = path.join(dir, "subdir");
    fs.mkdirSync(dirAsConfig);
    assert.throws(() => opencode.sandbox({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ opencodeConfig: dirAsConfig }), cwd: "/wt", ownsCwd: true, home: "/home/agent" }), /not a regular file/);

    const big = path.join(dir, "big.json");
    fs.writeFileSync(big, "x".repeat(256 * 1024 + 1));
    assert.throws(() => opencode.sandbox({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ opencodeConfig: big }), cwd: "/wt", ownsCwd: true, home: "/home/agent" }), /exceeds the .* cap/);

    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json");
    assert.throws(() => opencode.sandbox({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ opencodeConfig: bad }), cwd: "/wt", ownsCwd: true, home: "/home/agent" }), /invalid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox: a symlinked opencodeConfig is rejected (lstat, never followed)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-cfg-sym-"));
  try {
    const real = path.join(dir, "real.json");
    fs.writeFileSync(real, "{}");
    const link = path.join(dir, "link.json");
    fs.symlinkSync(real, link);
    assert.throws(() => opencode.sandbox({ cfg: /** @type {any} */ ({}), step: /** @type {any} */ ({ opencodeConfig: link }), cwd: "/wt", ownsCwd: true, home: "/home/agent" }), /not a regular file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  AGENTS.blind = { ...getAgent("hermes"), resumeCommand: undefined, describe: () => ({ name: "blind", stdout: "text" }) };
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
  assert.deepEqual(argv.slice(0, 8), ["run", "--format", "json", "-m", "ollama/qwen3.8:27b-64k", "--variant", "high", "--"]);
  assert.equal(argv.length, 9);
  assert.match(argv[8], /Ref: 390/, "the prompt is the last positional, behind --");
  const usage = store.readUsage();
  assert.equal(usage.length, 1);
  assert.deepEqual([usage[0].sessionId, usage[0].output, usage[0].costUsd, usage[0].unpriced], [SID, 58, 0.75, undefined]);
  // opencode reports no duration_ms, so dispatch derives it from the run's wall time (#652).
  assert.equal(usage[0].durationMs, Date.parse(usage[0].endedAt) - Date.parse(usage[0].startedAt));
  const end = events.find((e) => e.event === "run_end");
  assert.equal(end?.costUsd, 0.75);
  assert.equal(end?.outcome, "advance");
  assert.deepEqual(advanced, [["390", "code", "advance"]]);
  assert.deepEqual(
    listSessions(cfg, "390", store).map((s) => [s.id, s.step]),
    [[SID, "code"]],
  );
});
