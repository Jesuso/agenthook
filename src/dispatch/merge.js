// A `merge` job: the forge saw the ref's PR merge — no agent spawns.
import { drainWorktree } from "../worktree.js";

// Appended to every log line where the bridge didn't deliver; `prState: merged` is recorded
// either way, so Needs-you shows the same reason.
const UNDELIVERED = "PR merged — close the ticket";

/** @param {import('./context.js').DispatchState & import('./routing.js').Routing} ctx */
export function createMerge(ctx) {
  const { cfg, adapter, store, emit, meta, stickyRepo, leavePipeline } = ctx;
  /**
   * A forge saw this task's `agent/<ref>` PR merge. No agent. The merge job is the bridge
   * for boards that can't hear merges: move the task into the completeOnMerge step (its
   * own webhook then fires that manual step, which drains the worktree + emits
   * pipeline_done), then mark it completed on the tracker. A board that closes its own
   * ticket on merge (`job.boardCloses`, `forge.boardClosesOnMerge`, or the task is already
   * completed) is not bridged: only the local cleanup runs. Fail-closed on the assignee:
   * a task we can't confirm is ours is never touched on the tracker. Wherever the bridge
   * didn't deliver, the local `prState: merged` still lands for Needs-you.
   * @param {import('../types.js').Job} job
   */
  async function runMerge(job) {
    const skip = { kind: job.kind, ref: job.ref, name: job.ref, url: "", code: 0 };
    let task;
    try {
      task = await adapter.fetchTask(job.ref);
    } catch (e) {
      console.log(`[assignee] skip merge ${job.ref} — fetch failed (${e.message}); ${UNDELIVERED}`);
      store?.setRefMeta(job.ref, { prState: "merged" }); // local fact only — no tracker call, no event
      return skip;
    }
    if (!task.assignedToUs) {
      console.log(`[assignee] skip merge ${job.ref} — not ours; ${UNDELIVERED}`);
      store?.setRefMeta(job.ref, { prState: "merged" }); // local fact only — no tracker call, no event
      return skip;
    }

    const selfClosing = !!(job.boardCloses || cfg.forge?.boardClosesOnMerge || task.completed);
    if (selfClosing) console.log(`[merge] ${job.ref} — board closes its own ticket on merge; not bridging`);

    // Move BEFORE completing, so the move event routes like any other section change.
    const doneStep = cfg.pipeline?.find((s) => s.completeOnMerge);
    let moved = false;
    if (!selfClosing && doneStep && adapter.enterStage) {
      try {
        await adapter.enterStage(job.ref, doneStep.id, { assign: false });
        moved = true;
        console.log(`[merge] ${job.ref} -> ${doneStep.id}`);
      } catch (e) {
        console.error(`[merge] move ${job.ref} -> ${doneStep.id} failed${adapter.complete ? "" : `; ${UNDELIVERED}`}:`, e.message);
      }
    }

    if (selfClosing) {
      // The board closes it; nothing to carry.
    } else if (adapter.complete) {
      try {
        await adapter.complete(job.ref);
      } catch (e) {
        console.error(`[merge] complete ${job.ref} failed (task stays uncompleted); ${UNDELIVERED}:`, e.message);
      }
    } else if (!moved) {
      console.log(
        `[merge] ${meta.platform} has no complete() and no completeOnMerge step moved ${job.ref} — leaving it open ` +
          `(add a manual step with "completeOnMerge": true); ${UNDELIVERED}`,
      );
    }

    // No completeOnMerge step entered to do the cleanup (a self-closing board, none
    // configured, no enterStage, or the move failed) → do it here, as the manual branch would.
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
    // manual drain (the PR is still open there) and end here. `prState: merged` is also the
    // local fact a bridge that didn't deliver leaves behind for Needs-you.
    store?.clearSummaries(job.ref);
    store?.setRefMeta(job.ref, { prState: "merged" }); // state and events agree
    leavePipeline(job.ref);
    emit?.("merged", job.ref, job.stepId, { name: task.name, url: task.url });
    return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 };
  }

  return { runMerge };
}
