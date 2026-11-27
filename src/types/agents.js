
/** @typedef {import('./pipeline.js').StepPolicy} StepPolicy */
/** @typedef {import('./pipeline.js').Step} Step */
/** @typedef {import('./state.js').UsageRecord} UsageRecord */
/** @typedef {import('./sandbox.js').SandboxMount} SandboxMount */
/** @typedef {import('./config.js').Config} Config */

/** A live stdout parser an agent adapter hands dispatch for one run. Pure, stateful:
 * push() chunks, flush() the tail at EOF, then read `result` / `sessionId`.
 * @typedef {object} AgentParser
 * @property {(chunk: string) => string} push   log text rendered from the completed lines
 * @property {() => string} flush               log text from a final unterminated line
 * @property {{input: number, output: number, cacheRead: number, cacheCreate: number, turns?: number, firstContext?: number, peakContext?: number, lastContext?: number, compactions?: number}} tally  live token estimate; turns/firstContext/peakContext/lastContext (#645) stay unset until the first turn with usage, when the agent reports per-turn usage at all; compactions (#657) is 0 from the start on claude/opencode (they can detect it), unset on cursor/hermes
 * @property {any} result                       the agent's final result record (null until seen); passed to `usageRecord`
 * @property {string|undefined} sessionId       the run's session id, once known
 * @property {(chunk: string) => void} [pushStderr]  stderr reaches the parser only through this (e.g. hermes' session id)
 * @property {import('../shared/quota.js').QuotaReading|null} [quota]  the latest subscription-quota reading (claude's `rate_limit_event`); other agents don't report one
 */

/** Context for an agent's usage record (everything but the result).
 * @typedef {object} AgentUsageCtx
 * @property {string} ref
 * @property {string} stepId
 * @property {string} [model]       the step's resolved `--model` (unset = CLI default)
 * @property {string} [bin]         the step's `bin` override
 * @property {string} [claudeBin]
 * @property {string} startedAt
 * @property {string} endedAt
 */

/** Where an agent keeps its session transcripts (backs follow / resume / src/sessions.js).
 * @typedef {object} AgentSessions
 * @property {(cwd: string) => string} transcriptDir  the transcript dir of an agent launched in `cwd`
 * @property {(sessionId: string) => string[]} resumeCommand  resume argv (after the binary)
 * @property {(dir: string) => {id: string, file: string, at?: number}[]} files  the session transcripts in a transcript dir; `at` = start-time fallback when lines carry no timestamp
 * @property {(baseCwd: string) => {dirs: string[], searched: string}} cwdDirs  existing transcript dirs of every cwd under `baseCwd` (+ the pattern searched, for errors)
 * @property {(stateDir: string, cwd: string) => string} [sandboxTranscriptDir]  the transcript dir of a sandboxed run in a `cwd` it doesn't own (a no-worktree step), so `follow` finds it
 */

/** An agent adapter: the coding-agent CLI a step spawns (src/agents/). dispatch, follow and
 * resume reach the CLI only through it.
 * @typedef {object} AgentAdapter
 * @property {() => {name: string, stdout: string, promptFile?: boolean, policy?: {allow: boolean, deny: boolean}, sandboxResume?: boolean}} describe  `promptFile: true` = dispatch passes the prompt via a file, not argv; `policy` = which step policies (`allow`/`deny`) the CLI can enforce — a step setting one it can't is refused; `sandboxResume: false` = a sandboxed run of this agent can never resume a session (opencode: its session db lives in the per-run sandbox HOME, deleted at teardown) — absent/true = it can
 * @property {(o: {prompt: string, model?: string, effort?: string, provider?: string, fullAuto?: boolean, attribution?: boolean, promptFile?: string, maxMs?: number, toolsets?: string[], isolated?: boolean, allow?: StepPolicy, deny?: StepPolicy, cwd?: string, verdictFile?: string}) => string[]} buildArgs  argv after the executable
 * @property {(o: {prompt: string, model?: string, effort?: string, provider?: string, fullAuto?: boolean, attribution?: boolean, promptFile?: string, maxMs?: number, toolsets?: string[], isolated?: boolean, allow?: StepPolicy, deny?: StepPolicy, cwd?: string, verdictFile?: string, sessionId: string}) => string[]} [resumeArgs]  one verdict-repair turn (#677): same options as buildArgs plus the session to resume headlessly; unset = this agent can't resume headlessly (hermes)
 * @property {() => AgentParser} createParser
 * @property {(result: any, ctx: AgentUsageCtx) => UsageRecord} usageRecord  `result` may be null (no result seen): zero tokens, `unpriced` still resolved
 * @property {AgentSessions|null} sessions  null = no transcripts to follow/resume
 * @property {(sessionId: string) => string[]} [resumeCommand]  resume argv (after the binary) for an agent with `sessions: null` whose session ids come from usage.jsonl (opencode)
 * @property {(ctx: {cfg: Pick<Config, 'stateDir'|'dataDir'>, step: Step|undefined}) => Record<string, string>|undefined} [env]  extra environment for the agent (at spawn and `resume`), under the step's `env` (hermes: an isolated step's HERMES_HOME)
 * @property {(ctx: {cfg: Pick<Config, 'stateDir'|'dataDir'>, step: Step, provider?: string, sandboxed?: boolean, env?: Record<string, string>}) => string|undefined} [preflight]  run before spawn: a returned reason fails the run with no agent spawned (hermes: prepare the isolated home, refuse a provider it has no credentials for; claude: refuse a sandboxed run with no credential var in `env`, the spawn env)
 * @property {(env: Record<string, string>, ctx?: {step?: Step}) => string[]} [egressHosts]  egress rules for the model API a run with this spawn env talks to (claude: api.anthropic.com, ANTHROPIC_BASE_URL's host, Bedrock/Vertex; pi: the `host:port` of each `providers.*.baseUrl` in its `piConfigDir/models.json`, via `ctx.step`). An additive optional second argument carries the step so an agent that reads its model config from a file can see which step's. A sandboxed run's allowlist includes them
 * @property {(ctx: {cfg: Config, step: Step, cwd: string, ownsCwd: boolean, home: string, verdictFile?: string, standing?: string}) => {mounts: SandboxMount[], env?: Record<string, string>, files?: {dst: string, content: string, mode?: number}[], args?: string[], standingInInstructions?: boolean}} [sandbox]  what a sandboxed run of this agent needs beyond the worktree (claude: its one transcript dir, under the container `home`; opencode: its `opencodeConfig` plus, when `verdictFile` is given, an unattended-contract file wired into `instructions`, and optionally a second standing-instructions file `agenthook-standing.md` if `standing` is provided and ≤ 16 KB, both written via `files`). `ownsCwd` = cwd is the run's own worktree; false = the operator's main checkout, so nothing keyed by it on the host may be mounted. `files[].dst` is an absolute container path under `home`, written into the per-run sandbox HOME (never mounted — it's gone at teardown). `verdictFile` is the agent-visible path the run must write its verdict JSON to. `standingInInstructions: true` = the standing text was written to a `files` entry wired into `instructions`, so dispatch drops it from the run prompt (deduped, not doubled). `args` = extra agent flags, inserted before the argv's `--` separator by `spawnAgent` (pi: one `--append-system-prompt <file>` per contract/standing file written to `files`). An agent without a `sandbox` hook is refused when sandboxed
 * @property {(ctx: {cfg: Config, step: Step, dir: string, verdictFile: string, standing?: string}) => {files: {dst: string, content: string, mode?: number}[], env: Record<string, string>, args?: string[], standingInInstructions?: boolean}} [remote]  what a remote-harness run (#689/#739/#827) of this agent needs on the worker beyond the synced code: `dir` is a per-run directory on the WORKER (the ssh executor's `paths().configDir`) the returned `files[].dst` paths must sit under — unlike `sandbox`'s `home`, there's no container teardown, so the executor itself removes `dir` after the run. `env` is an explicit, named addition to the worker env allowlist (never a prefix passthrough) — exactly the keys this run needs (opencode: `OPENCODE_CONFIG` pointing at a generated config in `dir`, plus `OPENCODE_DISABLE_AUTOUPDATE`/`OPENCODE_DISABLE_MODELS_FETCH`; pi: `PI_OFFLINE`). `args` = extra agent flags spliced before the argv's `--` separator (pi: one `--append-system-prompt <file>` per contract/standing file written to `files`), applied to resume turns too — same shape as `sandbox`'s own. `standingInInstructions` means the same as `sandbox`'s own. An agent with no `remote` hook can still run on a remote harness with no extra files/env (today: none do — claude needs none either). Throwing refuses the run ("remote setup failed: …") rather than spawning
 * @property {(ctx: {sessionId: string, bin: string, env: Record<string, string>, dir: string, timeoutMs: number}) => Promise<{input?: number, output?: number, cacheRead?: number, cacheCreate?: number, model?: string}|null>} [finalize]  best-effort, post-exit, bounded token capture (hermes: `sessions export`); may throw or return null — dispatch never lets it affect the verdict
 * @property {{requireVerdict?: boolean, bin?: string}} defaults  step `requireVerdict` / `bin` win over these
 * @property {string[]} [envPassthrough]  receiver env vars (NAME or PREFIX*) this CLI needs, added to the agent env allowlist (src/agent-env.js): auth keys, config vars
 */

export {};
