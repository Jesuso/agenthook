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
// Worker-written text is untrusted: before publishing, every GitHub-style mention in the PR
// title/body and the comment must be made safe so the hub's identity can't be used to @mention
// arbitrary users (#829). Our own code-vs-prose detection (neutralizeMentions, wraps in
// backticks) can disagree with the forge's actual renderer, so when the forge can check
// (`liveMentions`), that call is the arbiter: only when it reports nothing but the owner's own
// login does the backtick-wrapped text get published. Any other case — a foreign login still
// live, the call throwing, or the forge not offering it at all — falls back to
// `breakAllMentions`, which has no notion of code at all and so cannot be bypassed by one; the
// owner's own login is exempt there too, and with no owner login known every mention is broken
// (fail closed). The PR title always goes straight to `breakAllMentions` (no render call — a
// title has no code context worth preserving).
import { neutralizeMentions, breakAllMentions } from "./outbox.js";

/**
 * Make one piece of worker-written text safe to publish under the hub's identity (#829).
 * @param {string} text
 * @param {object} o
 * @param {import('../types/index.js').Forge} o.forge
 * @param {string|undefined} o.owner
 * @param {(line: string) => void} o.say
 * @param {string} o.label  for the run-log line, e.g. "pr body" / "comment"
 * @returns {Promise<{ text: string }|{ skip: true }>}
 */
async function safeMentions(text, { forge, owner, say, label }) {
  const isForeign = (/** @type {string[]} */ logins) => logins.some((l) => !owner || l !== owner.toLowerCase());
  if (typeof forge.liveMentions !== "function") {
    say(`[publish] ${label}: forge has no liveMentions check — mentions broken, not just wrapped`);
    return { text: breakAllMentions(text, owner) };
  }
  const t1 = neutralizeMentions(text, owner);
  let live;
  try {
    live = await forge.liveMentions(t1);
  } catch (e) {
    say(`[publish] ${label}: live-mention check failed (${/** @type {Error} */ (e).message}) — mentions broken, not just wrapped`);
    return { text: breakAllMentions(text, owner) };
  }
  if (!isForeign(live)) return { text: t1 };
  say(`[publish] ${label}: the renderer found a live mention in the wrapped text — mentions broken, not just wrapped`);
  const t2 = breakAllMentions(text, owner);
  try {
    const live2 = await forge.liveMentions(t2);
    if (isForeign(live2)) {
      say(`[publish] ${label}: still live after breaking every mention — not publishing it`);
      return { skip: true };
    }
  } catch (e) {
    say(`[publish] ${label}: live-mention re-check failed (${/** @type {Error} */ (e).message}) — publishing with mentions broken`);
  }
  return { text: t2 };
}

/**
 * @param {object} o
 * @param {import('../types/index.js').Forge|null|undefined} o.forge
 * @param {import('../types/index.js').Adapter} o.adapter
 * @param {string} o.ref
 * @param {string} o.stepId
 * @param {boolean} o.remote      executor.name === "ssh"
 * @param {boolean} o.hasWorktree  a hub-side worktree exists for this step
 * @param {string} [o.worktree]   its path (only when hasWorktree)
 * @param {string} [o.branch]     the step's branch (only when hasWorktree)
 * @param {import('./outbox.js').Outbox|undefined} o.outbox  parsed by finish.js BEFORE the per-run dir rmSync
 * @param {import('../types/index.js').Verdict} o.verdict
 * @param {import('../types/index.js').Store} [o.store]
 * @param {(line: string) => void} [o.log]  one run-log line per skip/failure (finish.js's run log)
 * @param {string} [o.reasonHarness]  remote harness id, recorded on the held entry when one is created
 * @param {string|undefined} [o.ownerLogin]  our tracker login, the only one exempt when mentions are made safe; when omitted, `adapter.describe().ownerHint` is read (a leading `@` is stripped); with no owner known at all, every mention is broken
 * @returns {Promise<{ skipped?: string, held?: boolean, failed?: string, pushed?: boolean, workflow?: string, pr?: { number: number, created: boolean }, comment?: boolean }>}
 */
export async function publishOutbox({ forge, adapter, ref, stepId, remote, hasWorktree, worktree, branch, outbox, verdict, store, log, reasonHarness, ownerLogin }) {
  const say = (/** @type {string} */ line) => {
    try {
      (log ?? console.log)(line);
    } catch {
      /* a broken log must not take the step down */
    }
  };
  if (!remote) return { skipped: "not a remote run" };
  if (!forge) return { skipped: "no forge" };
  if (verdict.outcome === "fail") return { skipped: "outcome fail" };
  const box = outbox ?? /** @type {import('./outbox.js').Outbox} */ ({});
  const forgeName = forge.describe().name;
  // The owner login exempted from mention neutralisation: an explicit one, else the tracker's
  // own (ownerHint, e.g. "@octocat"). Unknown = neutralise every mention (fail closed).
  const owner = ownerLogin ?? (adapter.describe().ownerHint ?? undefined)?.replace(/^@/, "");
  /** @type {{ pushed?: boolean, workflow?: string, pr?: { number: number, created: boolean }, comment?: boolean, held?: boolean, failed?: string }} */
  const res = {};

  // 1. Push (only when the run has a branch). The workflow guard holds BEFORE anything
  // else publishes; a rejection fails the step and stops the rest of the pipeline.
  if (hasWorktree && branch && worktree) {
    if (typeof forge.publishBranch !== "function") {
      say(`[publish] forge ${forgeName} has no publishBranch — the branch for ${ref} was not pushed`);
    } else {
      try {
        const r = await forge.publishBranch({ worktree, branch });
        if (r && typeof r === "object" && "workflow" in r) {
          // The hit may come only from a merge commit's diff — say so, so the held reason
          // doesn't blame a plain commit that never touched CI (#829).
          verdict.outcome = "hold";
          verdict.reason = r.viaMerge
            ? `the run's commits include a merge that brings in changes to ${r.workflow} — a human must review and push CI changes`
            : `the run's commits touch ${r.workflow} — a human must review and push CI changes`;
          delete verdict.target;
          store?.setHeld(ref, { stepId, reason: verdict.reason, ...(reasonHarness ? { harness: reasonHarness } : {}), heldAt: new Date().toISOString() });
          return { held: true, workflow: r.workflow };
        }
        res.pushed = Array.isArray(r?.pushed) ? r.pushed.length > 0 : false;
        say(res.pushed ? `[publish] pushed ${branch} for ${ref}` : `[publish] no new commits on ${branch} for ${ref} — nothing to push`);
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
      say(`[publish] no branch on the remote for ${ref} (no worktree) — skipping pr.json`);
    } else if (typeof forge.openPr !== "function") {
      say(`[publish] forge ${forgeName} has no openPr — skipping pr.json`);
    } else {
      const title = breakAllMentions(box.pr.title, owner);
      const bodyResult = await safeMentions(box.pr.body, { forge, owner, say, label: "pr body" });
      if ("skip" in bodyResult) {
        say(`[publish] skipping pr.json for ${ref}: the body still has a live mention after breaking it`);
      } else {
        try {
          const pr = await forge.openPr({ branch: /** @type {string} */ (branch), title, body: bodyResult.text });
          store?.setRefMeta(ref, { pr: pr.number });
          res.pr = pr;
          say(`[publish] ${pr.created ? "opened" : "reusing"} draft PR #${pr.number} for ${ref}`);
        } catch (e) {
          say(`[publish] could not open the PR for ${ref}: ${/** @type {Error} */ (e).message}`);
        }
      }
    }
  }

  // 3. Comment — best effort, one log line on failure.
  if (box.comment) {
    if (typeof adapter.postComment !== "function") {
      say(`[publish] tracker ${adapter.describe().platform} has no postComment — skipping comment.md`);
    } else {
      const commentResult = await safeMentions(box.comment, { forge, owner, say, label: "comment" });
      if ("skip" in commentResult) {
        say(`[publish] skipping the outbox comment on ${ref}: it still has a live mention after breaking it`);
      } else {
        try {
          await adapter.postComment(ref, commentResult.text);
          res.comment = true;
          say(`[publish] posted the outbox comment on ${ref}`);
        } catch (e) {
          say(`[publish] could not post the outbox comment on ${ref}: ${/** @type {Error} */ (e).message}`);
        }
      }
    }
  }
  return res;
}
