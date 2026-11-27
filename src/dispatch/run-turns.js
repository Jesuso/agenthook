// The shared spawnAgent() options every turn in a run passes (#682 harness knobs, #474 creds, the
// run's own sandbox/executor wrap). Pulled out of step.js's three spawnAgent() call sites, which
// differed only in prompt/maxMs/resumeSessionId.

/**
 * The shared spawnAgent() options every turn in a run passes (#682 harness knobs, #474 creds, the
 * run's own sandbox/executor wrap): only `prompt`, `maxMs` and `resumeSessionId` differ between
 * the first turn, a verdict-repair turn and a gate-repair turn, and `resumeSessionId` must stay
 * ABSENT (not `undefined`) on a turn that passes none — so it's an optional field here, spread in
 * only when given.
 * @param {{agent: import('../types/index.js').AgentAdapter, cwd: string, logPath: string, promptFile: string|undefined, model: string|undefined, effort: string|undefined, provider: string|undefined, step: import('../types/index.js').Step, spawnStep: import('../types/index.js').Step, agentEnv: Record<string,string>|undefined, creds: import('../types/index.js').RunCredentials|null, verdictFile: string, sandboxedRun: Parameters<import('./spawn.js').Spawn['spawnAgent']>[0]['sandboxed'], executor: import('../types/index.js').Executor, onPid: (p: number|undefined) => void, onTally: (tally: {input: number, output: number, cacheRead: number, cacheCreate: number, lastContext?: number}) => void}} rc
 * @param {{prompt: string, maxMs: number, resumeSessionId?: string}} turn
 */
export function spawnOptions(rc, { prompt, maxMs, resumeSessionId }) {
  const { agent, cwd, logPath, promptFile, model, effort, provider, step, spawnStep, agentEnv, creds, verdictFile, sandboxedRun, executor, onPid, onTally } = rc;
  return {
    agent,
    prompt,
    cwd,
    logPath,
    promptFile,
    model,
    effort,
    provider,
    toolsets: spawnStep.toolsets,
    isolated: step.isolated,
    allow: step.allow,
    deny: step.deny,
    bin: spawnStep.bin,
    agentEnv,
    creds,
    env: spawnStep.env,
    verdictFile,
    sandboxed: sandboxedRun,
    executor,
    maxMs,
    ...(step.idleMinutes ? { idleMs: step.idleMinutes * 60000 } : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    onPid,
    onTally,
  };
}
