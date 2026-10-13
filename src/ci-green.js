// `ci_green`: tell a supervisor that an agent PR's checks all passed. Signal only — no agent
// runs and the pipeline does not move. Handled outside the run queue (a slot is for agents; a
// paused or full queue must not delay a cheap read), so the engine hands these jobs here
// instead of through `intake`.

/**
 * @param {{
 *   adapter: import('./types.js').Adapter,
 *   forge: import('./types.js').Forge | null | undefined,
 *   store: import('./types.js').Store,
 *   emit?: (event: string, ref: string, step: string, extra?: Record<string, any>) => void,
 * }} deps
 * @returns {(job: import('./types.js').Job) => Promise<boolean>}  true when `ci_green` was emitted
 */
export function createCiGreen({ adapter, forge, store, emit }) {
  /** Refs+SHAs being checked right now (one webhook per workflow can land together). @type {Set<string>} */
  const inflight = new Set();

  return async function ciGreen(job) {
    const ci = job.ci;
    if (!ci || !forge?.prHead || !forge.ciStatus) return false;
    const key = job.dedupKey;
    store.reloadSeen();
    if (store.hasSeen(key) || inflight.has(key)) return false;
    inflight.add(key);
    try {
      // Fail closed on the assignee, like every other forge-driven action.
      const task = await adapter.fetchTask(job.ref).catch((/** @type {any} */ e) => {
        console.log(`[assignee] skip ci_green ${job.ref} — fetch failed (${e.message})`);
        return null;
      });
      if (!task?.assignedToUs) {
        if (task) console.log(`[assignee] skip ci_green ${job.ref}`);
        return false;
      }
      const pr = await forge.prHead(ci.prNumber, job.ref).catch(() => null);
      if (!pr?.open || pr.sha !== ci.headSha) return false; // closed, or a newer push made this run stale
      const st = await forge.ciStatus(pr.number, pr.sha);
      if (st.ci !== "success") {
        console.log(`[ci_green] ${job.ref} ${pr.sha.slice(0, 7)} roll-up is ${st.ci} — not yet`);
        return false;
      }
      store.reloadSeen();
      if (store.hasSeen(key)) return false;
      store.markSeen(key); // before any further await: concurrent finishers emit once
      emit?.("ci_green", job.ref, "", { pr: pr.number, sha: pr.sha, mergeable: st.mergeable, mergeState: st.mergeState });
      return true;
    } catch (e) {
      console.log(`[ci_green] ${job.ref} — ${e.message}`);
      return false;
    } finally {
      inflight.delete(key);
    }
  };
}
