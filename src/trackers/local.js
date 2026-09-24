// Local / offline tracker — no SaaS, no webhooks, no network. The "board" is a JSON
// file in the profile's dataDir; a task's stage is a plain string that a step binds
// via the Jira-style status keys (sourceStatus / successStatus / failureStatus /
// holdStatus). advance() rewrites the stage in that file; there is no HTTP round-trip,
// so the chaining that a webhook normally provides is driven by a caller that polls
// listResting() (see docs/experiments/run-sweep.mjs).
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

/** @typedef {{ name: string, description?: string, url?: string, stage: string }} LocalItem */

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
 * @param {Array<{ref: string, name: string, description?: string, url?: string}>} tasks
 * @param {string} stage  the stage to place every task in (a step's sourceStatus)
 */
export function seedBoard(cfg, tasks, stage) {
  /** @type {Record<string, LocalItem>} */
  const board = {};
  for (const t of tasks) {
    board[String(t.ref)] = { name: t.name, description: t.description || "", url: t.url || `local://${t.ref}`, stage };
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
    chain = chain.then(() => {
      const board = readBoard(cfg);
      mutate(board);
      writeBoard(cfg, board);
    });
    return chain;
  }

  /** @param {string} id */
  const stepById = (id) => findStep(cfg, id);
  /** Which non-manual step sources this stage (its sourceStatus)? @param {string|undefined} stage */
  const stepBySourceStage = (stage) => (stage ? pipeline?.find((s) => !s.manual && s.sourceStatus === stage) : undefined);
  /** Is this stage terminal (a manual step's source, or bound to no non-manual step)? @param {string} stage */
  const isTerminal = (stage) => !stepBySourceStage(stage);

  return {
    describe: () => ({
      platform: "Local",
      taskNoun: "task",
      trigger: cfg.trigger || "@agent",
      commentHowTo: "this is a local offline run — do not post comments anywhere; put any note in the verdict `reason`",
      usesPR: false,
    }),

    // Offline: nothing authenticates over HTTP. Accept so a stray POST (e.g. a test
    // harness driving the server) doesn't 401.
    authenticate: () => ({ type: "accept" }),

    // No webhooks — events never arrive over HTTP. The driver injects work by seeding
    // the board and polling listResting(), so processEvents yields nothing.
    processEvents: async () => [],

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
      await update((board) => {
        const it = board[String(ref)];
        if (it) it.stage = /** @type {string} */ (stage);
      });
      console.log(`[stage] moved ${ref} -> ${stage} (${stepId}:${outcome}${outcome === "changes" ? `->${target}` : ""})`);
    },

    /** @param {string} ref @param {string} stepId */
    async enterStage(ref, stepId) {
      const step = stepById(stepId);
      if (!step || !step.sourceStatus) throw new Error(`local: step "${stepId}" has no sourceStatus to enter`);
      const source = step.sourceStatus;
      await update((board) => {
        const it = board[String(ref)];
        if (!it) throw new Error(`local: no task "${ref}" on the board`);
        it.stage = source;
      });
      return { stage: source };
    },

    async currentStage(ref) {
      const board = readBoard(cfg);
      return board[String(ref)]?.stage ?? null;
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

    // No webhooks to manage.
    registerWebhook: async () => {},
    unregisterWebhooks: async () => {},
  };
}
