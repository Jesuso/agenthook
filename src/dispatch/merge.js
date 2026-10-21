// A `merge` job: the forge saw the ref's PR merge — no agent spawns.
import { drainWorktree } from "../worktree.js";

/** @param {import('./context.js').DispatchState & import('./routing.js').Routing} ctx */
export function createMerge(ctx) {
  const { cfg, adapter, store, emit, meta, stickyRepo, leavePipeline } = ctx;
  /**
   * A forge saw this task's `agent/<ref>` PR merge. No agent: move the task into the
   * completeOnMerge step (its own webhook then fires that manual step, which drains the
   * worktree + emits pipeline_done), then mark it completed on the tracker. Fail-closed
   * on the assignee: a task we can't confirm is ours is never touched.
   * @param {import('../types.js').Job} job
   */
  async function runMerge(job) {
    const skip = { kind: job.kind, ref: job.ref, name: job.ref, url: "", code: 0 };
    let task;
    try {
      task = await adapter.fetchTask(job.ref);
    } catch (e) {
      console.log(`[assignee] skip merge ${job.ref} — fetch failed (${e.message})`);
      return skip;
    }
    if (!task.assignedToUs) {
      console.log(`[assignee] skip merge ${job.ref}`);
      return skip;
    }

    // Move BEFORE completing, so the move event routes like any other section change.
    const doneStep = cfg.pipeline?.find((s) => s.completeOnMerge);
    let moved = false;
    if (doneStep && adapter.enterStage) {
      try {
        await adapter.enterStage(job.ref, doneStep.id, { assign: false });
        moved = true;
        console.log(`[merge] ${job.ref} -> ${doneStep.id}`);
      } catch (e) {
        console.error(`[merge] move ${job.ref} -> ${doneStep.id} failed:`, e.message);
      }
    }

    if (adapter.complete) {
      try {
        await adapter.complete(job.ref);
      } catch (e) {
        console.error(`[merge] complete ${job.ref} failed (task stays uncompleted):`, e.message);
      }
    } else if (!moved) {
      console.log(
        `[merge] ${meta.platform} has no complete() and no completeOnMerge step moved ${job.ref} — leaving it open ` +
          `(add a manual step with "completeOnMerge": true)`,
      );
    }

    // No completeOnMerge step entered to do the cleanup (none configured, no enterStage,
    // or the move failed) → do it here, as the manual branch would.
    if (!moved) {
      try {
        if (drainWorktree(cfg, job.ref, stickyRepo(job.ref))) console.log(`[worktree] drained ${job.ref} (merge)`);
      } catch (e) {
        console.error(`[worktree] drain failed for ${job.ref}:`, e.message);
      }
      store?.clearAttempts(job.ref);
      store?.clearFindings(job.ref);
      store?.clearDifficulty(job.ref);
      store?.clearRepo?.(job.ref);
    }

    // A merge is a release signal whether or not the move landed. Summaries outlive the
    // manual drain (the PR is still open there) and end here.
    store?.clearSummaries(job.ref);
    store?.setRefMeta(job.ref, { prState: "merged" }); // state and events agree
    leavePipeline(job.ref);
    emit?.("merged", job.ref, job.stepId, { name: task.name, url: task.url });
    return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 };
  }

  return { runMerge };
}
