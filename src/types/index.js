// Shared type surface for the engine and adapters. JSDoc-only — no runtime code,
// so it stays zero-build (checked by `tsc --noEmit`, never compiled). Reference a
// type from anywhere with `import('../types/index.js').Adapter`.
//
// The Adapter interface (see tracker.js) IS the provider contract. Adding a tracker
// = writing one object that satisfies it (see src/providers/asana.js for the reference impl).
//
// Split by domain across this folder's files; this file re-exports every name so
// outside code never imports a domain file directly.

/** @typedef {import('./pipeline.js').Job} Job */
/** @typedef {import('./pipeline.js').CiRun} CiRun */
/** @typedef {import('./pipeline.js').StepPolicy} StepPolicy */
/** @typedef {import('./pipeline.js').HarnessEntry} HarnessEntry */
/** @typedef {import('./pipeline.js').Step} Step */
/** @typedef {import('./pipeline.js').StepOutcome} StepOutcome */
/** @typedef {import('./pipeline.js').Verdict} Verdict */
/** @typedef {import('./state.js').SummaryRecord} SummaryRecord */
/** @typedef {import('./state.js').RunningInfo} RunningInfo */
/** @typedef {import('./state.js').RefMeta} RefMeta */
/** @typedef {import('./state.js').RefMetaPatch} RefMetaPatch */
/** @typedef {import('./state.js').HeldInfo} HeldInfo */
/** @typedef {import('./state.js').LockInfo} LockInfo */
/** @typedef {import('./state.js').OverlapInfo} OverlapInfo */
/** @typedef {import('./state.js').UsageRecord} UsageRecord */
/** @typedef {import('./state.js').Store} Store */
/** @typedef {import('./tracker.js').Task} Task */
/** @typedef {import('./tracker.js').EpicRef} EpicRef */
/** @typedef {import('./tracker.js').Epic} Epic */
/** @typedef {import('./tracker.js').EpicTicket} EpicTicket */
/** @typedef {import('./tracker.js').StageOption} StageOption */
/** @typedef {import('./tracker.js').StageKeys} StageKeys */
/** @typedef {import('./tracker.js').AdapterMeta} AdapterMeta */
/** @typedef {import('./tracker.js').TicketComment} TicketComment */
/** @typedef {import('./tracker.js').RunCredentials} RunCredentials */
/** @typedef {import('./tracker.js').RunCredentialsInput} RunCredentialsInput */
/** @typedef {import('./tracker.js').EventCtx} EventCtx */
/** @typedef {import('./tracker.js').AuthResult} AuthResult */
/** @typedef {import('./tracker.js').ForgedEvent} ForgedEvent */
/** @typedef {import('./tracker.js').Adapter} Adapter */
/** @typedef {import('./tracker.js').AdapterFactory} AdapterFactory */
/** @typedef {import('./tracker.js').ProviderConfig} ProviderConfig */
/** @typedef {import('./tracker.js').GithubAuthConfig} GithubAuthConfig */
/** @typedef {import('./ingress.js').IngressConfig} IngressConfig */
/** @typedef {import('./ingress.js').IngressMeta} IngressMeta */
/** @typedef {import('./ingress.js').Ingress} Ingress */
/** @typedef {import('./ingress.js').IngressFactory} IngressFactory */
/** @typedef {import('./ingress.js').IngressRun} IngressRun */
/** @typedef {import('./sandbox.js').SandboxConfig} SandboxConfig */
/** @typedef {import('./sandbox.js').ServiceConfig} ServiceConfig */
/** @typedef {import('./sandbox.js').EgressConfig} EgressConfig */
/** @typedef {import('./sandbox.js').SandboxEgress} SandboxEgress */
/** @typedef {import('./sandbox.js').SandboxMount} SandboxMount */
/** @typedef {import('./sandbox.js').SandboxReport} SandboxReport */
/** @typedef {import('./sandbox.js').SandboxRun} SandboxRun */
/** @typedef {import('./sandbox.js').Sandbox} Sandbox */
/** @typedef {import('./sandbox.js').SandboxFactory} SandboxFactory */
/** @typedef {import('./sandbox.js').ExecutorRun} ExecutorRun */
/** @typedef {import('./sandbox.js').Executor} Executor */
/** @typedef {import('./agents.js').AgentParser} AgentParser */
/** @typedef {import('./agents.js').AgentUsageCtx} AgentUsageCtx */
/** @typedef {import('./agents.js').AgentSessions} AgentSessions */
/** @typedef {import('./agents.js').AgentAdapter} AgentAdapter */
/** @typedef {import('./forge.js').ForgeConfig} ForgeConfig */
/** @typedef {import('./forge.js').AutoMergeConfig} AutoMergeConfig */
/** @typedef {import('./forge.js').Forge} Forge */
/** @typedef {import('./forge.js').AutoMergeResult} AutoMergeResult */
/** @typedef {import('./forge.js').MergedAgentPr} MergedAgentPr */
/** @typedef {import('./forge.js').AgentPr} AgentPr */
/** @typedef {import('./forge.js').ForgeFactory} ForgeFactory */
/** @typedef {import('./harness.js').Harness} Harness */
/** @typedef {import('./harness.js').RemoteHarness} RemoteHarness */
/** @typedef {import('./config.js').SinkConfig} SinkConfig */
/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./config.js').RepoConfig} RepoConfig */
/** @typedef {import('./config.js').Overrides} Overrides */
/** @typedef {import('./doctor.js').Fix} Fix */
/** @typedef {import('./doctor.js').Check} Check */

export {};
