import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook stats` — the CLI wiring around src/stats.js: reads usage.jsonl + events.jsonl for
// the discovered profile, prints a table (or --json), rejects a bad --by/--since.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registryDir } from "../src/config.js";
import { stats } from "../src/commands/stats.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-stats-cmd-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const json = (v) => JSON.stringify(v, null, 2) + "\n";
const jsonl = (recs) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** A minimal profile: config file anywhere + its state dir under the real registry (AGENTHOOK_HOME). */
function profile(name, { usage = [], events = [] } = {}) {
  const stateDir = path.join(registryDir, name);
  fs.mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(root, "cfg", name, "agenthook.config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, json({ name, repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code" }] } }));
  if (usage.length) fs.writeFileSync(path.join(stateDir, "usage.jsonl"), jsonl(usage));
  if (events.length) fs.writeFileSync(path.join(stateDir, "events.jsonl"), jsonl(events));
  return { name, configPath, stateDir };
}

function capture() {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  return { out, err, restore: () => ((console.log = log), (console.error = error)) };
}

// Timestamps are relative to the real clock (not a fixed date) — the command itself reads
// `Date.now()` for its `--since 7d` default, so a fixed-date fixture would go stale.
const NOW_MS = Date.now();
const NOW_ISO = new Date(NOW_MS).toISOString();
const STARTED_ISO = new Date(NOW_MS - 2 * 60 * 1000).toISOString();

test("default --by harness --since 7d: one table, a group row per harness", async () => {
  const p = profile("stats-table", {
    usage: [{ ref: "1", stepId: "code", harness: "fast", model: "claude-sonnet-5", startedAt: STARTED_ISO, endedAt: NOW_ISO, input: 100, output: 50, cacheRead: 0, cacheCreate: 0, costUsd: 0.01 }],
    events: [{ ts: NOW_ISO, event: "run_end", ref: "1", step: "code", outcome: "advance", harness: "fast" }],
  });
  const c = capture();
  try {
    await stats({ _: [], config: p.configPath });
    const lines = c.out.join("\n").split("\n");
    // Full-row snapshot (not just a header/prefix match): every column, so a broken outcome
    // count, wall, token, throughput or cost column fails this test. Wall is a fixed 2m here
    // (STARTED_ISO is NOW - 2min), so only the trailing "since" line is clock-dependent.
    const header = lines.find((l) => l.startsWith("harness"));
    assert.ok(header, "header row");
    assert.deepEqual(
      header.trim().split(/\s{2,}/),
      ["harness", "runs", "ok%", "adv/chg/hold/fail/tmo/rq/unk", "p50", "p90", "turns", "ctx0", "ctxPk", "in", "out", "cacheR", "out/min", "$", "est$", "unpriced"],
    );
    const row = lines.find((l) => l.startsWith("fast"));
    assert.ok(row, "one group row for the harness");
    assert.deepEqual(
      row.trim().split(/\s{2,}/),
      ["fast", "1", "100%", "1/0/0/0/0/0/0", "2.0m", "2.0m", "—", "—", "—", "100", "50", "0", "25", "$0.0100", "—", "—"],
    );
    assert.match(lines.join("\n"), /^since .* \(--by harness\)$/m);
  } finally {
    c.restore();
  }
});

test("--json prints the structured runStats object", async () => {
  const p = profile("stats-json", {
    usage: [{ ref: "1", stepId: "code", harness: "fast", startedAt: STARTED_ISO, endedAt: NOW_ISO, input: 10, output: 20, cacheRead: 0, cacheCreate: 0 }],
    events: [{ ts: NOW_ISO, event: "run_end", ref: "1", step: "code", outcome: "advance", harness: "fast" }],
  });
  const c = capture();
  try {
    await stats({ _: [], config: p.configPath, json: true });
    const body = JSON.parse(c.out.join("\n"));
    assert.equal(body.by, "harness");
    assert.equal(body.groups.length, 1);
    assert.equal(body.groups[0].key, "fast");
    assert.equal(body.groups[0].runs, 1);
  } finally {
    c.restore();
  }
});

test("invalid --by exits non-zero with a usage message", async () => {
  const p = profile("stats-bad-by");
  const c = capture();
  try {
    process.exitCode = 0;
    await stats({ _: [], config: p.configPath, by: "nope" });
    assert.equal(process.exitCode, 1);
    assert.match(c.err[0], /usage: agenthook stats/);
  } finally {
    c.restore();
    process.exitCode = 0;
  }
});

test("invalid --since exits non-zero with a usage message", async () => {
  const p = profile("stats-bad-since");
  const c = capture();
  try {
    process.exitCode = 0;
    await stats({ _: [], config: p.configPath, since: "9d" });
    assert.equal(process.exitCode, 1);
    assert.match(c.err[0], /--since must be one of/);
  } finally {
    c.restore();
    process.exitCode = 0;
  }
});

test("no runs in the window: a plain message, no table", async () => {
  const p = profile("stats-empty");
  const c = capture();
  try {
    await stats({ _: [], config: p.configPath });
    assert.equal(c.out.join("\n"), "no runs recorded in this window");
  } finally {
    c.restore();
  }
});
