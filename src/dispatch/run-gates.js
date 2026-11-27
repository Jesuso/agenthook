// Pre-run gates (runStep, step.js): a run of early returns, each returning the step's result
// shape, before any worktree/spawn mutation. An epic never runs an agent; unrouted parks the ref
// in the hold lane; a manual stage only drains/clears/leaves the pipeline; an open blocker or an
// overlap lock rests the ref with no attempt bump. Everything after these gates needs `repo`
// (from the route gate) and `tookLock` (from the overlap gate).
import { summarizeDescription } from "../ticket-summary.js";
import { drainWorktree } from "../worktree.js";
import { reportMoveFailure } from "../events.js";
import { findBlocker } from "../overlap.js";

/**
 * @param {{cfg: import('../types/index.js').Config, store: import('../types/index.js').Store|undefined, emit: import('./context.js').DispatchState['emit'], adapter: import('../types/index.js').Adapter, resolveRoute: import('./routing.js').Routing['resolveRoute'], leavePipeline: import('./routing.js').Routing['leavePipeline']}} deps
 * @param {import('../types/index.js').Job} job
 * @param {import('../types/index.js').Step} step
 * @param {import('../types/index.js').Task} task
 * @returns {Promise<{done: {kind: string, ref: string, name?: string, url?: string, code: number}}|{repo: import('../types/index.js').RepoConfig, tookLock: boolean}>}
 */
export async function preRunGates(deps, job, step, task) {
  const { cfg, store, emit, adapter, resolveRoute, leavePipeline } = deps;

  // An epic is a tracker item, never a ticket: no agent may ever run on it (CONTEXT.md,
  // ADR 0003). Fail closed before any state mutation — no worktree, no spawn, no advance.
  if (task.isEpic) {
    console.log(`[epic] skip ${step.id} ${job.ref} — epics never run an agent`);
    emit?.("epic_skipped", job.ref, step.id, { name: task.name, url: task.url });
    return { done: { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 } };
  }
  // Durable display metadata for `ah agents`/`status`/`events` (survives run exit).
  store?.setRefMeta(job.ref, {
    displayId: task.displayId,
    title: task.name,
    url: task.url,
    summary: summarizeDescription(task.description),
    epic: task.epic ? { ref: task.epic.ref, name: task.epic.name, url: task.epic.url } : null,
  });

  // Which checkout this ref works in. Ambiguous or unmatched routing never guesses: park
  // the task in the hold lane (no agent, no attempt) so a human fixes the routing field;
  // the owner's `@agent` reply then re-runs the step. Before the manual branch — its
  // drain needs the repo too.
  const routed = resolveRoute(job.ref, task);
  if (!("repo" in routed)) {
    console.log(`[route] ${step.id} ${job.ref} -> hold (${routed.message})`);
    emit?.("blocked", job.ref, step.id, { reason: routed.message, name: task.name, url: task.url });
    if (!step.manual) store?.setHeld(job.ref, { stepId: step.id, reason: routed.message, heldAt: new Date().toISOString() });
    try {
      await adapter.advance(job.ref, step.id, { outcome: "hold", reason: routed.message });
    } catch (e) {
      console.error(`[advance] ${step.id} ${job.ref} (hold) failed:`, e.message);
      reportMoveFailure(emit, job.ref, step.id, "hold", e);
    }
    return { done: { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 } };
  }
  const repo = routed.repo;

  // Manual stage (e.g. "done"): no agent — entering it only runs system actions.
  if (step.manual) {
    if (step.drainWorktree) {
      try {
        if (drainWorktree(cfg, job.ref, repo)) console.log(`[worktree] drained ${job.ref} (${step.id})`);
      } catch (e) {
        console.error(`[worktree] drain failed for ${job.ref}:`, e.message);
      }
      store?.clearAttempts(job.ref);
      store?.clearFindings(job.ref);
      store?.clearDifficulty(job.ref); // task is done — reset its per-ref state
      store?.clearRepo(job.ref);
      store?.clearHeld(job.ref);
      leavePipeline(job.ref);
      // forge.autoMerge turned on for an approved PR that has not merged yet: this is the
      // pipeline handing it to GitHub, not a merge — say so, so readers don't mistake it.
      const rm = store?.getRefMeta(job.ref);
      const awaitingMerge = !!rm?.autoMerge && rm.prState !== "merged";
      emit?.("pipeline_done", job.ref, step.id, { name: task.name, url: task.url, ...(awaitingMerge ? { awaitingMerge: true, pr: rm?.autoMerge?.pr } : {}) });
    }
    // The stage itself is agenthook's handoff, not done (ADR 0008). The board's own flag is
    // read here because some trackers never deliver it (GitHub Projects v2) or have none (local).
    if (task.completed) emit?.("board_done", job.ref, step.id, { via: "flag", name: task.name, url: task.url });
    return { done: { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 } };
  }

  // Re-check the block gate at dispatch time: a job that waited in the local queue
  // (slots busy, boot-restored queue.json, an overlap release) skips the webhook-time
  // gate entirely, so a dependency added while it waited would otherwise still run. An
  // owner's `@agent` resume bypasses this — they already decided to re-run the step.
  if (adapter.openBlockers && !job.dedupKey?.startsWith("trigger:")) {
    /** @type {string[]} */
    let blockers = [];
    try {
      blockers = await adapter.openBlockers(job.ref);
    } catch (err) {
      console.warn(`[blocked] openBlockers failed for ${job.ref}, failing open: ${err.message}`);
    }
    if (blockers.length) {
      console.log(`[blocked] ${job.ref} blocked by ${blockers.join(", ")} — resting (dispatch)`);
      return { done: { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 } };
    }
  }

  let tookLock = false;
  if (cfg.overlapGuard && store) {
    // A release re-enters here with no tracker event behind it: fail-closed on the
    // assignee (a task reassigned — or finished — while it waited must never fire).
    if (job.dedupKey?.startsWith("overlap:") && (!task.assignedToUs || task.completed)) {
      console.log(`[assignee] skip overlap release ${job.ref}`);
      return { done: { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 } };
    }
    // Gate the worktree-creating step on the file-overlap locks. A ref that already
    // holds a lock (a rework pass) is never gated — that would deadlock two refs.
    if (step.createsWorktree && !store.getLock(job.ref)) {
      const predicted = store.getPredictedPaths(job.ref) ?? [];
      const blocker = findBlocker(job.ref, predicted, store.listLocks());
      if (blocker) {
        // Rest in the source stage: no agent, no advance, no attempt bump. The
        // blocker leaving the pipeline re-intakes this step (engine releaseOverlap).
        store.setOverlap(job.ref, { stepId: step.id, blockedBy: blocker, heldAt: new Date().toISOString() });
        emit?.("overlap_held", job.ref, step.id, { blockedBy: blocker });
        console.log(`[overlap] ${job.ref} (${step.id}) waits on ${blocker} — predicted paths overlap its lock`);
        return { done: { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 } };
      }
      store.clearOverlap(job.ref);
      // Take the lock now, synchronously with the check, so a sibling dispatched
      // concurrently (maxConcurrent > 1) already sees it.
      if (predicted.length) {
        store.setLock(job.ref, { paths: predicted, stepId: step.id });
        tookLock = true;
      }
    }
  }

  return { repo, tookLock };
}
