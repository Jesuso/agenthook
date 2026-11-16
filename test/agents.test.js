import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook agents` — pure-unit coverage (no `ps`, no config): rows come from each profile's
// running.json (the state `tick` and the web UI read), written for every run whatever the agent
// or executor — so a sandboxed/remote run whose local process is not the agent binary still
// shows. Covers the default scope-to-active filter, the --all cross-profile view, dead-pid
// `stale` marking, and the human/JSON row formats.
import test from "node:test";
import assert from "node:assert/strict";
import { runningRows, fmtEtime, fmtTok, fmtCtx, formatAgentRow, agentRecord } from "../src/commands/agents.js";

const NOW = Date.parse("2026-09-24T11:00:00Z");

// A sandboxed claude run (its local process is the container runtime, pid 12345) and a plain
// opencode run (pid 67890), both in the same profile's running.json.
const DOGFOOD = {
  stateKey: "agenthook-dogfood",
  running: {
    "6": { stepId: "code", startedAt: "2026-09-24T10:00:00Z", model: "claude-opus-5-5", agent: "claude", harness: "sandbox", host: "worker-1", pid: 12345 },
    "7": { stepId: "review", startedAt: "2026-09-24T10:59:30Z", agent: "opencode", pid: 67890 },
  },
};
const ACME = { stateKey: "acme", running: { "1199887766": { stepId: "code", startedAt: "2026-09-24T10:00:00Z", agent: "claude", pid: 111 } } };

test("runningRows: one row per running.json entry, whatever the agent/executor", () => {
  const rows = runningRows([DOGFOOD], { all: true, now: NOW, isAlive: () => true });
  assert.equal(rows.length, 2);
  const byRef = Object.fromEntries(rows.map((r) => [r.ref, r]));
  assert.deepEqual(byRef["6"], {
    ref: "6", step: "code", harness: "sandbox", agent: "claude", host: "worker-1",
    model: "claude-opus-5-5", pid: "12345", etime: "01:00:00", profile: "agenthook-dogfood", stale: false,
  });
  assert.equal(byRef["7"].pid, "67890");
  assert.equal(byRef["7"].harness, null);
  assert.equal(byRef["7"].host, null);
  assert.equal(byRef["7"].model, null);
  assert.equal(byRef["7"].etime, "00:00:30");
});

test("fmtEtime: ps-style [[dd-]hh:]mm:ss, ? when missing/unparseable", () => {
  assert.equal(fmtEtime("2026-09-24T10:00:00Z", NOW), "01:00:00");
  assert.equal(fmtEtime("2026-09-23T09:00:00Z", NOW), "1-02:00:00"); // 26 hours
  assert.equal(fmtEtime(undefined, NOW), "?");
  assert.equal(fmtEtime("not a date", NOW), "?");
});

test("runningRows: a dead pid is marked stale; a row with no pid yet counts as running", () => {
  const prof = {
    stateKey: "p",
    running: {
      "1": { stepId: "code", startedAt: "2026-09-24T10:00:00Z", pid: 999 },
      "2": { stepId: "triage", startedAt: "2026-09-24T10:00:00Z" },
    },
  };
  const rows = runningRows([prof], { all: true, now: NOW, isAlive: (pid) => String(pid) !== "999" });
  const byRef = Object.fromEntries(rows.map((r) => [r.ref, r]));
  assert.equal(byRef["1"].stale, true);
  assert.equal(byRef["2"].stale, false);
  assert.equal(byRef["2"].pid, null);
});

test("default scope: only the active profile's rows", () => {
  const rows = runningRows([DOGFOOD, ACME], { active: "agenthook-dogfood", now: NOW, isAlive: () => true });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.profile === "agenthook-dogfood"));
});

test("--all: every profile's rows, each labelled with its owner", () => {
  const rows = runningRows([DOGFOOD, ACME], { all: true, now: NOW, isAlive: () => true });
  assert.equal(rows.length, 3);
  /** @type {Record<string, string[]>} */
  const byProfile = {};
  for (const r of rows) (byProfile[r.profile] ??= []).push(r.ref);
  assert.deepEqual(byProfile, { "agenthook-dogfood": ["6", "7"], acme: ["1199887766"] });
});

// --- fmtTok ---
test("fmtTok: no token data returns dash", () => {
  assert.equal(fmtTok(undefined, undefined, undefined), "-");
});

test("fmtTok: live tally (no cost) formats in/out in k", () => {
  assert.equal(fmtTok(42000, 12000, undefined), "42k/12k");
});

test("fmtTok: with cost appends dollar amount", () => {
  assert.equal(fmtTok(100000, 5000, 0.0312), "100k/5k $0.0312");
});

test("fmtTok: zero tokens formats as raw 0/0", () => {
  assert.equal(fmtTok(0, 0, undefined), "0/0");
});

test("fmtTok: sub-1000 tokens show raw count, not 0k", () => {
  assert.equal(fmtTok(2, 377, undefined), "2/377");
});

test("fmtTok: exactly 1000 rounds to 1k", () => {
  assert.equal(fmtTok(1000, 1000, undefined), "1k/1k");
});

test("fmtTok: mixed sub-1k and over-1k", () => {
  assert.equal(fmtTok(500, 2500, undefined), "500/3k");
});

// --- fmtCtx ---
test("fmtCtx: all undefined returns dash", () => {
  assert.equal(fmtCtx(undefined, undefined, undefined, undefined, undefined), "-");
});

test("fmtCtx: no cache, small input/output shows raw counts", () => {
  assert.equal(fmtCtx(28, 0, 0, 500, undefined), "ctx=28 out=500");
});

test("fmtCtx: cache-heavy run sums to M range", () => {
  // Real numbers from issue: input=28, cacheRead=1360436, cacheCreate=44714, output=8667
  assert.equal(fmtCtx(28, 1360436, 44714, 8667, undefined), "ctx=1.4M out=8.7k");
});

test("fmtCtx: with cost appends dollar amount", () => {
  assert.equal(fmtCtx(100, 0, 0, 5000, 0.0312), "ctx=100 out=5.0k $0.0312");
});

test("fmtCtx: k formatting for sub-million context", () => {
  assert.equal(fmtCtx(0, 50000, 0, 2000, undefined), "ctx=50.0k out=2.0k");
});

// --- formatAgentRow / agentRecord: human id, title, PR, harness/model columns ---
const ROW = { ref: "1200000000000001", step: "review", harness: "sandbox", agent: "claude", host: null, model: "claude-opus-5-5", pid: "1293223", etime: "00:51", profile: "acme", stale: false };
const META = { displayId: "ID-1234", title: "Make the thing work across every profile and board at once", pr: 94 };

test("formatAgentRow default: displayId, step, #pr, etime, harness, model, title, ctx", () => {
  const line = formatAgentRow(ROW, META, "ctx=79.5k out=188");
  assert.match(line, /^ID-1234\s+review\s+#94\s+00:51\s+sandbox\s+claude-opus-5-5\s+Make the thing/);
  assert.ok(line.endsWith("ctx=79.5k out=188"));
  assert.ok(line.includes("…"), "long title truncated");
  assert.ok(!line.includes("pid="), "no pid by default");
  assert.ok(!line.includes(ROW.ref), "no raw ref by default");
  assert.ok(!line.includes("profile="), "no profile label without --all");
  assert.ok(!line.includes("[stale]"), "no stale marker on a live row");
});

test("formatAgentRow: harness@host, the [stale] marker, and a dash for unharnessed", () => {
  assert.match(formatAgentRow({ ...ROW, host: "worker-1" }, META, "-"), /sandbox@worker-1\s+/);
  assert.match(formatAgentRow({ ...ROW, stale: true }, META, "-"), /\[stale\]/);
  assert.match(formatAgentRow({ ...ROW, harness: null }, META, "-"), /00:51\s+-\s+claude-opus-5-5\s+Make the thing/);
});

test("formatAgentRow --verbose appends pid + ref; --all keeps the profile label", () => {
  const line = formatAgentRow(ROW, META, "-", { verbose: true, all: true });
  assert.ok(line.startsWith("profile=acme"));
  assert.ok(line.endsWith(`pid=1293223 ref=${ROW.ref}`));
});

test("formatAgentRow --all shows the owner's label (state key stays on the row)", () => {
  const line = formatAgentRow(ROW, META, "-", { all: true, label: "Acme (acme)" });
  assert.ok(line.startsWith("profile=Acme (acme)"));
  assert.equal(ROW.profile, "acme");
});

test("formatAgentRow falls back to the ref and a — placeholder when nothing is known", () => {
  const line = formatAgentRow({ ...ROW, harness: null, model: null }, undefined, "-");
  assert.match(line, new RegExp(`^${ROW.ref}\\s+review\\s+—\\s+00:51\\s+-\\s+-\\s`));
  assert.ok(!line.includes("#"), "no PR shown");
});

test("agentRecord --json: profile = state key, label alongside", () => {
  const rec = agentRecord(ROW, META, undefined, undefined, "Acme (acme)");
  assert.equal(rec.profile, "acme");
  assert.equal(rec.label, "Acme (acme)");
});

test("agentRecord --json shape: live tally + model/startedAt + harness/agent/host/stale", () => {
  const run = { stepId: "review", pid: 1293223, startedAt: "2026-09-24T10:00:00Z", input: 5, cacheRead: 79000, cacheCreate: 495, output: 188 };
  assert.deepEqual(agentRecord(ROW, META, run, undefined), {
    profile: "acme", label: "acme", pid: 1293223, ref: ROW.ref, displayId: "ID-1234", title: META.title, pr: 94,
    step: "review", harness: "sandbox", agent: "claude", host: null, model: "claude-opus-5-5", startedAt: "2026-09-24T10:00:00Z", ctx: 79500, out: 188, etime: "00:51", stale: false,
  });
});

test("agentRecord --json with no meta/running: nulls, last-run usage fallback", () => {
  const rec = agentRecord({ ...ROW, harness: null, model: null }, undefined, undefined, { input: 10, output: 3, cacheRead: 0, cacheCreate: 0 });
  assert.equal(rec.displayId, null);
  assert.equal(rec.pr, null);
  assert.equal(rec.harness, null);
  assert.equal(rec.model, null);
  assert.equal(rec.ctx, 10);
  assert.equal(rec.out, 3);
  const none = agentRecord({ ...ROW, harness: null, model: null }, undefined, undefined, undefined);
  assert.equal(none.ctx, null);
  assert.equal(none.out, null);
});

test("agentRecord --json: pid null when unknown; stale from the row", () => {
  const rec = agentRecord({ ...ROW, pid: null, stale: true }, undefined, { stepId: "review", startedAt: "2026-09-24T10:00:00Z" }, undefined);
  assert.equal(rec.pid, null);
  assert.equal(rec.stale, true);
});
