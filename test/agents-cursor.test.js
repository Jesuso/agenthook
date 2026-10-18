import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The Cursor agent adapter — pure-unit coverage (no real `agent` spawn): argv, the stream-json
// parser over a recorded run (test/fixtures/cursor-stream.jsonl, a real `agent -p --force
// --trust --model auto --output-format stream-json` capture, ids/paths anonymised), the
// always-unpriced usage record, and the session plumbing (transcript layout, listSessions,
// resume) with HOME pointed at a tmp dir.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-cursor-"));
process.env.HOME = HOME;
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { buildCursorArgs, createCursorStreamParser, buildCursorUsageRecord, cursorProjectDir, cursor } = await import("../src/agents/cursor.js");
const { cursorMangle, claudeProjectDir } = await import("../src/paths.js");
const { listSessions, refRepo } = await import("../src/sessions.js");
const { resumeCommand } = await import("../src/commands/resume.js");
const { transcriptDirs } = await import("../src/commands/follow.js");
const { worktreePath } = await import("../src/worktree.js");

const FIXTURE = fs.readFileSync(new URL("./fixtures/cursor-stream.jsonl", import.meta.url), "utf8");
const SID = "00000000-0000-4000-8000-000000000001";

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

test("buildCursorArgs: default model auto, prompt last, no --force without fullAuto", () => {
  assert.deepEqual(buildCursorArgs({ prompt: "hi" }), ["-p", "--output-format", "stream-json", "--trust", "--model", "auto", "hi"]);
});

test("buildCursorArgs: explicit model, --force only with fullAuto", () => {
  assert.deepEqual(buildCursorArgs({ prompt: "hi", model: "gpt-5", fullAuto: true }), ["-p", "--output-format", "stream-json", "--trust", "--model", "gpt-5", "--force", "hi"]);
});

test("buildCursorArgs: effort never reaches argv and is warned about", () => {
  /** @type {string[]} */
  let args = [];
  const w = warns(() => (args = buildCursorArgs({ prompt: "hi", effort: "high" })));
  assert.deepEqual(args, ["-p", "--output-format", "stream-json", "--trust", "--model", "auto", "hi"]);
  assert.equal(w.length, 1);
  assert.match(w[0], /effort "high"/);
  assert.deepEqual(warns(() => buildCursorArgs({ prompt: "hi" })), []);
});

test("buildCursorArgs: provider never reaches argv and is warned about", () => {
  /** @type {string[]} */
  let args = [];
  const w = warns(() => (args = buildCursorArgs({ prompt: "hi", provider: "ollama-launch" })));
  assert.deepEqual(args, ["-p", "--output-format", "stream-json", "--trust", "--model", "auto", "hi"]);
  assert.equal(w.length, 1);
  assert.match(w[0], /provider "ollama-launch"/);
});

test("parser: recorded run → assistant text in the log, tally + result + session id", () => {
  const p = createCursorStreamParser();
  const log = p.push(FIXTURE) + p.flush();
  assert.equal(log, "I'll read `a.txt` and summarize it in one word.\nhello\n");
  assert.deepEqual(p.tally, { input: 9872, output: 73, cacheRead: 17408, cacheCreate: 0 });
  assert.equal(p.result.type, "result");
  assert.equal(p.result.duration_ms, 6925);
  assert.equal(p.sessionId, SID);
});

test("parser: a line split across chunks is buffered; one byte at a time gives the same output", () => {
  const p = createCursorStreamParser();
  let log = "";
  for (const ch of FIXTURE) log += p.push(ch);
  log += p.flush();
  assert.equal(log, "I'll read `a.txt` and summarize it in one word.\nhello\n");
  assert.equal(p.tally.output, 73);
  assert.equal(p.sessionId, SID);
});

test("parser: unknown event types and non-JSON lines are ignored, never throw", () => {
  const p = createCursorStreamParser();
  const out = p.push('not json at all\n{"type":"mystery","x":1}\n{"type":"assistant"}\n[1,2]\nnull\n{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}\n');
  assert.equal(out + p.flush(), "");
  assert.equal(p.result, null);
  assert.equal(p.sessionId, undefined);
});

test("parser: no result → result null, session id from the first event that carried one; usage record has zero tokens", () => {
  const lines = FIXTURE.split("\n").filter((l) => l && !l.includes('"type":"result"'));
  const p = createCursorStreamParser();
  p.push(lines.join("\n")); // last line unterminated
  p.flush();
  assert.equal(p.result, null);
  assert.equal(p.sessionId, SID);
  assert.deepEqual(p.tally, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  const rec = cursor.usageRecord(null, { ref: "7", stepId: "code", startedAt: "a", endedAt: "b" });
  assert.deepEqual([rec.input, rec.output, rec.cacheRead, rec.cacheCreate, rec.unpriced, rec.costUsd, rec.model], [0, 0, 0, 0, true, undefined, "auto"]);
});

test("usage record: always unpriced with no costUsd; bin tagged only when it overrides agent", () => {
  const p = createCursorStreamParser();
  p.push(FIXTURE);
  const ctx = { ref: "7", stepId: "code", startedAt: "s", endedAt: "e" };
  const rec = buildCursorUsageRecord({ ...ctx, model: "gpt-5", result: p.result });
  assert.deepEqual(rec, {
    ref: "7",
    stepId: "code",
    model: "gpt-5",
    startedAt: "s",
    endedAt: "e",
    durationMs: 6925,
    input: 9872,
    output: 73,
    cacheRead: 17408,
    cacheCreate: 0,
    costUsd: undefined,
    sessionId: SID,
    unpriced: true,
  });
  assert.equal(buildCursorUsageRecord({ ...ctx, result: p.result }).model, "auto");
  assert.equal(buildCursorUsageRecord({ ...ctx, result: { model: "sonnet-4" } }).model, "sonnet-4");
  assert.equal(buildCursorUsageRecord({ ...ctx, bin: "agent", result: p.result }).bin, undefined);
  assert.equal(buildCursorUsageRecord({ ...ctx, bin: "/opt/agent-beta", result: p.result }).bin, "/opt/agent-beta");
});

test("adapter: defaults bin agent, no requireVerdict default; resume argv", () => {
  assert.deepEqual(cursor.describe(), { name: "cursor", stdout: "stream-json" });
  assert.deepEqual(cursor.defaults, { bin: "agent" });
  assert.deepEqual(cursor.sessions?.resumeCommand("abc"), ["--resume", "abc"]);
});

test("cursorMangle: runs of non-alphanumerics collapse to one '-', ends trimmed", () => {
  assert.equal(cursorMangle("/home/me/repo"), "home-me-repo");
  assert.equal(cursorMangle("/tmp/claude-1000/-home-nacho-projects-agenthook/u1/scratchpad/spike-repo"), "tmp-claude-1000-home-nacho-projects-agenthook-u1-scratchpad-spike-repo");
  assert.equal(cursorMangle("/a/.dir/b"), "a-dir-b");
  assert.equal(cursorMangle("/x/"), "x");
  assert.equal(cursorProjectDir("/home/me/repo"), path.join(HOME, ".cursor", "projects", "home-me-repo", "agent-transcripts"));
});

/** Write a Cursor transcript `<dir>/<id>/<id>.jsonl` (role lines, no timestamps). @param {string} dir @param {string} id */
function writeCursorTranscript(dir, id) {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  const lines = [
    { role: "user", message: { content: [{ type: "text", text: "=== TICKET === fix it" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    { type: "turn_ended", status: "success" },
  ];
  fs.writeFileSync(path.join(dir, id, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("sessions.files: <dir>/<id>/<id>.jsonl per session; stray files and empty dirs skipped", () => {
  const dir = path.join(HOME, "files-probe");
  writeCursorTranscript(dir, "s1");
  writeCursorTranscript(dir, "s2");
  fs.mkdirSync(path.join(dir, "empty"));
  fs.writeFileSync(path.join(dir, "loose.jsonl"), "{}\n");
  const got = cursor.sessions?.files(dir) ?? [];
  assert.deepEqual(got.map((f) => [f.id, f.file]).sort(), [["s1", path.join(dir, "s1", "s1.jsonl")], ["s2", path.join(dir, "s2", "s2.jsonl")]]);
  assert.ok(got.every((f) => typeof f.at === "number" && f.at > 0));
  assert.deepEqual(cursor.sessions?.files(path.join(HOME, "nope")), []);
});

/** @param {string} logDir @param {string} stepId @param {string} ref */
function writeRunLog(logDir, stepId, ref) {
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(logDir, `${stamp}-step-${stepId}-${ref}.log`), "");
}

test("listSessions + resume: a cursor-only pipeline", () => {
  const cfg = /** @type {any} */ ({ repoPath: "/c/solo", worktreePrefix: "/c/wt", agent: "cursor", claudeBin: "claude", logDir: path.join(HOME, "logs-c"), pipeline: [{ id: "code" }] });
  const wt = worktreePath(cfg, "11");
  writeCursorTranscript(cursorProjectDir(wt), "cur-1");
  writeRunLog(cfg.logDir, "code", "11");
  const s = listSessions(cfg, "11");
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].id, s[0].step, s[0].msgs, s[0].prompt, s[0].agent], ["cur-1", "code", 2, "=== TICKET === fix it", "cursor"]);
  assert.equal(resumeCommand(cfg, s[0], wt).line, `cd ${wt} && agent --resume cur-1   # code`);
});

test("listSessions + resume + follow: a cursor step in a claude profile", () => {
  const cfg = /** @type {any} */ ({
    repoPath: "/m/solo",
    worktreePrefix: "/m/wt",
    claudeBin: "claude",
    logDir: path.join(HOME, "logs-m"),
    pipeline: [{ id: "triage" }, { id: "code", agent: "cursor" }, { id: "done", manual: true, agent: "cursor" }],
    repos: [{ id: "default", path: "/m/solo", match: [], default: true }],
  });
  const wt = worktreePath(cfg, "12");
  fs.mkdirSync(claudeProjectDir(wt), { recursive: true });
  const claudeLine = { type: "user", timestamp: "2020-01-01T00:00:00.000Z", message: { content: "=== TICKET === triage it" } };
  fs.writeFileSync(path.join(claudeProjectDir(wt), "cl-1.jsonl"), JSON.stringify(claudeLine) + "\n");
  writeCursorTranscript(cursorProjectDir(wt), "cur-2");
  writeRunLog(cfg.logDir, "code", "12");

  const s = listSessions(cfg, "12");
  assert.deepEqual(s.map((x) => [x.id, x.agent]), [["cl-1", "claude"], ["cur-2", "cursor"]]);
  assert.equal(s[0].at, Date.parse("2020-01-01T00:00:00.000Z"), "claude entries keep their line timestamp");
  // the tagged agent wins over the time-correlated step label
  assert.equal(resumeCommand(cfg, { ...s[1], step: "triage" }, wt).line, `cd ${wt} && agent --resume cur-2   # triage`);
  assert.equal(resumeCommand(cfg, s[0], wt).line, `cd ${wt} && claude -r cl-1   # ${s[0].step}`);
  assert.equal(refRepo(cfg, "12").id, "default");

  const got = transcriptDirs(cfg, cfg.repos);
  assert.deepEqual(got.dirs, [claudeProjectDir(wt), cursorProjectDir(wt)]);
  assert.ok(got.searched.includes(path.join(HOME, ".cursor", "projects", `${cursorMangle("/m/wt")}-*`, "agent-transcripts")));
  assert.deepEqual(got.files.map((f) => f.id), ["cl-1", "cur-2"]);
});
