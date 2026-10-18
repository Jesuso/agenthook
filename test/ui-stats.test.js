import "./_setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dailyStats, quantile, readHistory, readStats, resetStatsCache, STATS_MAX_DAYS } from "../src/ui/stats.js";

const NOW = Date.parse("2026-10-15T18:00:00Z"); // UTC; tzOffset 0 unless a test says otherwise
const at = (/** @type {string} */ iso) => iso;
const ev = (/** @type {string} */ ts, /** @type {string} */ event, /** @type {any} */ x = {}) => ({ ts, event, ref: "1", step: "s", ...x });

test("dailyStats: zero-filled, oldest first, last bucket is today", () => {
  const d = dailyStats([], { now: NOW, days: 3 });
  assert.deepEqual(d.map((x) => x.date), ["2026-10-13", "2026-10-14", "2026-10-15"]);
  assert.ok(d.every((x) => x.finished === 0 && x.runs === 0 && x.costUsd === 0));
});

test("dailyStats: finished counts distinct tickets per day (repeated pipeline_done is one)", () => {
  const events = [
    ev(at("2026-10-15T01:28:29Z"), "pipeline_done", { ref: "A" }),
    ev(at("2026-10-15T01:28:31Z"), "pipeline_done", { ref: "A" }),
    ev(at("2026-10-15T01:28:32Z"), "pipeline_done", { ref: "A" }),
    ev(at("2026-10-15T02:00:00Z"), "pipeline_done", { ref: "B" }),
    ev(at("2026-10-14T02:00:00Z"), "pipeline_done", { ref: "A" }), // same ticket, another day: counts there too
  ];
  const [y, t] = dailyStats(events, { now: NOW, days: 2 });
  assert.equal(t.finished, 2);
  assert.equal(y.finished, 1);
});

test("dailyStats: runs, rework, failed runs and cost from run_end; merged is distinct refs", () => {
  const events = [
    ev("2026-10-15T10:00:00Z", "run_end", { outcome: "advance", costUsd: 1.234 }),
    ev("2026-10-15T11:00:00Z", "run_end", { outcome: "changes", costUsd: 2 }),
    ev("2026-10-15T12:00:00Z", "run_end", { outcome: "fail" }), // no cost
    ev("2026-10-15T12:00:00Z", "run_end", { outcome: "advance", costUsd: "x" }), // junk cost ignored
    ev("2026-10-15T13:00:00Z", "merged", { ref: "A" }),
    ev("2026-10-15T13:00:01Z", "merged", { ref: "A" }),
  ];
  const [t] = dailyStats(events, { now: NOW, days: 1 });
  assert.deepEqual({ runs: t.runs, rework: t.rework, failedRuns: t.failedRuns, merged: t.merged, costUsd: t.costUsd }, { runs: 4, rework: 1, failedRuns: 1, merged: 1, costUsd: 3.23 });
});

test("dailyStats: an unpriced run_end counts as a run but adds no spend; a local-only ticket has no ticketCost", () => {
  const events = [
    ev("2026-10-15T09:00:00Z", "run_end", { ref: "L", step: "triage", outcome: "advance", unpriced: true }),
    ev("2026-10-15T09:30:00Z", "run_end", { ref: "L", step: "review", outcome: "advance", unpriced: true }),
    ev("2026-10-15T10:00:00Z", "pipeline_done", { ref: "L" }),
    ev("2026-10-15T11:00:00Z", "run_end", { ref: "P", step: "code", outcome: "advance", costUsd: 2 }),
    ev("2026-10-15T11:30:00Z", "run_end", { ref: "P", step: "triage", outcome: "advance", unpriced: true }),
    ev("2026-10-15T12:00:00Z", "pipeline_done", { ref: "P" }),
  ];
  const [t] = dailyStats(events, { now: NOW, days: 1 });
  assert.equal(t.runs, 4);
  assert.equal(t.costUsd, 2);
  assert.deepEqual(t.byStep.triage, { runs: 2, costUsd: 0, estUsd: 0 });
  assert.deepEqual(t.byStep.code, { runs: 1, costUsd: 2, estUsd: 0 });
  assert.equal(t.unestimatedRuns, 3, "unpriced runs with no tokens have no estimate");
  assert.equal(t.finished, 2);
  assert.deepEqual(t.ticketCost, { n: 1, p10: 2, p50: 2, p90: 2 }, "the local-only ticket never enters ticketCost");
});

test("dailyStats: days are cut at the caller's midnight (tzOffset = getTimezoneOffset minutes)", () => {
  // 23:30 UTC on the 14th is 17:30 on the 14th in UTC-6, but 05:30 on the 15th in UTC+6.
  const e = [ev("2026-10-14T23:30:00Z", "pipeline_done", { ref: "A" })];
  const west = dailyStats(e, { now: Date.parse("2026-10-15T12:00:00Z"), days: 2, tzOffset: 360 });
  assert.deepEqual(west.map((d) => [d.date, d.finished]), [["2026-10-14", 1], ["2026-10-15", 0]]);
  const east = dailyStats(e, { now: Date.parse("2026-10-15T12:00:00Z"), days: 2, tzOffset: -360 });
  assert.deepEqual(east.map((d) => [d.date, d.finished]), [["2026-10-14", 0], ["2026-10-15", 1]]);
});

test("dailyStats: ignores out-of-window events, junk timestamps, and clamps days", () => {
  const events = [ev("2020-01-01T00:00:00Z", "run_end", { costUsd: 9 }), ev("garbage", "run_end"), ev("2026-10-15T00:00:00Z", "run_end", { costUsd: 1 })];
  assert.equal(dailyStats(events, { now: NOW, days: 2 }).reduce((n, d) => n + d.runs, 0), 1);
  assert.equal(dailyStats([], { now: NOW, days: 9999 }).length, STATS_MAX_DAYS);
  assert.equal(dailyStats([], { now: NOW, days: 0 }).length, 1);
});

function file() {
  resetStatsCache();
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ah-stats-")), "events.jsonl");
}
const line = (/** @type {any} */ e) => JSON.stringify(e) + "\n";

test("readStats: a missing file is an empty history", () => {
  const v = readStats(file(), { now: NOW, days: 2 });
  assert.equal(v.since, null);
  assert.equal(v.days.length, 2);
});

test("readStats: reads only appended bytes, keeps `since`, waits for a half-written line", () => {
  const f = file();
  fs.writeFileSync(f, line(ev("2026-09-01T00:00:00Z", "enqueued")) + line(ev("2026-10-15T10:00:00Z", "pipeline_done", { ref: "A" })));
  let v = readStats(f, { now: NOW, days: 1 });
  assert.equal(v.since, "2026-09-01T00:00:00Z");
  assert.equal(v.days[0].finished, 1);
  const half = JSON.stringify(ev("2026-10-15T11:00:00Z", "pipeline_done", { ref: "B" }));
  fs.appendFileSync(f, half.slice(0, 20));
  assert.equal(readStats(f, { now: NOW, days: 1 }).days[0].finished, 1, "torn tail not counted");
  fs.appendFileSync(f, half.slice(20) + "\n");
  v = readStats(f, { now: NOW, days: 1 });
  assert.equal(v.days[0].finished, 2, "picked up whole once complete");
});

test("readStats: a replaced (shorter) file restarts the read; garbage lines are skipped", () => {
  const f = file();
  fs.writeFileSync(f, line(ev("2026-10-15T10:00:00Z", "pipeline_done", { ref: "A" })) + line(ev("2026-10-15T10:01:00Z", "pipeline_done", { ref: "B" })));
  assert.equal(readStats(f, { now: NOW, days: 1 }).days[0].finished, 2);
  fs.writeFileSync(f, "not json\n" + line(ev("2026-10-15T10:00:00Z", "pipeline_done", { ref: "C" })));
  assert.equal(readStats(f, { now: NOW, days: 1 }).days[0].finished, 1);
});

test("readHistory: keeps run_start, and readStats output is unchanged by its presence", () => {
  const f = file();
  const withoutRunStart = line(ev("2026-10-15T10:00:00Z", "pipeline_done", { ref: "A" }));
  fs.writeFileSync(f, withoutRunStart);
  const baseline = readStats(f, { now: NOW, days: 1 });

  const f2 = file();
  fs.writeFileSync(f2, line(ev("2026-10-15T09:00:00Z", "run_start", { ref: "A" })) + withoutRunStart);
  const withRunStart = readStats(f2, { now: NOW, days: 1 });
  assert.deepEqual(withRunStart.days, baseline.days);

  const h = readHistory(f2);
  assert.ok(h.events.some((e) => e.event === "run_start"));
});

test("quantile: linear interpolation on a sorted list; empty is 0", () => {
  assert.equal(quantile([], 0.5), 0);
  assert.equal(quantile([4], 0.9), 4);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([10, 20, 30], 0.1), 12);
  assert.equal(quantile([10, 20, 30], 1), 30);
});

test("dailyStats: spend and runs per step, outcomes per day (unknown outcome and missing step are kept, not dropped)", () => {
  const events = [
    ev("2026-10-15T10:00:00Z", "run_end", { step: "triage", outcome: "advance", costUsd: 1 }),
    ev("2026-10-15T10:05:00Z", "run_end", { step: "code", outcome: "advance", costUsd: 4 }),
    ev("2026-10-15T10:10:00Z", "run_end", { step: "code", outcome: "changes", costUsd: 2 }),
    ev("2026-10-15T10:15:00Z", "run_end", { step: "review", outcome: "hold", costUsd: 0.5 }),
    ev("2026-10-15T10:20:00Z", "run_end", { step: "review", outcome: "fail" }),
    ev("2026-10-15T10:25:00Z", "run_end", { step: "", outcome: "weird", costUsd: 1 }),
  ];
  const [t] = dailyStats(events, { now: NOW, days: 1 });
  assert.deepEqual(t.byStep.code, { runs: 2, costUsd: 6, estUsd: 0 });
  assert.deepEqual(t.byStep.triage, { runs: 1, costUsd: 1, estUsd: 0 });
  assert.deepEqual(t.byStep.review, { runs: 2, costUsd: 0.5, estUsd: 0 });
  assert.deepEqual(t.byStep["?"], { runs: 1, costUsd: 1, estUsd: 0 });
  assert.deepEqual(t.outcomes, { advance: 2, changes: 1, hold: 1, fail: 1, other: 1 });
});

test("dailyStats: ticketCost is what each finished ticket cost since its last finish, counted once, incl. spend before the window", () => {
  const events = [
    ev("2026-09-01T10:00:00Z", "run_end", { ref: "A", costUsd: 3 }), // long before the 2-day window
    ev("2026-10-14T10:00:00Z", "run_end", { ref: "A", costUsd: 2 }),
    ev("2026-10-14T11:00:00Z", "pipeline_done", { ref: "A" }), // A cost 5 to finish
    ev("2026-10-14T11:00:02Z", "pipeline_done", { ref: "A" }), // duplicate burst: not a second ticket cost
    ev("2026-10-14T12:00:00Z", "pipeline_done", { ref: "H" }), // finished by hand: no agent spend, no cost sample
    ev("2026-10-15T09:00:00Z", "run_end", { ref: "A", costUsd: 1 }), // reopened and re-run
    ev("2026-10-15T09:30:00Z", "pipeline_done", { ref: "A" }),
    ev("2026-10-15T09:00:00Z", "run_end", { ref: "B", costUsd: 10 }),
    ev("2026-10-15T09:40:00Z", "pipeline_done", { ref: "B" }),
  ];
  const [y, t] = dailyStats(events, { now: NOW, days: 2 });
  assert.deepEqual(y.ticketCost, { n: 1, p10: 5, p50: 5, p90: 5 });
  assert.equal(y.finished, 2, "the hand-finished ticket still counts as finished");
  assert.deepEqual(t.ticketCost, { n: 2, p10: 1.9, p50: 5.5, p90: 9.1 });
  assert.equal(dailyStats([ev("2026-10-15T10:00:00Z", "pipeline_done", { ref: "Z" })], { now: NOW, days: 1 })[0].ticketCost, null);
});

test("dailyStats: estimates sum apart from costUsd; unestimated runs counted; ticketEst over estimates only", () => {
  const events = [
    // Reported Claude run: costUsd only, unchanged.
    ev("2026-10-15T09:00:00Z", "run_end", { ref: "A", step: "code", outcome: "advance", costUsd: 2, costBasis: "reported", model: "claude-opus-5-5", input: 1e6, output: 0, cacheRead: 0, cacheCreate: 0 }),
    // Stamped estimate.
    ev("2026-10-15T09:10:00Z", "run_end", { ref: "A", step: "review", outcome: "advance", unpriced: true, estUsd: 0.5, costBasis: "rate-table" }),
    ev("2026-10-15T09:20:00Z", "pipeline_done", { ref: "A" }),
    // Unstamped, priced at read time from tokens with the profile's overrides.
    ev("2026-10-15T10:00:00Z", "run_end", { ref: "B", step: "code", outcome: "advance", unpriced: true, model: "ollama/qwen3.8", input: 1e6, output: 0, cacheRead: 0, cacheCreate: 0 }),
    ev("2026-10-15T10:30:00Z", "pipeline_done", { ref: "B" }),
    // Hermes: zero tokens → no estimate.
    ev("2026-10-15T11:00:00Z", "run_end", { ref: "C", step: "code", outcome: "advance", unpriced: true, model: "claude-opus-5-5", input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }),
  ];
  const [t] = dailyStats(events, { now: NOW, days: 1, pricing: { "qwen3.8*": { input: 3, output: 15 } } });
  assert.equal(t.costUsd, 2, "the reported figure is untouched");
  assert.equal(t.estUsd, 3.5);
  assert.equal(t.unestimatedRuns, 1);
  assert.deepEqual(t.byStep.code, { runs: 3, costUsd: 2, estUsd: 3 });
  assert.deepEqual(t.byStep.review, { runs: 1, costUsd: 0, estUsd: 0.5 });
  assert.deepEqual(t.ticketCost, { n: 1, p10: 2, p50: 2, p90: 2 });
  assert.deepEqual(t.ticketEst, { n: 2, p10: 0.75, p50: 1.75, p90: 2.75 });
  const [noOverrides] = dailyStats(events, { now: NOW, days: 1 });
  assert.equal(noOverrides.estUsd, 0.5, "qwen has no default rate");
  assert.equal(noOverrides.unestimatedRuns, 2);
});

test("readHistory: a run_end keeps model/tokens/estimate; an old one with no tokens joins usage.jsonl (±5 s, same ref+step)", () => {
  const f = file();
  const dir = path.dirname(f);
  const usage = [
    { ref: "1", stepId: "code", model: "claude-sonnet-5-5", startedAt: "2026-10-15T09:00:00Z", endedAt: "2026-10-15T10:00:00.000Z", input: 1e6, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 7, unpriced: true },
    { ref: "2", stepId: "code", model: "claude-sonnet-5-5", startedAt: "2026-10-15T09:00:00Z", endedAt: "2026-10-15T10:00:00.000Z", input: 1e6, output: 0, cacheRead: 0, cacheCreate: 0, unpriced: true },
    { ref: "3", stepId: "code", model: "claude-sonnet-5-5", startedAt: "2026-10-15T09:00:00Z", endedAt: "2026-10-15T10:00:00.000Z", input: 1e6, output: 0, cacheRead: 0, cacheCreate: 0, unpriced: true },
  ];
  fs.writeFileSync(path.join(dir, "usage.jsonl"), usage.map(line).join(""));
  const before = fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8");
  fs.writeFileSync(
    f,
    [
      { ts: "2026-10-15T10:00:01.000Z", event: "run_end", ref: "1", step: "code", outcome: "advance", unpriced: true }, // old shape: joined
      { ts: "2026-10-15T10:00:09.000Z", event: "run_end", ref: "2", step: "code", outcome: "advance", unpriced: true }, // 9 s off: no join
      { ts: "2026-10-15T10:00:00.500Z", event: "run_end", ref: "3", step: "review", outcome: "advance", unpriced: true }, // other step: no join
      { ts: "2026-10-15T11:00:00.000Z", event: "run_end", ref: "4", step: "code", outcome: "advance", unpriced: true, model: "claude-opus-5-5", input: 1e6, output: 0, cacheRead: 0, cacheCreate: 0 },
    ]
      .map(line)
      .join(""),
  );
  const evs = readHistory(f).events;
  assert.equal(evs[0].model, "claude-sonnet-5-5");
  assert.equal(evs[0].input, 1e6);
  assert.equal(evs[1].input, undefined);
  assert.equal(evs[2].input, undefined);
  assert.equal(evs[3].model, "claude-opus-5-5");
  const [t] = readStats(f, { now: NOW, days: 1 }).days;
  assert.equal(t.costUsd, 0, "an unpriced raw costUsd never becomes reported spend");
  assert.equal(t.estUsd, 6, "2 (joined sonnet) + 4 (opus with tokens)");
  assert.equal(t.unestimatedRuns, 2);
  assert.equal(fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8"), before, "no file is rewritten");
});
