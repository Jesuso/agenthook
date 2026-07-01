// `agenthook agents` — pure-unit coverage (no `ps`, no config): parse `ps` stdout
// and attribute each agent row to its owning profile via running.json fixtures,
// asserting the default scope-to-active filter and the --all cross-profile view.
import test from "node:test";
import assert from "node:assert/strict";
import { parsePsAgents, selectAgents, fmtTok } from "../src/commands/agents.js";

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

test("fmtTok: zero tokens formats as 0k", () => {
  assert.equal(fmtTok(0, 0, undefined), "0k/0k");
});
