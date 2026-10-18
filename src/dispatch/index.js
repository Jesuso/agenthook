// Spawns the step's headless agent (`claude -p` by default — see src/agents/) for one
// pipeline step, streams output to a per-run log, and resolves the step's section
// transition on exit. Provider-blind: section gids and the move itself live behind the
// adapter (advance()); the agent CLI lives behind its agent adapter.
//
// The receiver OWNS the worktree: the step that sets createsWorktree gets one made
// (shared by task ref across all its steps, cwd = it); drainWorktree removes it.
import { createEnergySampler } from "../energy-sampler.js";
import { KILL_GRACE_MS, createSpawn } from "./spawn.js";
import { FINALIZE_TIMEOUT_MS, createUsage } from "./usage.js";
import { createVerdictOps } from "./verdict.js";
import { createRouting } from "./routing.js";
import { createMerge } from "./merge.js";
import { createCi } from "./ci.js";
import { createFinish } from "./finish.js";
import { createStep } from "./step.js";

export { timeoutReason, MAX_SUMMARY_CHARS, parseSummary, parseVerdict } from "./verdict.js";
export { lookupPr } from "./pr.js";
export { descriptionHasHeadings, resolveModelEffort, promptPathFor } from "./prompt.js";

/**
 * @param {import('../types.js').Config} cfg
 * @param {import('../types.js').Adapter} adapter
 * @param {Set<import('node:child_process').ChildProcess>} [children]  live `claude -p` procs, for force-kill on shutdown
 * @param {import('../types.js').Store} [store]  for in-flight (crash-recovery) records
 * @param {(event: string, ref: string, step: string, extra?: Record<string, any>) => void} [emit]  lifecycle event emitter (best-effort)
 * @param {import('../types.js').Forge|null} [forge]  optional; `ci` jobs call its CI methods
 * @param {(blocker: string) => void} [releaseOverlap]  overlapGuard: clear `blocker`'s lock and re-intake the refs waiting on it (engine-owned)
 * @param {{killGraceMs?: number, finalizeTimeoutMs?: number, energySampler?: Pick<ReturnType<typeof createEnergySampler>, "start"|"stop">, onQuota?: (q: import('../quota.js').QuotaReading) => void}} [opts]
 *   test hooks: SIGTERM→SIGKILL grace for a timed-out agent, the post-exit usage-export bound, the energy sampler;
 *   onQuota: the subscription-quota reading a run's agent reported (claude only), stamped with `asOf` — the engine
 *   persists it and feeds the pacer
 */
export function createDispatcher(cfg, adapter, children, store, emit, forge, releaseOverlap, opts = {}) {
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const finalizeTimeoutMs = opts.finalizeTimeoutMs ?? FINALIZE_TIMEOUT_MS;
  // Energy (#396): one sampler for every opted-in run, so overlapping runs split the machine's
  // power by time share instead of each counting all of it. Absent without a profile `energy`.
  const energySampler = opts.energySampler ?? (cfg.energy ? createEnergySampler({ source: cfg.energy.source }) : null);
  const meta = adapter.describe();
  // Refs with a pipeline job in runClaude (spawn through advance). A red-CI bounce for a
  // busy ref is parked (store.setCiRed) instead of racing that job's own advance.
  /** @type {Set<string>} */
  const busy = new Set();
  // Operator cancel (MCP/control `cancel`): live agent pid per ref, and the refs asked to stop.
  // A cancelled run always resolves as `fail` ("cancelled by operator"), like a timeout kill.
  /** @type {Map<string, number>} */
  const pids = new Map();
  /** @type {Set<string>} */
  const cancelled = new Set();
  // Refs between runClaude() starting and the agent being spawned (fetch, routing, worktree):
  // the only window in which a cancel has no pid yet but can still stop the run. After the
  // agent exits (verdict, advance) a cancel is too late and must say so.
  /** @type {Set<string>} */
  const preSpawn = new Set();
  /** @type {Map<string, NodeJS.Timeout>} */
  const killTimers = new Map();

  /** @type {import('./context.js').DispatchState} */
  const state = { cfg, adapter, children, store, emit, forge, releaseOverlap, opts, meta, energySampler, killGraceMs, finalizeTimeoutMs, busy, pids, cancelled, preSpawn, killTimers };
  const base = { ...state, ...createRouting(state), ...createSpawn(state), ...createUsage(state), ...createVerdictOps(state) };
  const { runMerge } = createMerge(base);
  const { bounceCi, runCi } = createCi(base);
  const { runStep } = createStep({ ...base, ...createFinish(base) });
  const { killNow } = base;

  /** @param {import('../types.js').Job} job */
  async function runClaude(job) {
    if (job.kind === "merge") return runMerge(job);
    if (job.kind === "ci") return runCi(job);
    busy.add(job.ref);
    preSpawn.add(job.ref);
    /** @type {{name?: string, url?: string}} */
    let info = {};
    try {
      info = await runStep(job);
      return info;
    } finally {
      // A red-CI bounce parked after this run's verdict was read: apply it now, from
      // wherever the task landed. Sync with the delete, so a concurrent runCi either
      // sees this ref busy (and parks) or finds this take already done (and bounces).
      busy.delete(job.ref);
      preSpawn.delete(job.ref);
      cancelled.delete(job.ref); // a cancel flagged before a spawn that never happened (held, skipped)
      const late = store?.takeCiRed(job.ref);
      if (late) await bounceCi(job.ref, late, info);
    }
  }

  /**
   * Stop the live agent for `ref` (SIGTERM, then SIGKILL after the grace). The run then resolves
   * as `fail` ("cancelled by operator"). False when no agent is running for the ref.
   * @param {string} ref
   */
  runClaude.cancel = (ref) => {
    const pid = pids.get(ref);
    if (!pid) {
      // Between runClaude() and the spawn (fetch, routing, worktree): flag it; onPid kills at birth.
      if (!preSpawn.has(ref)) return false;
      cancelled.add(ref);
      return true;
    }
    cancelled.add(ref);
    if (!killNow(ref, pid)) {
      cancelled.delete(ref);
      return false;
    }
    return true;
  };

  return runClaude;
}
