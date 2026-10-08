#!/usr/bin/env node
// Seed a throwaway AGENTHOOK_HOME with fake profiles for `ah ui` visual checks (README.md here).
// Writes the same state files a receiver does (shapes per test/ui-rows.test.js / src/ui/rows.js):
// heartbeat.json, profile.json, server.pid, running.json, queue.json, held.json, refmeta.json,
// events.jsonl and logs/. Every TicketStatus appears at least once; timestamps are relative to
// now so nothing falls behind the dashboard's 24h stale filter. Not a test — `npm test` only
// globs test/*.test.js.
//
//   node test/fixtures/ui/seed.js <dir>
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node test/fixtures/ui/seed.js <dir>");
  process.exit(2);
}

const now = Date.now();
/** ISO timestamp `min` minutes ago. @param {number} min */
const ago = (min) => new Date(now - min * 60_000).toISOString();
/** dispatch.js's run-log name. @param {string} ts @param {string} step @param {string} ref */
const logName = (ts, step, ref) => `${ts.replace(/[:.]/g, "-")}-step-${step}-${ref}.log`;

/**
 * @typedef {object} Fixture
 * @property {string} key       state-dir name
 * @property {string} name      label
 * @property {boolean} up       pid 1 (always alive) vs no pidfile
 * @property {Record<string, any>} heartbeat
 * @property {Record<string, any>} running
 * @property {any[]} queue
 * @property {Record<string, any>} held
 * @property {Record<string, any>} refmeta
 * @property {Record<string, any>[]} events
 */

/** @type {Fixture[]} */
const fixtures = [
  {
    key: "agenthook",
    name: "agenthook",
    up: true,
    heartbeat: { tracker: "github", ingress: "ngrok", fullAuto: true, maxConcurrent: 3, port: 8787, repository: "Jesuso/agenthook", queue: { active: 2, queued: 1 } },
    running: {
      221: { stepId: "code", startedAt: ago(4), model: "opus" },
      218: { stepId: "review", startedAt: ago(12), model: "sonnet" },
    },
    queue: [{ kind: "pipeline", ref: "223", stepId: "triage", dedupKey: "step:triage:223" }],
    held: { 214: { stepId: "triage", reason: "Should archived profiles keep their webhooks?", heldAt: ago(90) } },
    refmeta: {
      221: { displayId: "#221", title: "Polish (1/11): design tokens, type scale, app header", url: "https://github.com/Jesuso/agenthook/issues/221", pr: 230 },
      218: { displayId: "#218", title: "Only start creates a profile's state dir", url: "https://github.com/Jesuso/agenthook/issues/218", pr: 219 },
      223: { displayId: "#223", title: "Polish (3/11): tickets table density", url: "https://github.com/Jesuso/agenthook/issues/223" },
      214: { displayId: "#214", title: "ah remove <name|key> — retire a profile", url: "https://github.com/Jesuso/agenthook/issues/214" },
      209: { displayId: "#209", title: "Decommission control command", url: "https://github.com/Jesuso/agenthook/issues/209", pr: 213 },
      207: { displayId: "#207", title: "Flaky watcher test on macOS", url: "https://github.com/Jesuso/agenthook/issues/207" },
      205: { displayId: "#205", title: "Doc: queue stages", url: "https://github.com/Jesuso/agenthook/issues/205" },
    },
    events: [
      { ts: ago(240), event: "run_start", ref: "209", step: "code", model: "opus" },
      { ts: ago(200), event: "run_end", ref: "209", step: "code", outcome: "advance", costUsd: 2.41 },
      { ts: ago(180), event: "merged", ref: "209", step: "" },
      { ts: ago(150), event: "run_start", ref: "207", step: "code", model: "sonnet" },
      { ts: ago(140), event: "run_end", ref: "207", step: "code", outcome: "fail", costUsd: 0.88 },
      { ts: ago(140), event: "failed", ref: "207", step: "code", reason: "npm test red: test/ui-watch.test.js" },
      { ts: ago(100), event: "run_start", ref: "214", step: "triage", model: "opus" },
      { ts: ago(90), event: "run_end", ref: "214", step: "triage", outcome: "hold", costUsd: 0.31 },
      { ts: ago(60), event: "run_start", ref: "205", step: "triage", model: "haiku" },
      { ts: ago(58), event: "run_end", ref: "205", step: "triage", outcome: "advance", costUsd: 0.04 },
      { ts: ago(12), event: "run_start", ref: "218", step: "review", model: "sonnet" },
      { ts: ago(5), event: "enqueued", ref: "223", step: "triage" },
      { ts: ago(4), event: "run_start", ref: "221", step: "code", model: "opus" },
    ],
  },
  {
    key: "acme-web",
    name: "acme-web",
    up: true,
    heartbeat: { tracker: "asana", ingress: "hosted", fullAuto: false, maxConcurrent: 2, port: 8790, queue: { active: 1, queued: 0 } },
    running: { 1209876543210: { stepId: "spec", startedAt: ago(2), model: "sonnet" } },
    queue: [],
    held: {},
    refmeta: {
      1209876543210: { displayId: "1209876543210", title: "Checkout: Apple Pay button misaligned", url: "https://app.asana.com/0/1/1209876543210" },
      1209876543199: { displayId: "1209876543199", title: "Add CSV export to reports", url: "https://app.asana.com/0/1/1209876543199" },
    },
    events: [
      { ts: ago(300), event: "run_start", ref: "1209876543199", step: "code", model: "opus" },
      { ts: ago(260), event: "run_end", ref: "1209876543199", step: "code", outcome: "advance", costUsd: 3.12 },
      { ts: ago(255), event: "pipeline_done", ref: "1209876543199", step: "done" },
      { ts: ago(2), event: "run_start", ref: "1209876543210", step: "spec", model: "sonnet" },
    ],
  },
  {
    key: "billing-jira",
    name: "billing",
    up: false,
    heartbeat: { tracker: "jira", ingress: "manual", fullAuto: false, maxConcurrent: 1, port: 8791, queue: { active: 0, queued: 0 } },
    running: {},
    queue: [],
    held: { "BILL-88": { stepId: "code", reason: "Which currency rounding mode — banker's or half-up?", heldAt: ago(30) } },
    refmeta: {
      "BILL-88": { displayId: "BILL-88", title: "Prorate mid-cycle plan changes" },
      "BILL-91": { displayId: "BILL-91", title: "Invoice PDF footer overflow" },
    },
    events: [
      { ts: ago(45), event: "run_start", ref: "BILL-88", step: "code", model: "opus" },
      { ts: ago(30), event: "run_end", ref: "BILL-88", step: "code", outcome: "hold", costUsd: 1.02 },
      { ts: ago(20), event: "run_start", ref: "BILL-91", step: "code", model: "sonnet" },
      { ts: ago(15), event: "run_end", ref: "BILL-91", step: "code", outcome: "fail", costUsd: 0.5 },
      { ts: ago(15), event: "failed", ref: "BILL-91", step: "code", reason: "claude -p exited 1" },
    ],
  },
];

for (const f of fixtures) {
  const dir = path.join(root, f.key);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  /** @param {string} name @param {any} v */
  const write = (name, v) => fs.writeFileSync(path.join(dir, name), typeof v === "string" ? v : JSON.stringify(v, null, 2));
  // Every dir under the registry reads as a profile, so the (stub) config lives in the state dir.
  const configPath = path.join(path.resolve(dir), "agenthook.config.json");
  fs.writeFileSync(configPath, "{}\n");
  const last = f.events.at(-1);
  write("heartbeat.json", {
    name: f.name,
    stateKey: f.key,
    pid: f.up ? 1 : 0,
    url: null,
    configPath,
    startedAt: ago(600),
    updatedAt: ago(f.up ? 0 : 15),
    lastEvent: last ? { at: last.ts, kind: last.event, ref: last.ref, step: last.step } : null,
    ...f.heartbeat,
  });
  write("profile.json", { configPath, stateKey: f.key, name: f.name, createdAt: ago(60 * 24 * 7), updatedAt: ago(600) });
  // pid 1 always exists (kill(1, 0) → EPERM, which isAlive counts as alive); a down profile has no pidfile.
  if (f.up) write("server.pid", "1");
  write("running.json", f.running);
  write("queue.json", f.queue);
  write("held.json", f.held);
  write("refmeta.json", f.refmeta);
  write("events.jsonl", f.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  for (const e of f.events) {
    if (e.event !== "run_start") continue;
    const body = `[fixture] ${e.step} run for ${e.ref}\n${"…agent output…\n".repeat(5)}`;
    fs.writeFileSync(path.join(dir, "logs", logName(e.ts, e.step, e.ref)), body);
  }
}

console.log(`seeded ${fixtures.length} profiles under ${path.resolve(root)}`);
