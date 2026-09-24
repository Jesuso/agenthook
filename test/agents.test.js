// `agenthook agents` — pure-unit coverage (no `ps`, no config): parse `ps` stdout
// and attribute each agent row to its owning profile via running.json fixtures,
// asserting the default scope-to-active filter and the --all cross-profile view.
import test from "node:test";
import assert from "node:assert/strict";
import { parsePsAgents, selectAgents, fmtTok, fmtCtx, formatAgentRow, agentRecord } from "../src/commands/agents.js";

// Three `claude -p` agents (a dogfood GitHub issue, an Asana task, an orphan whose
// ref is in no running.json) plus a non-agent process that must be ignored.
const PS = [
  `  12345 01:23 node /x/.bin/claude -p You are working the "code" stage Ref: 6 blah`,
  `  67890 1-02:03:04 claude -p the "code" stage of an Asana task Ref: 1199887766 blah`,
  `  33333 00:05 claude -p the "review" stage Ref: 999 orphan`,
  `  22222 00:10 /usr/lib/firefox/firefox -contentproc`,
].join("\n");

const DOGFOOD = { name: "agenthook-dogfood", running: { "6": { stepId: "code", pid: 12345 } } };
const ALEPH = { name: "alephbeta", running: { "1199887766": { stepId: "code", pid: 67890 } } };

// A shell that merely MENTIONS the string (claude isn't its binary) and a user's own
// manual `claude -p` (real bin, but no agenthook step/ref markers) — neither is a
// receiver-spawned agent, yet the old substring match counted both.
const DECOYS = [
  `  44444 00:02 bash -c echo running claude -p now`, // substring, but claude not the binary
  `  55555 00:01 claude -p fix the bug in my code`, // real claude bin, no step/ref markers
].join("\n");

test("decoys: a shell mentioning 'claude -p' and a marker-less manual run are excluded", () => {
  assert.equal(parsePsAgents(DECOYS).length, 0);
});

test("one real agent + one decoy shell → only the real one is counted", () => {
  const real = PS.split("\n")[0]; // the dogfood `code` agent, ref 6
  const rows = parsePsAgents([real, DECOYS.split("\n")[0]].join("\n"));
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].step, rows[0].ref], ["code", "6"]);
});

test("parsePsAgents keeps only claude -p rows and extracts pid/step/ref", () => {
  const rows = parsePsAgents(PS);
  assert.equal(rows.length, 3); // firefox excluded
  assert.deepEqual(
    rows.map((r) => [r.pid, r.step, r.ref]),
    [["12345", "code", "6"], ["67890", "code", "1199887766"], ["33333", "review", "999"]],
  );
});

test("default scope: only the active profile's agents (refs in its running.json)", () => {
  const rows = selectAgents(PS, [DOGFOOD, ALEPH], { active: "agenthook-dogfood" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, "6");
  assert.equal(rows[0].profile, "agenthook-dogfood");
});

test("--all: every agent row, each labelled with its owning profile", () => {
  const rows = selectAgents(PS, [DOGFOOD, ALEPH], { all: true });
  assert.equal(rows.length, 3);
  const byRef = Object.fromEntries(rows.map((r) => [r.ref, r.profile]));
  assert.equal(byRef["6"], "agenthook-dogfood");
  assert.equal(byRef["1199887766"], "alephbeta");
  assert.equal(byRef["999"], "?"); // in no running.json
});

test("attribution prefers pid over ref when a ref collides across profiles", () => {
  // Both profiles claim ref "6", but pid disambiguates: pid 12345 is dogfood's.
  const other = { name: "other", running: { "6": { stepId: "code", pid: 55555 } } };
  const rows = selectAgents(PS, [other, DOGFOOD], { all: true });
  assert.equal(rows.find((r) => r.pid === "12345")?.profile, "agenthook-dogfood");
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

// --- formatAgentRow / agentRecord: human id, title, PR instead of pid/ref ---
const ROW = { pid: "1293223", etime: "00:51", step: "review", ref: "1218828631775704", profile: "alephbeta" };
const META = { displayId: "ID-2738", title: "Make the thing work across every profile and board at once", pr: 94 };

test("formatAgentRow default: displayId, step, #pr, etime, truncated title, ctx — no pid/ref", () => {
  const line = formatAgentRow(ROW, META, "ctx=79.5k out=188");
  assert.match(line, /^ID-2738\s+review\s+#94\s+00:51\s+Make the thing/);
  assert.ok(line.endsWith("ctx=79.5k out=188"));
  assert.ok(line.includes("…"), "long title truncated");
  assert.ok(!line.includes("pid="), "no pid by default");
  assert.ok(!line.includes(ROW.ref), "no raw ref by default");
  assert.ok(!line.includes("profile="), "no profile label without --all");
});

test("formatAgentRow --verbose appends pid + ref; --all keeps the profile label", () => {
  const line = formatAgentRow(ROW, META, "-", { verbose: true, all: true });
  assert.ok(line.startsWith("profile=alephbeta"));
  assert.ok(line.endsWith(`pid=1293223 ref=${ROW.ref}`));
});

test("formatAgentRow falls back to the ref and a — placeholder when nothing is known", () => {
  const line = formatAgentRow(ROW, undefined, "-");
  assert.match(line, new RegExp(`^${ROW.ref}\\s+review\\s+—\\s+00:51`));
  assert.ok(!line.includes("#"), "no PR shown");
});

test("agentRecord --json shape: live tally + running model/startedAt", () => {
  const run = { stepId: "review", pid: 1293223, startedAt: "2026-09-24T10:00:00Z", model: "claude-opus-5-5", input: 5, cacheRead: 79000, cacheCreate: 495, output: 188 };
  assert.deepEqual(agentRecord(ROW, META, run, undefined), {
    profile: "alephbeta", pid: 1293223, ref: ROW.ref, displayId: "ID-2738", title: META.title, pr: 94,
    step: "review", model: "claude-opus-5-5", startedAt: "2026-09-24T10:00:00Z", ctx: 79500, out: 188, etime: "00:51",
  });
});

test("agentRecord --json with no meta/running: nulls, last-run usage fallback", () => {
  const rec = agentRecord(ROW, undefined, undefined, { input: 10, output: 3, cacheRead: 0, cacheCreate: 0 });
  assert.equal(rec.displayId, null);
  assert.equal(rec.pr, null);
  assert.equal(rec.model, null);
  assert.equal(rec.ctx, 10);
  assert.equal(rec.out, 3);
  const none = agentRecord(ROW, undefined, undefined, undefined);
  assert.equal(none.ctx, null);
  assert.equal(none.out, null);
});
