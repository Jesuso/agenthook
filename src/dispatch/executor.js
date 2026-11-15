// The executor axis (#682 phase 1, #689 phase 2 — the remote-harness epic #681): which launcher
// runs a job — the host (a plain spawn), the profile's sandbox (a per-run container), or a
// harness's remote worker over ssh — chosen per run, after the harness resolves. Host/sandbox:
// no behaviour change — `executorFor` answers exactly what `isSandboxed` answered before this
// axis existed, unless the resolved harness itself names a remote worker.
import { isSandboxed } from "../sandbox/names.js";
import { createSshExecutors } from "./executor-ssh.js";

/**
 * The host executor (always available), the profile's sandbox executor when it configures one
 * (its `launch`/`reap` wrap today's `sandbox.wrap()`/`sandbox.reap()` verbatim), and one `ssh`
 * executor per harness with a `remote` block (#689, experimental).
 * @param {{cfg?: Pick<import('../types.js').Config, 'stateKey'|'harnesses'>, sandbox: import('../types.js').Sandbox|null, spawnPaths?: {verdictPathFor: (stepId: string, ref: string) => string, sandboxVerdictPathFor: (stepId: string, ref: string) => string}}} o
 * @returns {{host: import('../types.js').Executor, sandbox?: import('../types.js').Executor, ssh?: Record<string, import('../types.js').Executor>}}
 */
export function createExecutors({ cfg, sandbox, spawnPaths }) {
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
  const ssh = createSshExecutors({ cfg, spawnPaths });
  if (!sandbox) return { host, ...(Object.keys(ssh).length ? { ssh } : {}) };
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
  return { host, sandbox: sandboxExecutor, ...(Object.keys(ssh).length ? { ssh } : {}) };
}

/**
 * The executor a step's run uses: the harness's `ssh` executor when the resolved harness has a
 * remote worker; else `sandbox` exactly when the profile has one and the step didn't opt out
 * (`isSandboxed`); else `host`. Pure.
 * @param {{sandbox?: unknown}} cfg
 * @param {{sandbox?: boolean}|undefined} step
 * @param {string|null|undefined} harnessName
 * @param {{host: import('../types.js').Executor, sandbox?: import('../types.js').Executor, ssh?: Record<string, import('../types.js').Executor>}} executors
 * @returns {import('../types.js').Executor}
 */
export function executorFor(cfg, step, harnessName, executors) {
  if (harnessName && executors.ssh && Object.hasOwn(executors.ssh, harnessName)) return executors.ssh[harnessName];
  return executors.sandbox && isSandboxed(cfg, step) ? executors.sandbox : executors.host;
}

/**
 * Reap everything every executor left running (#689): the profile's sandbox (containers/
 * networks) plus every remote harness's leftover pgids, each best-effort — one failing never
 * blocks the rest. Aggregates into the same `{containers, networks, runs}` shape.
 * @param {{sandbox?: import('../types.js').Executor, ssh?: Record<string, import('../types.js').Executor>}} executors
 * @returns {Promise<{containers: string[], networks: string[], runs: string[]}>}
 */
export async function reapAll(executors) {
  const containers = /** @type {string[]} */ ([]);
  const networks = /** @type {string[]} */ ([]);
  const runs = /** @type {string[]} */ ([]);
  for (const ex of [executors.sandbox, ...Object.values(executors.ssh ?? {})]) {
    if (!ex?.reap) continue;
    try {
      const r = await ex.reap();
      containers.push(...r.containers);
      networks.push(...r.networks);
      runs.push(...r.runs);
    } catch (e) {
      console.error(`[reap] ${ex.name} reap failed (continuing): ${e.message}`);
    }
  }
  return { containers, networks, runs };
}
