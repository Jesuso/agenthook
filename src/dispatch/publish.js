// Publishing for remote (ssh) runs (#681 phase 5a, #825). The agent never holds the
// tracker's or the forge's credentials, so what it returns in the per-run outbox (a
// draft-PR title/body and a ticket comment) is published here by the hub with its own:
// push the branch (refusing any commit that touches .github/workflows/), open the draft
// PR (or reuse the open one on a rework run), post the comment. Called from finish.js
// AFTER every outcome rewrite has settled (ciBounce/guardChanges/autoMerge/follow-up)
// and before setSummary/drain/advance, so a hold or fail coming out of publishing IS the
// applied outcome. Order: push → PR → comment. PR and comment failures NEVER fail the
// step — one line in the run log each (the PR's own title/body is the reviewable artifact
// and the comment is best-effort); a push rejection fails the step (nothing else may
// publish against a branch that never landed).
import { readOutbox } from "./outbox.js";

/**
 * @param {object} o
 * @param {import('../types.js').Forge|null|undefined} o.forge
 * @param {import('../types.js').Adapter} o.adapter
 * @param {string} o.ref
 * @param {string} o.stepId
 * @param {boolean} o.remote      executor.name === "ssh"
 * @param {boolean} o.hasWorktree  a hub-side worktree exists for this step
 * @param {string} [o.worktree]   its path (only when hasWorktree)
 * @param {string} [o.branch]     the step's branch (only when hasWorktree)
 * @param {import('./outbox.js').Outbox|undefined} o.outbox  parsed by finish.js BEFORE the per-run dir rmSync
 * @param {import('../types.js').Verdict} o.verdict
 * @param {import('../types.js').Store} [o.store]
 * @param {string} [o.reasonHarness]  remote harness id, recorded on the held entry when one is created
 * @returns {Promise<{ skipped?: string, held?: boolean, failed?: string, pushed?: boolean, workflow?: string, pr?: { number: number, created: boolean }, comment?: boolean }>}
 */
export async function publishOutbox({ forge, adapter, ref, stepId, remote, hasWorktree, worktree, branch, outbox, verdict, store, reasonHarness }) {
  if (!remote) return { skipped: "not a remote run" };
  if (!forge) return { skipped: "no forge" };
  if (verdict.outcome === "fail") return { skipped: "outcome fail" };
  const box = outbox ?? /** @type {import('./outbox.js').Outbox} */ ({});
  const forgeName = forge.describe().name;
  /** @type {{ pushed?: boolean, workflow?: string, pr?: { number: number, created: boolean }, comment?: boolean, held?: boolean, failed?: string }} */
  const res = {};

  // 1. Push (only when the run has a branch). The workflow guard holds BEFORE anything
  // else publishes; a rejection fails the step and stops the rest of the pipeline.
  if (hasWorktree && branch && worktree) {
    if (typeof forge.publishBranch !== "function") {
      console.log(`[publish] forge ${forgeName} has no publishBranch — the branch for ${ref} was not pushed`);
    } else {
      try {
        const r = await forge.publishBranch({ worktree, branch });
        if (r && typeof r === "object" && "workflow" in r) {
          verdict.outcome = "hold";
          verdict.reason = `the run's commits touch ${r.workflow} — a human must review and push CI changes`;
          delete verdict.target;
          store?.setHeld(ref, { stepId, reason: verdict.reason, ...(reasonHarness ? { harness: reasonHarness } : {}), heldAt: new Date().toISOString() });
          return { held: true, workflow: r.workflow };
        }
        res.pushed = true;
        console.log(`[publish] pushed ${branch} for ${ref}`);
      } catch (e) {
        verdict.outcome = "fail";
        verdict.reason = `publish: ${e.message}`;
        delete verdict.target;
        store?.clearFindings(ref); // same cleanup the other finish.js rewrites do
        return { failed: /** @type {Error} */ (e).message };
      }
    }
  }

  // 2. PR — reuse the open one on a rework run; a failure never fails the step.
  if (box.pr) {
    if (!hasWorktree) {
      console.log(`[publish] no branch on the remote for ${ref} (no worktree) — skipping pr.json`);
    } else if (typeof forge.openPr !== "function") {
      console.log(`[publish] forge ${forgeName} has no openPr — skipping pr.json`);
    } else {
      try {
        const pr = await forge.openPr({ branch: /** @type {string} */ (branch), title: box.pr.title, body: box.pr.body });
        store?.setRefMeta(ref, { pr: pr.number });
        res.pr = pr;
        console.log(`[publish] ${pr.created ? "opened" : "reusing"} draft PR #${pr.number} for ${ref}`);
      } catch (e) {
        console.log(`[publish] could not open the PR for ${ref}: ${/** @type {Error} */ (e).message}`);
      }
    }
  }

  // 3. Comment — best effort, one log line on failure.
  if (box.comment) {
    if (typeof adapter.postComment !== "function") {
      console.log(`[publish] tracker ${adapter.describe().platform} has no postComment — skipping comment.md`);
    } else {
      try {
        await adapter.postComment(ref, box.comment);
        res.comment = true;
        console.log(`[publish] posted the outbox comment on ${ref}`);
      } catch (e) {
        console.log(`[publish] could not post the outbox comment on ${ref}: ${/** @type {Error} */ (e).message}`);
      }
    }
  }
  return res;
}

/** Convenience: readOutbox wired with the run-log logger — used by finish.js on remote runs.
 * @param {string} runDir
 * @param {string|undefined} trigger
 * @returns {import('./outbox.js').Outbox} */
export function readOutboxForRun(runDir, trigger) {
  return readOutbox(runDir, (line) => console.log(line), trigger);
}
