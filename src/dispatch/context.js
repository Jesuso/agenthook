// Types only (no runtime code): the per-createDispatcher state every src/dispatch/ factory
// is built from. One object per dispatcher — two dispatchers never share any of it.

/**
 * @typedef {{killGraceMs?: number, finalizeTimeoutMs?: number, energySampler?: Pick<ReturnType<typeof import('../energy-sampler.js').createEnergySampler>, "start"|"stop">, onQuota?: (q: import('../shared/quota.js').QuotaReading, meta: {harness: string|null, stepId: string}) => void, sandbox?: import('../types/sandbox.js').Sandbox|null, executors?: {host: import('../types/sandbox.js').Executor, sandbox?: import('../types/sandbox.js').Executor, ssh?: Record<string, import('../types/sandbox.js').Executor>}}} DispatchOpts
 */

/**
 * @typedef {object} DispatchState
 * @property {import('../types/config.js').Config} cfg
 * @property {import('../types/tracker.js').Adapter} adapter
 * @property {Set<import('node:child_process').ChildProcess>} [children]
 * @property {import('../types/state.js').Store} [store]
 * @property {(event: string, ref: string, step: string, extra?: Record<string, any>) => void} [emit]
 * @property {import('../types/forge.js').Forge|null} [forge]
 * @property {(blocker: string) => void} [releaseOverlap]
 * @property {DispatchOpts} opts
 * @property {import('../types/tracker.js').AdapterMeta} meta
 * @property {Pick<ReturnType<typeof import('../energy-sampler.js').createEnergySampler>, "start"|"stop">|null} energySampler
 * @property {number} killGraceMs
 * @property {number} finalizeTimeoutMs
 * @property {Set<string>} busy  refs with a pipeline job in runClaude (spawn through advance)
 * @property {Map<string, number>} pids  live agent pid per ref (operator cancel)
 * @property {Set<string>} cancelled  refs asked to stop
 * @property {Set<string>} preSpawn  refs between runClaude() starting and the agent being spawned
 * @property {Map<string, NodeJS.Timeout>} killTimers  pending SIGKILL per ref
 * @property {import('../types/sandbox.js').Sandbox|null} sandbox  the profile's sandbox (null = runs on the host)
 * @property {{host: import('../types/sandbox.js').Executor, sandbox?: import('../types/sandbox.js').Executor, ssh?: Record<string, import('../types/sandbox.js').Executor>}} executors  the executor axis (#682, #689): which launcher a run picks, per step (src/dispatch/executor.js)
 * @property {Map<string, import('../types/sandbox.js').ExecutorRun>} executorRuns  live sandboxed run per ref (kill paths); host runs are never stored here
 */

export {};
