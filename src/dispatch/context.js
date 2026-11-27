// Types only (no runtime code): the per-createDispatcher state every src/dispatch/ factory
// is built from. One object per dispatcher — two dispatchers never share any of it.

/**
 * @typedef {{killGraceMs?: number, finalizeTimeoutMs?: number, energySampler?: Pick<ReturnType<typeof import('../energy-sampler.js').createEnergySampler>, "start"|"stop">, onQuota?: (q: import('../shared/quota.js').QuotaReading, meta: {harness: string|null, stepId: string}) => void, sandbox?: import('../types/index.js').Sandbox|null, executors?: {host: import('../types/index.js').Executor, sandbox?: import('../types/index.js').Executor, ssh?: Record<string, import('../types/index.js').Executor>}}} DispatchOpts
 */

/**
 * @typedef {object} DispatchState
 * @property {import('../types/index.js').Config} cfg
 * @property {import('../types/index.js').Adapter} adapter
 * @property {Set<import('node:child_process').ChildProcess>} [children]
 * @property {import('../types/index.js').Store} [store]
 * @property {(event: string, ref: string, step: string, extra?: Record<string, any>) => void} [emit]
 * @property {import('../types/index.js').Forge|null} [forge]
 * @property {(blocker: string) => void} [releaseOverlap]
 * @property {DispatchOpts} opts
 * @property {import('../types/index.js').AdapterMeta} meta
 * @property {Pick<ReturnType<typeof import('../energy-sampler.js').createEnergySampler>, "start"|"stop">|null} energySampler
 * @property {number} killGraceMs
 * @property {number} finalizeTimeoutMs
 * @property {Set<string>} busy  refs with a pipeline job in runClaude (spawn through advance)
 * @property {Map<string, number>} pids  live agent pid per ref (operator cancel)
 * @property {Set<string>} cancelled  refs asked to stop
 * @property {Set<string>} preSpawn  refs between runClaude() starting and the agent being spawned
 * @property {Map<string, NodeJS.Timeout>} killTimers  pending SIGKILL per ref
 * @property {import('../types/index.js').Sandbox|null} sandbox  the profile's sandbox (null = runs on the host)
 * @property {{host: import('../types/index.js').Executor, sandbox?: import('../types/index.js').Executor, ssh?: Record<string, import('../types/index.js').Executor>}} executors  the executor axis (#682, #689): which launcher a run picks, per step (src/dispatch/executor.js)
 * @property {Map<string, import('../types/index.js').ExecutorRun>} executorRuns  live sandboxed run per ref (kill paths); host runs are never stored here
 */

export {};
