// A `ci` job: the forge saw a red CI run on the ref's PR — re-run once, else bounce.
import { findStep, stepForStage } from "../pipeline.js";
import { reportMoveFailure } from "../events.js";

/** @param {import('./context.js').DispatchState & import('./routing.js').Routing & import('./verdict.js').VerdictOps} ctx */
export function createCi(ctx) {
  const { cfg, adapter, store, emit, forge, busy, stepIndex, guardChanges } = ctx;
  /**
   * Bounce a task with a red PR back to `b.target` NOW, from the step it rests in —
   * through the changes guard (so maxAttempts caps it). A task not downstream of the
   * target (no stage, a manual stage, or at/before the target) is left alone.
   * @param {string} ref
   * @param {{target: string, text: string}} b  receiver-built text only (never CI output)
   * @param {{name?: string, url?: string}} task
   * @param {Record<string, any>} [extra]  event fields
   */
  async function bounceCi(ref, b, task, extra = {}) {
    let stage = null;
    try {
      stage = (await adapter.currentStage?.(ref)) ?? null;
    } catch (e) {
      console.error(`[ci] currentStage ${ref} failed:`, e.message);
    }
    const cur = stepForStage(cfg, stage);
    if (!cur || cur.manual || stepIndex(cur.id) <= stepIndex(b.target)) {
      console.log(`[ci] ${ref} is not downstream of "${b.target}" (stage ${stage ?? "none"}) — PR comment only`);
      emit?.("ci_red", ref, cur?.id ?? "", { action: "skipped", ...extra });
      return;
    }
    /** @type {import('../types.js').Verdict} */
    const verdict = { outcome: "changes", target: b.target, reason: b.text, findings: b.text };
    guardChanges(ref, cur.id, verdict, "ci");
    if (verdict.outcome === "fail") {
      emit?.("failed", ref, cur.id, { reason: verdict.reason ?? null, name: task.name, url: task.url });
    } else {
      emit?.("ci_red", ref, cur.id, { action: "bounced", target: verdict.target, ...extra });
    }
    console.log(`[verdict] ci ${ref} (${cur.id}) -> ${verdict.outcome}${verdict.reason ? ` (${verdict.reason})` : ""}`);
    try {
      await adapter.advance(ref, cur.id, verdict);
    } catch (e) {
      console.error(`[advance] ci ${cur.id} ${ref} (${verdict.outcome}) failed:`, e.message);
      reportMoveFailure(emit, ref, cur.id, verdict.outcome, e);
    }
    if (verdict.outcome === "fail") {
      store?.clearAttempts(ref);
      store?.clearDifficulty(ref);
      store?.clearFindings(ref);
      store?.clearRepo(ref);
      store?.clearSummaries(ref);
    }
  }

  /**
   * The forge saw a red CI run on this task's `agent/<ref>` PR. No agent: the first red
   * attempt re-runs the failed jobs once; a second (or a re-run that can't start) posts
   * the failing log tail on the PR and bounces the task to the CI target with `changes`.
   * The log goes ONLY to the PR comment — findings/reason are receiver-built text, since
   * the PR head controls CI output and the rework prompt feeds a fullAuto agent.
   * Fail-closed on the assignee, like runMerge.
   * @param {import('../types.js').Job} job
   */
  async function runCi(job) {
    /** @param {{name?: string, url?: string}} [t] */
    const done = (t) => ({ kind: job.kind, ref: job.ref, name: t?.name ?? job.ref, url: t?.url ?? "", code: 0 });
    const ci = job.ci;
    if (!ci || !forge?.prHead || !forge.rerunFailedJobs) {
      console.log(`[ci] skip ${job.ref} — no CI payload or forge support`);
      return done();
    }
    let task;
    try {
      task = await adapter.fetchTask(job.ref);
    } catch (e) {
      console.log(`[assignee] skip ci ${job.ref} — fetch failed (${e.message})`);
      return done();
    }
    if (!task.assignedToUs) {
      console.log(`[assignee] skip ci ${job.ref}`);
      return done();
    }

    let pr;
    try {
      pr = await forge.prHead(ci.prNumber, job.ref);
    } catch (e) {
      console.log(`[ci] skip ${job.ref} run ${ci.runId} — PR lookup failed (${e.message})`);
      return done(task);
    }
    if (!pr || !pr.open || pr.sha !== ci.headSha) {
      const why = !pr ? "no PR" : !pr.open ? `PR #${pr.number} is closed` : `stale run (PR head is now ${String(pr.sha).slice(0, 7)})`;
      console.log(`[ci] skip ${job.ref} run ${ci.runId} — ${why}`);
      return done(task);
    }
    const sha7 = ci.headSha.slice(0, 7);
    const extra = { runId: ci.runId, attempt: ci.attempt, sha: ci.headSha, pr: pr.number };

    if (ci.attempt === 1) {
      try {
        await forge.rerunFailedJobs(ci.runId);
        console.log(`[ci] ${job.ref} run ${ci.runId} red on ${sha7} — re-running failed jobs once`);
        emit?.("ci_red", job.ref, "", { action: "rerun", ...extra });
        return done(task);
      } catch (e) {
        console.error(`[ci] re-run of ${ci.runId} failed — bouncing now:`, e.message);
      }
    }

    // Red twice (or no re-run). The failing log tail goes to the PR and nowhere else.
    if (forge.prComment) {
      const log = forge.failedLogTail ? await forge.failedLogTail(ci.runId, ci.attempt) : "";
      const body =
        `**agenthook:** CI is red on \`${sha7}\` ([run ${ci.runId}](${ci.url}), attempt ${ci.attempt}).` +
        (log ? ` Failing log tail:` : ` (no log tail available)`);
      try {
        await forge.prComment(pr.number, body, log);
      } catch (e) {
        console.error(`[ci] PR #${pr.number} comment failed:`, e.message);
      }
    }

    const target = cfg.forge?.ciTarget ? findStep(cfg, cfg.forge.ciTarget) : cfg.pipeline?.find((s) => s.createsWorktree) ?? null;
    if (!target) {
      console.log(`[ci] ${job.ref}: no ciTarget / createsWorktree step to bounce to`);
      return done(task);
    }

    // Once per sha (two red workflows on one commit bounce once), then park-or-bounce.
    // Sync from the check through setCiRed: runClaude's busy flag + take can't interleave.
    const key = `cibounce:${job.ref}:${ci.headSha}`;
    store?.reloadSeen();
    if (store?.hasSeen(key)) {
      console.log(`[ci] ${job.ref} already bounced for ${sha7}`);
      return done(task);
    }
    store?.markSeen(key);
    const text = `CI failed${ci.attempt > 1 ? " twice" : ""} on ${sha7} (run ${ci.url}, attempt ${ci.attempt}). The failing log tail is posted on PR #${pr.number}.`;
    if (busy.has(job.ref) || store?.listRunning()?.[job.ref]) {
      store?.setCiRed(job.ref, { target: target.id, text });
      console.log(`[ci] ${job.ref} has a run in flight — bounce to "${target.id}" parked until it exits`);
      emit?.("ci_red", job.ref, "", { action: "deferred", target: target.id, ...extra });
      return done(task);
    }
    await bounceCi(job.ref, { target: target.id, text }, task, extra);
    return done(task);
  }

  return { bounceCi, runCi };
}
