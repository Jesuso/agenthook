#!/usr/bin/env node
// Seed a throwaway AGENTHOOK_HOME with fake profiles for `ah ui` visual checks (README.md here).
// Writes the same state files a receiver does (shapes per test/ui-rows.test.js / src/ui/rows.js):
// heartbeat.json, profile.json, server.pid, running.json, queue.json, held.json, refmeta.json,
// events.jsonl and logs/. Every TicketStatus appears at least once; timestamps are relative to
// now so nothing falls behind the dashboard's 24h stale filter. Not a test — `npm test` only
// globs test/*.test.js.
//
//   node test/fixtures/ui/seed.js <dir> [--bulk <n>]
//
// `--bulk <n>` (opt-in) adds n recent `done` tickets to the "agenthook" profile so the tickets
// table's paging and scroll region show up; without it the seed is unchanged.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const bulkAt = args.indexOf("--bulk");
const bulk = bulkAt === -1 ? 0 : Number(args.splice(bulkAt, 2)[1]);
const root = args[0];
if (!root || !Number.isInteger(bulk) || bulk < 0) {
  console.error("usage: node test/fixtures/ui/seed.js <dir> [--bulk <n>]");
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
 * @property {Record<string, any>} [config]  the stub agenthook.config.json (default `{}`)
 * @property {{ file: string, scope: 'step'|'default'|'repo', ids: string[] }[]} [instructions]
 */

/** A dogfood-style agent step on GitHub labels. @param {string} id @param {string} kind @param {string} next */
const agent = (id, kind, next) => ({
  id,
  kind,
  sourceLabel: `agent:${id}`,
  successLabel: `agent:${next}`,
  failureLabel: "agent:blocked",
  holdLabel: "agent:needs-info",
});

/** @type {Fixture[]} */
const fixtures = [
  {
    key: "agenthook",
    name: "agenthook",
    up: true,
    heartbeat: { tracker: "github", ingress: "ngrok", fullAuto: true, maxConcurrent: 3, port: 8787, repository: "Jesuso/agenthook", queue: { active: 2, queued: 1 } },
    // Pipeline order (triage, code, review) sorts differently than alphabetical (code, review, triage) —
    // exercises the step → default → repo, no-resort ordering the Instructions view must preserve.
    instructions: [
      { file: "triage.md", scope: "step", ids: ["triage"] },
      { file: "code.md", scope: "step", ids: ["code"] },
      { file: "review.md", scope: "step", ids: ["review"] },
      { file: "default.md", scope: "default", ids: ["merge"] },
      { file: "repo.md", scope: "repo", ids: ["agenthook"] },
    ],
    running: {
      221: { stepId: "code", startedAt: ago(4), model: "opus" },
      218: { stepId: "review", startedAt: ago(12), model: "sonnet" },
    },
    // The dogfood pipeline, so the Config view's pipeline graph has something to draw.
    config: {
      name: "agenthook",
      repoPath: "/tmp/agenthook",
      tracker: {
        type: "github",
        repository: "Jesuso/agenthook",
        pipeline: [
          { ...agent("triage", "triage", "code"), model: "claude-opus-5-5", effort: "high", queueLabel: "agent:backlog" },
          { ...agent("code", "implement", "review"), model: "claude-sonnet-5", effort: "medium", createsWorktree: true },
          { ...agent("review", "review", "done"), model: "claude-opus-5-5", effort: "high" },
          { id: "done", manual: true, drainWorktree: true, sourceLabel: "agent:done" },
        ],
      },
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
    heartbeat: { tracker: "asana", ingress: "hosted", fullAuto: false, maxConcurrent: 2, port: 8790, queue: { active: 2, queued: 0 } },
    // 1209876543210987 has a refmeta displayId (ID-2872, per issue #223's example); 1209876543210988
    // has none — its ticket falls back to the bare ref as displayId and a null title, exercising
    // the "no cached title yet" / "no matching displayId" fallbacks in the dashboard.
    running: {
      1209876543210987: { stepId: "review", startedAt: ago(12), model: "sonnet" },
      1209876543210988: { stepId: "spec", startedAt: ago(2), model: "sonnet" },
    },
    queue: [],
    held: {},
    refmeta: {
      1209876543210987: { displayId: "ID-2872", title: "Checkout: Apple Pay button misaligned", url: "https://app.asana.com/0/1/1209876543210987" },
      1209876543199: { displayId: "ID-2871", title: "Add CSV export to reports", url: "https://app.asana.com/0/1/1209876543199" },
    },
    events: [
      { ts: ago(300), event: "run_start", ref: "1209876543199", step: "code", model: "opus" },
      { ts: ago(260), event: "run_end", ref: "1209876543199", step: "code", outcome: "advance", costUsd: 3.12 },
      { ts: ago(255), event: "pipeline_done", ref: "1209876543199", step: "done" },
      { ts: ago(12), event: "run_start", ref: "1209876543210987", step: "review", model: "sonnet" },
      { ts: ago(2), event: "run_start", ref: "1209876543210988", step: "spec", model: "sonnet" },
    ],
  },
  {
    key: "billing-jira",
    name: "billing",
    up: false,
    heartbeat: { tracker: "jira", ingress: "manual", fullAuto: false, maxConcurrent: 1, port: 8791, queue: { active: 1, queued: 1 } },
    // Leftover from before the receiver died: a down profile's in-flight run reads as
    // `interrupted` and its queued job as `stalled` (#222) — the receiver resolves both on its
    // next boot (recoverInterrupted/restoreQueued), not live.
    running: { "BILL-229": { stepId: "code", startedAt: ago(60 * 24 * 14), model: "sonnet" } },
    queue: [{ kind: "pipeline", ref: "BILL-232", stepId: "review", dedupKey: "k-bill-232" }],
    held: { "BILL-88": { stepId: "code", reason: "Which currency rounding mode — banker's or half-up? Finance's spreadsheet uses half-up but the ledger service rounds to even, and the two disagree on 3% of invoices.", heldAt: ago(30) } },
    refmeta: {
      "BILL-88": { displayId: "BILL-88", title: "Prorate mid-cycle plan changes" },
      "BILL-91": { displayId: "BILL-91", title: "Invoice PDF footer overflow" },
      "BILL-229": { displayId: "BILL-229", title: "Flaky retry on 502 from tracker" },
      "BILL-232": { displayId: "BILL-232", title: "Dedup key collision on re-enqueue" },
    },
    events: [
      { ts: ago(45), event: "run_start", ref: "BILL-88", step: "code", model: "opus" },
      { ts: ago(30), event: "run_end", ref: "BILL-88", step: "code", outcome: "hold", costUsd: 1.02 },
      { ts: ago(20), event: "run_start", ref: "BILL-91", step: "code", model: "sonnet" },
      { ts: ago(15), event: "run_end", ref: "BILL-91", step: "code", outcome: "fail", costUsd: 0.5 },
      { ts: ago(15), event: "failed", ref: "BILL-91", step: "code", reason: "claude -p exited 1" },
      { ts: ago(60 * 24 * 14), event: "run_start", ref: "BILL-229", step: "code", model: "sonnet" },
    ],
  },
];

// --bulk: n `done` tickets on the first (up) profile, spread over the last ~23h so none is stale.
// Refs start at 1000, clear of the hand-written ones; models mix full ids and bare aliases.
const BULK_MODELS = ["claude-opus-5-5", "claude-sonnet-5", "opus", "claude-haiku-5-5", "sonnet"];
const BULK_TITLES = ["Retry webhook delivery on 5xx", "Tighten worktree cleanup", "Doc: multi-repo routing", "Cap rework loop per step", "Jira transition lookup cache"];
const spacing = bulk ? Math.max(1, Math.floor((60 * 23 - 30) / bulk)) : 0;
for (let i = 0; i < bulk; i++) {
  const f = fixtures[0];
  const ref = String(1000 + i);
  const start = 30 + i * spacing;
  f.refmeta[ref] = {
    displayId: `#${ref}`,
    title: `${BULK_TITLES[i % BULK_TITLES.length]} (${i + 1})`,
    url: `https://github.com/Jesuso/agenthook/issues/${ref}`,
    ...(i % 3 === 0 ? { pr: 2000 + i } : {}),
  };
  // Prepended, so the heartbeat's lastEvent (the file's last line) stays the same.
  f.events.unshift(
    { ts: ago(start), event: "run_start", ref, step: "code", model: BULK_MODELS[i % BULK_MODELS.length] },
    { ts: ago(start - 1), event: "run_end", ref, step: "code", outcome: "advance", costUsd: 0.1 + (i % 7) * 0.37 },
    { ts: ago(start - 1), event: "pipeline_done", ref, step: "done" },
  );
}

for (const f of fixtures) {
  const dir = path.join(root, f.key);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  /** @param {string} name @param {any} v */
  const write = (name, v) => fs.writeFileSync(path.join(dir, name), typeof v === "string" ? v : JSON.stringify(v, null, 2));
  // Every dir under the registry reads as a profile, so the (stub) config lives in the state dir.
  const configPath = path.join(path.resolve(dir), "agenthook.config.json");
  fs.writeFileSync(configPath, JSON.stringify(f.config ?? {}, null, 2) + "\n");
  const last = f.events.at(-1);
  /** @type {{ path: string, scope: 'step'|'default'|'repo', ids: string[] }[] | undefined} */
  const instructions = f.instructions?.map((i) => ({ ...i, path: path.join(path.resolve(dir), "instr", i.file) }));
  if (instructions) {
    fs.mkdirSync(path.join(dir, "instr"), { recursive: true });
    for (const i of instructions) fs.writeFileSync(i.path, `# ${i.scope} — ${i.ids.join(", ")}\n\nStanding instructions for ${f.name}.\n`);
  }
  write("heartbeat.json", {
    name: f.name,
    stateKey: f.key,
    pid: f.up ? 1 : 0,
    url: null,
    configPath,
    startedAt: ago(600),
    updatedAt: ago(f.up ? 0 : 15),
    // lastEvent.kind is the job kind (`pipeline`/`merge`/`ci`) written at intake — not the
    // events.jsonl event name (src/engine.js intake()).
    lastEvent: last ? { at: last.ts, kind: "pipeline", ref: last.ref, step: last.step } : null,
    ...(instructions ? { instructions: instructions.map(({ file, ...i }) => i) } : {}),
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

// A ghost: nothing but an empty logs/ — some command read a config named "scratch" and never ran
// (isFreshStateDir in src/profile.js). No heartbeat.json, no profile.json, no server.pid.
const ghostDir = path.join(root, "scratch");
fs.mkdirSync(path.join(ghostDir, "logs"), { recursive: true });

// A down profile whose owning config file has since been deleted (profileMeta's configMissing).
const missingDir = path.join(root, "deprecated-client");
fs.mkdirSync(path.join(missingDir, "logs"), { recursive: true });
const missingConfigPath = path.join(path.resolve(root), "deprecated-client.config.json");
fs.writeFileSync(path.join(missingDir, "profile.json"), JSON.stringify({ configPath: missingConfigPath, stateKey: "deprecated-client", name: "deprecated-client", createdAt: ago(60 * 24 * 90), updatedAt: ago(60 * 24 * 60) }));
fs.writeFileSync(path.join(missingDir, "running.json"), "{}");
fs.writeFileSync(path.join(missingDir, "queue.json"), "[]");
fs.writeFileSync(path.join(missingDir, "held.json"), "{}");
fs.writeFileSync(path.join(missingDir, "refmeta.json"), "{}");
fs.writeFileSync(path.join(missingDir, "events.jsonl"), "");
// configMissing requires the file be gone — never write missingConfigPath.

console.log(`seeded ${fixtures.length + 2} profiles under ${path.resolve(root)}`);
