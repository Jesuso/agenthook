// The executor axis (#682 phase 1, part of the remote-harness epic #681): which launcher runs a
// job — the host (a plain spawn) or the profile's sandbox (a per-run container) — chosen per run,
// after the harness resolves. No behaviour change yet: `executorFor` answers exactly what
// `isSandboxed` answered before this axis existed.
import { isSandboxed } from "../sandbox/names.js";

/**
 * The host executor (always available) plus, when the profile configures one, the sandbox
 * executor — its `launch`/`reap` wrap today's `sandbox.wrap()`/`sandbox.reap()` verbatim.
 * @param {{cfg?: import('../types.js').Config, sandbox: import('../types.js').Sandbox|null, spawnPaths?: {verdictPathFor: (stepId: string, ref: string) => string, sandboxVerdictPathFor: (stepId: string, ref: string) => string}}} o
 * @returns {{host: import('../types.js').Executor, sandbox?: import('../types.js').Executor}}
 */
export function createExecutors({ sandbox, spawnPaths }) {
  /** @type {import('../types.js').Executor} */
  const host = {
    name: "host",
    paths: ({ stepId, ref, worktree, hasWorktree, repoPath }) => ({
      cwd: hasWorktree ? worktree : repoPath,
      worktree: hasWorktree ? worktree : undefined,
      verdictFile: /** @type {NonNullable<typeof spawnPaths>} */ (spawnPaths).verdictPathFor(stepId, ref),
    }),
    launch: async ({ bin, args, env }) => ({ bin, args, env, id: "", kill: async () => {}, done: async () => ({}) }),
  };
  if (!sandbox) return { host };
  /** @type {import('../types.js').Executor} */
  const sandboxExecutor = {
    name: "sandbox",
    paths: ({ stepId, ref, worktree, hasWorktree, repoPath }) => ({
      cwd: hasWorktree ? worktree : repoPath,
      worktree: hasWorktree ? worktree : undefined,
      verdictFile: /** @type {NonNullable<typeof spawnPaths>} */ (spawnPaths).sandboxVerdictPathFor(stepId, ref),
    }),
    launch: (o) => sandbox.wrap(o),
    reap: () => sandbox.reap(),
  };
  return { host, sandbox: sandboxExecutor };
}

/**
 * The executor a step's run uses: `sandbox` exactly when the profile has one and the step didn't
 * opt out (`isSandboxed`), else `host`. `harnessName` rides along for a future executor that
 * varies by harness (e.g. a remote one) — it never changes today's answer. Pure.
 * @param {{sandbox?: unknown}} cfg
 * @param {{sandbox?: boolean}|undefined} step
 * @param {string|null|undefined} harnessName
 * @param {{host: import('../types.js').Executor, sandbox?: import('../types.js').Executor}} executors
 * @returns {import('../types.js').Executor}
 */
export function executorFor(cfg, step, harnessName, executors) {
  return executors.sandbox && isSandboxed(cfg, step) ? executors.sandbox : executors.host;
}
