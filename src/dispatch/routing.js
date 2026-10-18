// Per-ref pipeline bookkeeping: step position, repo routing (sticky), leaving the
// pipeline (overlapGuard), and caching the PR number.
import { resolveRepo, repoById, primaryRepo } from "../repos.js";
import { lookupPr } from "./pr.js";

/** @param {import('./context.js').DispatchState} ctx */
export function createRouting(ctx) {
  const { cfg, store, releaseOverlap, meta } = ctx;
  /** Pipeline position of a step id (-1 if unknown). @param {string} id */
  const stepIndex = (id) => cfg.pipeline?.findIndex((s) => s.id === id) ?? -1;

  /** The repo a ref is stuck to (store.getRepo), else the default repo. For paths that
   * act on an already-routed ref (merge, PR lookup) — they never re-resolve or hold.
   * @param {string} ref */
  const stickyRepo = (ref) => repoById(cfg, store?.getRepo?.(ref)) ?? primaryRepo(cfg);

  /**
   * Route a ref to its repo: the sticky one if it has been routed before (route keys may
   * change mid-flow; the worktree/branch must not), else resolve its route keys and stick
   * it. Single-repo profiles never persist (every ref resolves to the one repo anyway).
   * @param {string} ref @param {import('../types.js').Task} task
   * @returns {{ repo: import('../types.js').RepoConfig } | { error: string, message: string }}
   */
  function resolveRoute(ref, task) {
    const stuck = store?.getRepo(ref);
    if (stuck != null) {
      const repo = repoById(cfg, stuck);
      return repo ? { repo } : { error: "unroutable", message: `sticky repo "${stuck}" is no longer configured` };
    }
    const routed = resolveRepo(cfg, task.routeKeys);
    if ("repo" in routed && cfg.multiRepo) store?.setRepo(ref, routed.repo.id);
    return routed;
  }

  /** overlapGuard: the ref left the pipeline (drain / fail / merge) — drop its predicted
   * paths and any stale wait, free its lock, wake whoever waited on it. No-op when off.
   * @param {string} ref */
  function leavePipeline(ref) {
    if (!cfg.overlapGuard) return;
    store?.clearPredictedPaths(ref);
    store?.clearOverlap(ref);
    releaseOverlap?.(ref);
  }

  /** Cache the ref's PR number in refmeta once one exists. Receiver-side only (the CLIs
   * never write state); skipped for PR-less trackers and once a PR is known.
   * @param {string} ref @param {import('../types.js').RepoConfig} [repo]  the checkout `gh` runs in */
  async function recordPr(ref, repo = stickyRepo(ref)) {
    if (!store || meta.usesPR === false || store.getRefMeta(ref)?.pr) return;
    const pr = await lookupPr(repo.path, ref);
    if (pr) store.setRefMeta(ref, { pr });
  }

  return { stepIndex, stickyRepo, resolveRoute, leavePipeline, recordPr };
}

/** @typedef {ReturnType<typeof createRouting>} Routing */
