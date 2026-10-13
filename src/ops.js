// Operator commands served over the control socket (src/control.js) — the live half of the
// agent-facing surface (`agenthook mcp`, docs/mcp.md). Reads that need the tracker/forge
// (`board`, `prs`) and writes that need the engine (`pause`, `cancel`, `run`, …) live here;
// everything readable from the state dir is read by the MCP process directly, receiver up or not.
//
// Every write is audited to <stateDir>/control-audit.jsonl (0600) with the caller's `actor`.
// Writes never bypass a gate: `run` is the `agenthook run` move (the webhook then fires the
// step), `release` reuses the `@agent` resume gate (held + under the attempt cap), and the
// dispatcher's own fail-closed assignee check still decides whether any agent spawns.
import fs from "node:fs";
import path from "node:path";
import { isPipeline, findStep, resumeJob, queueStageOf } from "./pipeline.js";
import { entryBlock } from "./commands/run.js";
import { runReconcile } from "./commands/reconcile.js";
import { isStateDedupKey } from "./store.js";

const BOARD_TTL_MS = 30 * 1000;
const COMMENT_MAX = 8000;

/** @param {any} v @param {string} what */
function needString(v, what) {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} is required`);
  return v.trim();
}

/**
 * TTL cache: concurrent calls share one in-flight fetch, failures are never cached.
 * @template T
 * @param {() => Promise<T>} fn @param {number} ttlMs @param {() => number} now
 * @returns {(() => Promise<T>) & {reset(): void}}
 */
export function ttlCache(fn, ttlMs, now = Date.now) {
  /** @type {{value: T, at: number}|null} */
  let hit = null;
  /** @type {Promise<T>|null} */
  let pending = null;
  const get = () => {
    if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    if (pending) return pending;
    pending = fn().then(
      (value) => {
        hit = { value, at: now() };
        pending = null;
        return value;
      },
      (e) => {
        pending = null;
        throw e;
      },
    );
    return pending;
  };
  return Object.assign(get, { reset: () => void (hit = null) });
}

/**
 * @param {{
 *   cfg: import('./types.js').Config,
 *   store: import('./types.js').Store,
 *   adapter: import('./types.js').Adapter,
 *   forge: import('./types.js').Forge|null,
 *   queue: ReturnType<typeof import('./queue.js').createQueue>,
 *   cancelRun: (ref: string) => boolean,
 *   intake: (jobs: import('./types.js').Job[], opts?: {force?: boolean}) => void,
 *   emit: (event: string, ref: string, step: string, extra?: Record<string, any>) => void,
 *   heartbeat: {update(p: Record<string, any>): void},
 *   pull: () => Promise<void>,
 *   leavePipeline?: (ref: string) => void,
 *   isLocked: () => boolean,
 *   now?: () => number,
 * }} deps  isLocked: a restart/decommission/shutdown owns the queue pause — `resume` must not undo it
 * @returns {Record<string, (args: any) => Promise<any>>}
 */
export function createOps(deps) {
  const { cfg, store, adapter, forge, queue, cancelRun, intake, emit, heartbeat, pull, isLocked, leavePipeline } = deps;
  const now = deps.now ?? Date.now;
  let operatorPaused = false;

  /** @param {string} cmd @param {any} args @param {{ok: boolean, error?: string}} outcome */
  function audit(cmd, args, outcome) {
    const { comment, actor, ...rest } = args && typeof args === "object" ? args : /** @type {any} */ ({});
    const line = {
      ts: new Date().toISOString(),
      cmd,
      actor: typeof actor === "string" ? actor.slice(0, 40) : "unknown",
      args: { ...rest, ...(typeof comment === "string" ? { commentChars: comment.length } : {}) },
      ...outcome,
    };
    try {
      fs.appendFileSync(path.join(cfg.stateDir, "control-audit.jsonl"), JSON.stringify(line) + "\n", { mode: 0o600 });
    } catch (e) {
      console.warn(`[ops] audit write failed: ${e.message}`);
    }
  }

  /** Wrap a write: audit success and failure alike. @param {string} cmd @param {(args: any) => Promise<any>} fn */
  const write = (cmd, fn) => async (/** @type {any} */ args) => {
    try {
      const result = await fn(args ?? {});
      audit(cmd, args, { ok: true });
      return result;
    } catch (e) {
      audit(cmd, args, { ok: false, error: e.message });
      throw e;
    }
  };

  /** @param {string} id */
  const stepOrThrow = (id) => {
    const s = findStep(cfg, id);
    if (!s) throw new Error(`no step "${id}" in the pipeline`);
    return s;
  };

  const board = ttlCache(
    async () => {
      if (!isPipeline(cfg)) throw new Error("board is for pipeline configs");
      const resting = typeof adapter.listResting === "function" ? await adapter.listResting() : [];
      const meta = store.listRefMeta();
      const running = store.listRunning();
      /** @param {string} ref */
      const card = (ref) => ({ ref, ...(meta[ref]?.displayId ? { id: meta[ref].displayId } : {}), ...(meta[ref]?.title ? { title: meta[ref].title } : {}), ...(ref in running ? { running: true } : {}) });
      const steps = [];
      for (const step of cfg.pipeline ?? []) {
        if (step.manual) continue;
        const refs = resting.filter((j) => j.stepId === step.id).map((j) => j.ref);
        const queued = queueStageOf(step) && typeof adapter.listQueued === "function" ? await adapter.listQueued(step.id) : [];
        steps.push({ step: step.id, resting: refs.map(card), ...(queued.length ? { backlog: queued.map(card) } : {}) });
      }
      return { at: new Date(now()).toISOString(), steps };
    },
    BOARD_TTL_MS,
    now,
  );

  const prs = ttlCache(
    async () => {
      if (!forge?.listAgentPrs) throw new Error("no forge with PR support configured (add a `forge` block)");
      return { at: new Date(now()).toISOString(), prs: await forge.listAgentPrs() };
    },
    BOARD_TTL_MS,
    now,
  );

  /** @type {Record<string, (args: any) => Promise<any>>} */
  const commands = {
    // ---- reads that need the tracker / forge (cached ~30s; `fresh:true` bypasses) ----
    async board(/** @type {any} */ args) {
      if (args?.fresh) board.reset();
      return board();
    },
    async prs(/** @type {any} */ args) {
      if (args?.fresh) prs.reset();
      return prs();
    },

    // ---- writes ----
    pause: write("pause", async () => {
      operatorPaused = true;
      queue.pause();
      heartbeat.update({ paused: true });
      return { paused: true, ...queue.state() };
    }),
    resume: write("resume", async () => {
      operatorPaused = false;
      if (isLocked()) return { paused: queue.isPaused(), note: "a restart/decommission/shutdown holds the queue; not resumed", ...queue.state() };
      queue.resume();
      heartbeat.update({ paused: false });
      await pull().catch((e) => console.warn(`[ops] pull after resume failed: ${e.message}`)); // pulls were skipped while paused
      return { paused: false, ...queue.state() };
    }),
    set_concurrency: write("set_concurrency", async (args) => {
      const n = args.max;
      if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error("max must be an integer 1..64");
      queue.setMax(n);
      heartbeat.update({ maxConcurrent: n });
      return { maxConcurrent: n, note: "runtime only; the config file is unchanged", ...queue.state() };
    }),
    cancel: write("cancel", async (args) => {
      const ref = needString(args.ref, "ref");
      const dropped = queue.remove(ref);
      const killed = cancelRun(ref);
      const held = store.getHeld(ref);
      if (!killed && !dropped.length && !held) throw new Error(`${ref} is not running, queued or held here`);
      store.reloadSeen();
      for (const j of dropped) if (isStateDedupKey(j.dedupKey)) store.unmarkSeen(j.dedupKey); // else a later re-entry of the same stage would be deduped away
      const stepId = dropped[0]?.stepId ?? held?.stepId;
      for (const j of dropped) emit("dequeued", ref, j.stepId, { by: "operator" });
      // A killed agent resolves through dispatch (fail verdict -> failure lane, state cleared). A
      // waiting job or a held record never reaches dispatch, so finish the abandon here: move the
      // ticket out of its source/hold stage (else `reconcile` or a restart would re-fire it) and
      // drop the per-ref state a terminal fail would drop.
      /** @type {{moved?: boolean, moveError?: string}} */
      let outcome = {};
      if (!killed && stepId && (held || dropped.some((j) => (j.kind ?? "pipeline") === "pipeline"))) {
        try {
          await adapter.advance(ref, stepId, { outcome: "fail", reason: "cancelled by operator" });
          outcome = { moved: true };
        } catch (e) {
          outcome = { moved: false, moveError: String(e.message).slice(0, 200) };
        }
        store.clearAttempts(ref);
        store.clearDifficulty(ref);
        store.clearRepo(ref);
        store.clearHeld(ref);
        store.clearFindings(ref);
        leavePipeline?.(ref);
        emit("failed", ref, stepId, { reason: "cancelled by operator" });
      }
      return { ref, killed, dequeued: dropped.map((j) => j.stepId), ...(held && !killed ? { releasedHold: true } : {}), ...outcome };
    }),
    run: write("run", async (args) => {
      const ref = needString(args.ref, "ref");
      if (!isPipeline(cfg)) throw new Error("run is for pipeline configs");
      if (typeof adapter.enterStage !== "function") throw new Error(`tracker "${cfg.provider}" has no run support`);
      const step = args.step ? stepOrThrow(String(args.step)) : cfg.pipeline?.[0];
      if (!step) throw new Error("pipeline is empty");
      const force = args.force === true;
      let stage = null;
      if (!force && typeof adapter.currentStage === "function") stage = await adapter.currentStage(ref);
      const blocked = entryBlock(ref, { stage, running: store.listRunning()[ref] ?? null, force });
      if (blocked) throw new Error(blocked);
      await adapter.ensureLabels?.();
      const entered = await adapter.enterStage(ref, step.id, { assign: args.assign !== false });
      return { ref, step: step.id, stage: entered.stage, note: "the tracker webhook fires the step; `reconcile` if it does not" };
    }),
    release: write("release", async (args) => {
      const ref = needString(args.ref, "ref");
      const comment = typeof args.comment === "string" ? args.comment.slice(0, COMMENT_MAX) : "";
      const job = resumeJob(cfg, store, ref, `mcp-${now()}`, comment);
      if (!job) throw new Error(`${ref} cannot be released: not held, held step is manual/unknown, or its attempt cap is reached`);
      intake([job], { force: true });
      return { ref, step: job.stepId, queued: true };
    }),
    reconcile: write("reconcile", async () => {
      const lines = /** @type {string[]} */ ([]);
      const r = await runReconcile(cfg, { store, adapter, log: (m) => lines.push(m) });
      return { ...r, log: lines.slice(-20) };
    }),
    pull: write("pull", async () => {
      await pull();
      return { ...queue.state() };
    }),
  };
  // The control socket hides error text by default (unknown internals); these are operator
  // commands whose refusals ("not held", "already in the pipeline") ARE the answer.
  return Object.fromEntries(
    Object.entries(commands).map(([name, fn]) => [
      name,
      async (/** @type {any} */ args) => {
        try {
          return await fn(args);
        } catch (e) {
          throw Object.assign(e instanceof Error ? e : new Error(String(e)), { expose: true });
        }
      },
    ]),
  );
}
