// Types only (no runtime code): the per-createDispatcher state every src/dispatch/ factory
// is built from. One object per dispatcher — two dispatchers never share any of it.

/**
 * @typedef {{killGraceMs?: number, finalizeTimeoutMs?: number, energySampler?: Pick<ReturnType<typeof import('../energy-sampler.js').createEnergySampler>, "start"|"stop">, onQuota?: (q: import('../quota.js').QuotaReading) => void}} DispatchOpts
 */

/**
 * @typedef {object} DispatchState
 * @property {import('../types.js').Config} cfg
 * @property {import('../types.js').Adapter} adapter
 * @property {Set<import('node:child_process').ChildProcess>} [children]
 * @property {import('../types.js').Store} [store]
 * @property {(event: string, ref: string, step: string, extra?: Record<string, any>) => void} [emit]
 * @property {import('../types.js').Forge|null} [forge]
 * @property {(blocker: string) => void} [releaseOverlap]
 * @property {DispatchOpts} opts
 * @property {import('../types.js').AdapterMeta} meta
 * @property {Pick<ReturnType<typeof import('../energy-sampler.js').createEnergySampler>, "start"|"stop">|null} energySampler
 * @property {number} killGraceMs
 * @property {number} finalizeTimeoutMs
 * @property {Set<string>} busy  refs with a pipeline job in runClaude (spawn through advance)
 * @property {Map<string, number>} pids  live agent pid per ref (operator cancel)
 * @property {Set<string>} cancelled  refs asked to stop
 * @property {Set<string>} preSpawn  refs between runClaude() starting and the agent being spawned
 * @property {Map<string, NodeJS.Timeout>} killTimers  pending SIGKILL per ref
 */

export {};
