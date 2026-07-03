// Offline driver for the #54 capability-placement sweep.
//
// Runs the synthetic corpus through the REAL agenthook dispatcher/queue using the
// `local` tracker — no GitHub, no webhooks, no PRs. Each task flows triage -> code ->
// review -> done in a receiver-owned git worktree off the target repo; the worktree
// DIFF is the deliverable (describe().usesPR === false drops all PR language). Nothing
// is created on any remote. Worktrees are drained at the end (--keep to inspect).
//
// Usage:
//   node docs/experiments/run-sweep.mjs --sweep 0        --pilot
//   node docs/experiments/run-sweep.mjs --sweep P        --tasks E1,M1,H1
//   node docs/experiments/run-sweep.mjs --sweep C        --all --concurrency 4
//   node docs/experiments/run-sweep.mjs --sweep all      --pilot        # 0,P,C,R in sequence
//
// Flags:
//   --sweep 0|P|C|R|all   which tiering (default 0). all = run every config in sequence.
//   --pilot               3-task subset (one easy/medium/hard: E1,M1,H1).
//   --tasks ID,ID,...     explicit task ids from the corpus.
//   --all                 the full 20-task corpus.
//   --limit N             cap to the first N selected tasks.
//   --concurrency N       parallel agents within a wave (default = repo maxConcurrent or 4).
//   --repo PATH           repo the agents work in (default: this agenthook checkout).
//   --keep                keep worktrees + generated config after the run.
//   --dry                 print the plan (tasks, configs, models) and exit — spawns nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.js";
import { createStore } from "../../src/store.js";
import { createAdapter } from "../../src/trackers/index.js";
import { seedBoard, localBoardPath } from "../../src/trackers/local.js";
import { createDispatcher } from "../../src/dispatch.js";
import { drainWorktree, branchName } from "../../src/worktree.js";

/** best-effort git (ignore failures — cleanup is idempotent). @param {string} repo @param {string[]} a */
function git(repo, a) {
  try {
    return execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const CORPUS = path.join(HERE, "capability-placement-synthetic-corpus.json");

// ---- arg parsing ----
const argv = process.argv.slice(2);
/** @param {string} flag */
const has = (flag) => argv.includes(flag);
/** @param {string} flag @param {string} [dflt] */
const val = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const CHEAP = { model: "claude-sonnet-4-6", effort: "low" };
const STRONG = { model: "claude-opus-4-8", effort: "high" };
// each config overrides exactly one stage to STRONG (see #54).
const SWEEPS = {
  0: { triage: CHEAP, code: CHEAP, review: CHEAP },
  P: { triage: STRONG, code: CHEAP, review: CHEAP },
  C: { triage: CHEAP, code: STRONG, review: CHEAP },
  R: { triage: CHEAP, code: CHEAP, review: STRONG },
};

const repoPath = path.resolve(val("--repo", REPO_ROOT));
const sweepArg = val("--sweep", "0");
const sweepIds = sweepArg === "all" ? ["0", "P", "C", "R"] : [sweepArg];
for (const s of sweepIds) if (!SWEEPS[s]) throw new Error(`unknown --sweep "${s}" (use 0|P|C|R|all)`);

const corpus = JSON.parse(fs.readFileSync(CORPUS, "utf8"));
/** @type {Array<{id:string,difficulty:string,title:string,body:string}>} */
const allTasks = corpus.tasks;
let selected;
if (has("--tasks")) {
  const ids = String(val("--tasks", "")).split(",").map((s) => s.trim()).filter(Boolean);
  selected = ids.map((id) => allTasks.find((t) => t.id === id) || (() => { throw new Error(`no corpus task "${id}"`); })());
} else if (has("--all")) {
  selected = allTasks;
} else {
  // default / --pilot: one of each difficulty
  selected = ["E1", "M1", "H1"].map((id) => allTasks.find((t) => t.id === id));
}
const limit = Number(val("--limit", "0"));
if (limit > 0) selected = selected.slice(0, limit);

const concurrencyArg = Number(val("--concurrency", "0"));

// ---- build a `local` experiment profile for one sweep config ----
/** @param {string} sweepId */
function buildConfig(sweepId) {
  const tier = SWEEPS[sweepId];
  const instr = (f) => path.join(HERE, "sweep-instructions", f);
  const config = {
    name: `sweep-${sweepId}`,
    repoPath,
    worktreePrefix: path.join(os.tmpdir(), "agenthook-sweep-worktrees", sweepId),
    fullAuto: true,
    ingress: { type: "manual" },
    tracker: {
      type: "local",
      pipeline: [
        { id: "triage", kind: "triage", sourceStatus: "triage", successStatus: "code", failureStatus: "blocked", holdStatus: "held", instructionsFile: instr("triage.md"), ...tier.triage },
        { id: "code", kind: "implement", sourceStatus: "code", successStatus: "review", failureStatus: "blocked", createsWorktree: true, maxAttempts: 3, instructionsFile: instr("code.md"), ...tier.code },
        { id: "review", kind: "review", sourceStatus: "review", successStatus: "done", failureStatus: "blocked", instructionsFile: instr("review.md"), ...tier.review },
        { id: "done", manual: true, sourceStatus: "done", drainWorktree: true },
      ],
    },
  };
  const file = path.join(os.tmpdir(), `agenthook-sweep-${sweepId}.config.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

/** simple bounded-concurrency map. @template T,R @param {T[]} items @param {number} n @param {(item:T,i:number)=>Promise<R>} fn */
async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, n), items.length) }, worker));
  return results;
}

/** @param {string} sweepId */
async function runSweep(sweepId) {
  const configFile = buildConfig(sweepId);
  const cfg = loadConfig({ configPath: configFile });
  const concurrency = concurrencyArg > 0 ? concurrencyArg : cfg.maxConcurrent > 1 ? cfg.maxConcurrent : 4;

  // Refs are namespaced by config so branches/worktrees never collide across configs
  // (branchName is agent/<ref>, config-blind) or with an earlier run of the same config.
  const refOf = (t) => `${sweepId}-${t.id}`;

  // fresh state for a clean measurement (no shared attempts/usage/difficulty).
  for (const f of ["attempts.json", "difficulty.json", "running.json", "usage.jsonl", "seen.json"]) {
    fs.rmSync(path.join(cfg.dataDir, f), { force: true });
  }
  // Clean any leftover worktree/branch for these refs so a re-run starts from master,
  // not a prior run's committed code (contamination).
  for (const t of selected) {
    const ref = refOf(t);
    try { drainWorktree(cfg, ref); } catch { /* none */ }
    git(cfg.repoPath, ["worktree", "prune"]);
    git(cfg.repoPath, ["branch", "-D", branchName(ref)]);
  }
  seedBoard(cfg, selected.map((t) => ({ ref: refOf(t), name: `[${t.id} ${t.difficulty}] ${t.title}`, description: t.body })), "triage");

  const store = createStore(cfg.dataDir);
  const adapter = createAdapter(cfg, store);
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const children = new Set();
  const runClaude = createDispatcher(cfg, adapter, children, store);

  console.log(`\n=== sweep ${sweepId} — ${selected.length} task(s), concurrency ${concurrency} ===`);
  console.log(`    triage=${SWEEPS[sweepId].triage.model}/${SWEEPS[sweepId].triage.effort}  code=${SWEEPS[sweepId].code.model}/${SWEEPS[sweepId].code.effort}  review=${SWEEPS[sweepId].review.model}/${SWEEPS[sweepId].review.effort}`);

  let wave = 0;
  for (;;) {
    const jobs = await adapter.listResting();
    if (!jobs.length) break;
    if (++wave > 60) throw new Error(`sweep ${sweepId}: too many waves — aborting (loop?)`);
    console.log(`[wave ${wave}] ${jobs.map((j) => `${j.stepId}:${j.ref}`).join(", ")}`);
    await pool(jobs, concurrency, (job) =>
      runClaude(job).catch((e) => console.error(`  run ${job.stepId}:${job.ref} failed:`, e?.message || e)),
    );
  }

  // Collect results: final stage per task + per-(ref,step) token/cost from usage.jsonl.
  const board = JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"));
  /** @type {any[]} */
  const usage = [];
  try {
    for (const line of fs.readFileSync(path.join(cfg.dataDir, "usage.jsonl"), "utf8").split("\n")) {
      if (line.trim()) usage.push(JSON.parse(line));
    }
  } catch { /* no usage */ }
  let attempts = {};
  try { attempts = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, "attempts.json"), "utf8")); } catch { /* none */ }

  const results = selected.map((t) => {
    const ref = refOf(t);
    const rows = usage.filter((u) => String(u.ref) === ref);
    const cost = rows.reduce((a, u) => a + (u.costUsd || 0), 0);
    const inTok = rows.reduce((a, u) => a + (u.input || 0), 0);
    const outTok = rows.reduce((a, u) => a + (u.output || 0), 0);
    const codeAttempts = attempts?.[ref]?.code || 0;
    const finalStage = board[ref]?.stage || "?";
    return { id: t.id, difficulty: t.difficulty, finalStage, accepted: finalStage === "done", rework: Math.max(0, codeAttempts - 1), costUsd: +cost.toFixed(4), input: inTok, output: outTok, runs: rows.length };
  });

  // drain worktrees + delete branches (done step is manual + skipped by the driver loop).
  if (!has("--keep")) {
    for (const t of selected) {
      const ref = refOf(t);
      try { drainWorktree(cfg, ref); } catch { /* ignore */ }
      git(cfg.repoPath, ["worktree", "prune"]);
      git(cfg.repoPath, ["branch", "-D", branchName(ref)]);
    }
    fs.rmSync(configFile, { force: true });
  }
  return { sweep: sweepId, results };
}

// ---- main ----
console.log(`repo: ${repoPath}`);
console.log(`tasks: ${selected.map((t) => t.id).join(", ")}`);
console.log(`sweeps: ${sweepIds.join(", ")}`);
if (has("--dry")) {
  for (const s of sweepIds) console.log(`  sweep ${s}:`, JSON.stringify(SWEEPS[s]));
  console.log("(dry run — nothing spawned)");
  process.exit(0);
}

const outDir = path.join(HERE, "results");
fs.mkdirSync(outDir, { recursive: true });
/** @type {any[]} */
const all = [];
for (const s of sweepIds) all.push(await runSweep(s));

// summary table + per-difficulty accept rate.
console.log(`\n================ SWEEP SUMMARY ================`);
for (const { sweep, results } of all) {
  const acc = results.filter((r) => r.accepted).length;
  const cost = results.reduce((a, r) => a + r.costUsd, 0);
  console.log(`\nconfig ${sweep}: accept ${acc}/${results.length}  cost $${cost.toFixed(2)}`);
  for (const diff of ["easy", "medium", "hard"]) {
    const rs = results.filter((r) => r.difficulty === diff);
    if (!rs.length) continue;
    const a = rs.filter((r) => r.accepted).length;
    const c = rs.reduce((x, r) => x + r.costUsd, 0);
    console.log(`  ${diff.padEnd(6)} accept ${a}/${rs.length}  cost $${c.toFixed(2)}  rework ${rs.reduce((x, r) => x + r.rework, 0)}`);
  }
  for (const r of results) console.log(`    ${r.id.padEnd(4)} ${r.difficulty.padEnd(6)} ${r.accepted ? "ACCEPT" : r.finalStage.padEnd(7)} $${r.costUsd.toFixed(3)} in=${r.input} out=${r.output} rework=${r.rework}`);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = path.join(outDir, `sweep-${sweepArg}-${stamp}.json`);
fs.writeFileSync(outFile, JSON.stringify({ repo: repoPath, tasks: selected.map((t) => t.id), runs: all }, null, 2) + "\n");
console.log(`\nwrote ${outFile}`);
