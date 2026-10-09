#!/usr/bin/env node
// Append live events.jsonl lines to a seeded profile's events, spread across a few minutes, so
// the Activity rail (#226) has something to show — it's live-only (not in Snapshot), so
// seed.js's static events never reach it; only lines appended while `ah ui` is watching do.
//
//   node test/fixtures/ui/pulse.js <home> [--count n] [--key agenthook]
//
// Run this against the same AGENTHOOK_HOME seed.js seeded, while `ah ui` is up and a browser tab
// is open on it — the watcher tails events.jsonl and the rail picks the lines up over SSE.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
/** @param {string} name @param {string} def */
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const count = Number(opt("count", "9"));
const key = opt("key", "agenthook");
const root = args[0];
if (!root || !Number.isInteger(count) || count < 1) {
  console.error("usage: node test/fixtures/ui/pulse.js <home> [--count n] [--key agenthook]");
  process.exit(2);
}

const eventsPath = path.join(root, key, "events.jsonl");
if (!fs.existsSync(eventsPath)) {
  console.error(`no events.jsonl at ${eventsPath} — run seed.js first`);
  process.exit(2);
}

// A realistic mix spanning 2+ minutes of ts, oldest first (so appends land in order).
const KINDS = [
  { event: "run_start", ref: "221", step: "code", model: "opus" },
  { event: "enqueued", ref: "223", step: "triage" },
  { event: "run_end", ref: "221", step: "code", outcome: "advance", costUsd: 1.27 },
  { event: "run_start", ref: "214", step: "triage", model: "haiku" },
  { event: "blocked", ref: "207", step: "code", reason: "merge conflict with master" },
  { event: "run_end", ref: "218", step: "review", outcome: "hold", costUsd: 0.42 },
  { event: "failed", ref: "205", step: "triage", reason: "npm test red" },
  { event: "merged", ref: "209", step: "" },
  { event: "restarting", ref: "" },
];

// `ts` values are backdated across ~2.5 minutes (newest = now) so the rail's minute grouping has
// more than one header to show, even though the lines themselves are appended within a few
// seconds — the rail renders whatever `ts` says, it doesn't care when the write happened.
const now = Date.now();
const spacingMs = 15_000;

/** Appends one line every ~300ms so the SSE tail has distinct append frames. */
function pulse(i) {
  if (i >= count) return;
  const base = KINDS[i % KINDS.length];
  const ts = new Date(now - (count - 1 - i) * spacingMs).toISOString();
  const line = JSON.stringify({ ts, ...base });
  fs.appendFileSync(eventsPath, line + "\n");
  console.log(`appended: ${line}`);
  setTimeout(() => pulse(i + 1), 300);
}

pulse(0);
