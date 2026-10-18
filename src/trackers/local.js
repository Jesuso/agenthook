// Local / offline tracker — no SaaS, no webhooks, no network. The "board" is a JSON
// file in the profile's dataDir; a task's stage is a plain string that a step binds
// via the Jira-style status keys (sourceStatus / successStatus / failureStatus /
// holdStatus). advance()/enterStage() rewrite the stage in that file; there is no HTTP
// round-trip, so the event a webhook normally delivers is PUSHED in-process instead: the
// engine wires a sink via onJobs(), and every committed move into a step's source stage
// (manual steps included — a `done` step needs its own job to drain) emits one job,
// keyed `secmove:<n>` off a counter in its own file (local-seq.json). No polling. With no
// sink wired (the offline driver, tests) nothing is pushed and a caller drives the
// pipeline by polling listResting() (see docs/experiments/run-sweep.mjs).
//
// Why it exists: it lets the REAL engine/dispatcher/queue run end-to-end with zero
// external side effects — useful for tests, demos, and offline evals (e.g. the #54
// capability-placement sweep, which must run the corpus through the pipeline WITHOUT
// creating GitHub issues or PRs). describe().usesPR is false, so the prompt builders
// drop all PR language: the code step's worktree DIFF is the deliverable and review
// reads it with `git diff`, never `gh pr`.
//
// Implements the same interface as the other trackers (see asana.js / github.js for the
// canonical doc-comments). No assignee scoping — a local board is single-tenant/trusted.
import fs from "node:fs";
import path from "node:path";
import { findStep } from "../pipeline.js";

/** The board file backing a local profile. @param {import('../types.js').Config} cfg */
export function localBoardPath(cfg) {
  return path.join(cfg.dataDir, "local-board.json");
}

/** The move-counter file. Apart from the board on purpose: seedBoard overwrites the board,
 * and a counter reset with it would reuse `secmove:` keys already in seen.json (dropped moves).
 * @param {import('../types.js').Config} cfg */
export function localSeqPath(cfg) {
  return path.join(cfg.dataDir, "local-seq.json");
}

/** Bump and persist the move counter; returns the new value. @param {import('../types.js').Config} cfg */
function nextSeq(cfg) {
  let n = 0;
  try {
    n = Number(JSON.parse(fs.readFileSync(localSeqPath(cfg), "utf8")).seq) || 0;
  } catch {}
  n++;
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(localSeqPath(cfg), JSON.stringify({ seq: n }) + "\n");
  return n;
}

/** The step (manual included) whose sourceStatus is `stage`. @param {import('../types.js').Config} cfg @param {string|undefined} stage */
const stepSourcing = (cfg, stage) => (stage ? cfg.pipeline?.find((s) => s.sourceStatus === stage) : undefined);

/**
 * The job a task CREATED in `stage` carries (the "add ticket" path), keyed `step:<id>:<ref>`
 * like a webhook tracker's created-in-section event — or null when no step sources `stage`.
 * Push it through the adapter's onJobs sink; a refused enqueue un-marks the state key.
 * @param {import('../types.js').Config} cfg @param {string} ref @param {string} stage
 * @returns {import('../types.js').Job | null}
 */
export function createdJob(cfg, ref, stage) {
  const step = stepSourcing(cfg, stage);
  return step ? { kind: "pipeline", ref: String(ref), stepId: step.id, dedupKey: `step:${step.id}:${ref}` } : null;
}

/** @typedef {{ name: string, description?: string, url?: string, stage: string, [key: string]: any }} LocalItem */

/**
 * Raw route keys from the top-level key `routeField` of a board item: a string → [s],
 * an array → its non-empty strings. Unset/absent/other → [].
 * @param {Record<string, any>} item
 * @param {string | undefined} routeField
 * @returns {string[]}
 */
export function extractRouteKeys(item, routeField) {
  if (!routeField) return [];
  const v = item?.[routeField];
  const vs = Array.isArray(v) ? v : [v];
  return vs.filter((x) => typeof x === "string" && x.trim() !== "");
}

/** Read the board (missing file → empty). @param {import('../types.js').Config} cfg
 * @returns {Record<string, LocalItem>} */
function readBoard(cfg) {
  try {
    return JSON.parse(fs.readFileSync(localBoardPath(cfg), "utf8"));
  } catch {
    return {};
  }
}
/** @param {import('../types.js').Config} cfg @param {Record<string, LocalItem>} board */
function writeBoard(cfg, board) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(localBoardPath(cfg), JSON.stringify(board, null, 2) + "\n");
}

/**
 * Seed (or reset) the board: place each task at a starting stage. Used by the offline
 * driver to inject a corpus. Overwrites any existing board.
 * @param {import('../types.js').Config} cfg
 * @param {Array<{ref: string, name: string, description?: string, url?: string, [key: string]: any}>} tasks
 * @param {string} stage  the stage to place every task in (a step's sourceStatus)
 */
export function seedBoard(cfg, tasks, stage) {
  /** @type {Record<string, LocalItem>} */
  const board = {};
  for (const { ref, ...t } of tasks) {
    board[String(ref)] = { ...t, name: t.name, description: t.description || "", url: t.url || `local://${ref}`, stage };
  }
  writeBoard(cfg, board);
  return board;
}

/** @type {import('../types.js').AdapterFactory} */
export function createLocalAdapter(cfg, _store) {
  const pipeline = cfg.pipeline;

  // The board is a single JSON file; concurrent advances (parallel agents in one run)
  // would race on read-modify-write and lose updates. Serialize every mutation through
  // one promise chain so each read+mutate+write is atomic within this process.
  let chain = Promise.resolve();
  /** @param {(board: Record<string, LocalItem>) => void} mutate @returns {Promise<void>} */
  function update(mutate) {
    const done = chain.then(() => {
      const board = readBoard(cfg);
      mutate(board);
      writeBoard(cfg, board);
    });
    chain = done.catch(() => {}); // a refused mutation (missing task) must not wedge later ones
    return done;
  }

  // The engine's intake sink (onJobs); unset → moves push nothing (offline driver, tests).
  /** @type {((jobs: import('../types.js').Job[]) => void) | null} */
  let sink = null;
  /**
   * Move `ref` to `stage`, then — once the write has landed — push one job when a step
   * sources the new stage. The counter bumps in the same serialized chain as the write.
   * @param {string} ref @param {string} stage @param {boolean} [mustExist]  throw on a missing task
   */
  async function moveTo(ref, stage, mustExist = false) {
    const step = sink ? stepSourcing(cfg, stage) : undefined;
    /** @type {number|undefined} */
    let seq;
    await update((board) => {
      const it = board[String(ref)];
      if (!it) {
        if (mustExist) throw new Error(`local: no task "${ref}" on the board`);
        return;
      }
      it.stage = stage;
      if (step) seq = nextSeq(cfg);
    });
    if (step && seq != null) sink?.([{ kind: "pipeline", ref: String(ref), stepId: step.id, dedupKey: `secmove:${seq}` }]);
  }

  /** @param {string} id */
  const stepById = (id) => findStep(cfg, id);
  /** Which non-manual step sources this stage (its sourceStatus)? @param {string|undefined} stage */
  const stepBySourceStage = (stage) => (stage ? pipeline?.find((s) => !s.manual && s.sourceStatus === stage) : undefined);
  /** Every stage the pipeline binds (any step's source/success/failure/hold/queue status). */
  const boundStages = () => {
    /** @type {Set<string>} */
    const stages = new Set();
    /** @type {Array<keyof import('../types.js').Step>} */
    const keys = ["sourceStatus", "successStatus", "failureStatus", "holdStatus", "queueStatus"];
    for (const step of pipeline || [])
      for (const key of keys) {
        const v = step[key];
        if (typeof v === "string") stages.add(v);
      }
    return stages;
  };
  /** Is this stage terminal: pipeline-bound but sourcing no non-manual step (done, failure, hold)?
   * An unbound stage (e.g. `backlog`) is not — the item has not entered the pipeline yet. @param {string} stage */
  const isTerminal = (stage) => !stepBySourceStage(stage) && boundStages().has(stage);

  return {
    describe: () => ({
      platform: "Local",
      taskNoun: "task",
      trigger: cfg.trigger || "@agent",
      commentHowTo: "this is a local offline run — do not post comments anywhere; put any note in the verdict `reason`",
      usesPR: false,
      stageKeys: { source: "sourceStatus", success: "successStatus", failure: "failureStatus", hold: "holdStatus", queue: "queueStatus" },
    }),

    // No network: the union of every …Status bound in the pipeline plus every stage
    // currently sitting on the board. id === label (stages are free strings here).
    async listStages() {
      const stages = boundStages();
      for (const it of Object.values(readBoard(cfg))) if (it.stage) stages.add(it.stage);
      return [...stages].map((s) => ({ id: s, label: s }));
    },

    // Offline: nothing authenticates over HTTP. Accept so a stray POST (e.g. a test
    // harness driving the server) doesn't 401.
    authenticate: () => ({ type: "accept" }),

    // No webhooks — events never arrive over HTTP. They are pushed in-process through
    // the onJobs sink instead (or, unwired, the driver polls listResting()).
    processEvents: async () => [],

    /** @param {(jobs: import('../types.js').Job[]) => void} emit */
    onJobs(emit) {
      sink = emit;
    },

    async fetchTask(ref) {
      const board = readBoard(cfg);
      const it = board[String(ref)];
      if (!it) throw new Error(`local: no task "${ref}" on the board`);
      return {
        ref: String(ref),
        name: it.name,
        description: it.description || "",
        url: it.url || `local://${ref}`,
        completed: isTerminal(it.stage),
        assignedToUs: true,
        displayId: String(ref),
        routeKeys: extractRouteKeys(it, cfg.providerConfig?.routeField),
      };
    },

    // Move the task's stage per the verdict, mirroring the other trackers:
    //   advance → successStatus (the next step's source — drives forward)
    //   fail    → failureStatus
    //   hold    → holdStatus (absent → leave in place)
    //   changes → the target step's sourceStatus (dispatch already resolved target)
    // A missing target stage leaves the task where it is (logged), same as github.js.
    async advance(ref, stepId, verdict) {
      const step = stepById(stepId);
      if (!step) return;
      const { outcome, target } = verdict;
      let stage;
      if (outcome === "advance") stage = step.successStatus;
      else if (outcome === "fail") stage = step.failureStatus;
      else if (outcome === "hold") stage = step.holdStatus;
      else if (outcome === "changes" && target) stage = stepById(target)?.sourceStatus;
      if (!stage) {
        console.log(`[advance] ${stepId} ${outcome}: no target stage — leaving ${ref} in place`);
        return;
      }
      await moveTo(ref, stage);
      console.log(`[stage] moved ${ref} -> ${stage} (${stepId}:${outcome}${outcome === "changes" ? `->${target}` : ""})`);
    },

    /** @param {string} ref @param {string} stepId */
    async enterStage(ref, stepId) {
      const step = stepById(stepId);
      if (!step || !step.sourceStatus) throw new Error(`local: step "${stepId}" has no sourceStatus to enter`);
      const source = step.sourceStatus;
      await moveTo(ref, source, true);
      return { stage: source };
    },

    // The pipeline-bound stage the task rests in, or null (an unbound stage like `backlog`
    // is not "in the pipeline") — mirrors github.js, so `run` can enter a backlog item.
    async currentStage(ref) {
      const stage = readBoard(cfg)[String(ref)]?.stage;
      return stage && boundStages().has(stage) ? stage : null;
    },

    // Every task resting in a (non-manual) step's source stage, as a pipeline job for
    // that step. This IS the offline driver's work source (a webhook would normally
    // deliver these). Manual/terminal stages are skipped — a task there is done.
    async listResting() {
      if (!pipeline) return [];
      const board = readBoard(cfg);
      /** @type {import('../types.js').Job[]} */
      const jobs = [];
      for (const [ref, it] of Object.entries(board)) {
        const step = stepBySourceStage(it.stage);
        if (!step) continue;
        jobs.push({ kind: "pipeline", ref, stepId: step.id, dedupKey: `local:${step.id}:${ref}:${it.stage}` });
      }
      return jobs;
    },

    // Tasks resting in the step's opt-in queueStatus, in board-file order. No
    // assignee scoping (single-tenant). [] without the key.
    /** @param {string} stepId */
    async listQueued(stepId) {
      const step = stepById(stepId);
      if (!step?.queueStatus || step.manual) return [];
      return Object.entries(readBoard(cfg))
        .filter(([, it]) => it.stage === step.queueStatus)
        .map(([ref]) => ref);
    },

    // No webhooks to manage.
    registerWebhook: async () => {},
    unregisterWebhooks: async () => {},
  };
}
