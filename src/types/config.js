/** @typedef {import('./pipeline.js').Step} Step */
/** @typedef {import('./tracker.js').ProviderConfig} ProviderConfig */
/** @typedef {import('./ingress.js').IngressConfig} IngressConfig */
/** @typedef {import('./sandbox.js').SandboxConfig} SandboxConfig */
/** @typedef {import('./forge.js').ForgeConfig} ForgeConfig */
/** @typedef {import('./harness.js').Harness} Harness */

/**
 * An event sink (`sinks[]` in agenthook.config.json): forwards lifecycle events to a chat/webhook.
 * @typedef {object} SinkConfig
 * @property {"slack"|"telegram"|"webhook"} type
 * @property {string} [url]        slack incoming-webhook / generic webhook URL
 * @property {string} [botToken]   telegram bot token
 * @property {string|number} [chatId]  telegram chat id
 * @property {string[]} [events]   events to forward (default blocked, failed, pipeline_done)
 */
/**
 * Resolved runtime config. All paths are absolute. See config.js for the four
 * distinct location fields (install/config/state/repo).
 * @typedef {object} Config
 * @property {string} name           profile label (display, sinks); keys the state dir only when stateId is unset
 * @property {string} [stateId]      optional stable state key, so `name` can change without moving state
 * @property {string} stateKey       stateId ?? name; keys the central state dir
 * @property {string} installDir     read-only package root
 * @property {string} configPath     absolute path to the loaded agenthook.config.json
 * @property {string} configDir      dir holding the config
 * @property {string} stateDir       ~/.agenthook/<stateKey>
 * @property {string} provider       active tracker key (= tracker.type)
 * @property {ProviderConfig} tracker
 * @property {ProviderConfig} providerConfig  alias of tracker, for adapter back-compat
 * @property {Step[]|null} pipeline  resolved tracker.pipeline (null when not configured)
 * @property {IngressConfig} ingress
 * @property {SinkConfig[]} [sinks]  optional human-attention sinks fed from the event bus
 * @property {ForgeConfig} [forge]   optional; absent = no forge (no PR awareness)
 * @property {SandboxConfig} [sandbox]  optional; absent = agents run on the host. Set = each run in its own container (src/sandbox/)
 * @property {Record<string, Harness>} [harnesses]  named agent backends, each with its own slot pool; a step's `harness` picks from them
 * @property {{ color?: string, emoji?: string }} [ui]  optional profile identity for the web UI (src/shared/identity.js); unset values derive from the state key
 * @property {{ soul: string, access?: 'snapshot', model?: string, maxBudgetUsd?: number }} digest  the on-demand Digest (src/digest.js); `soul` is resolved beside the config; unset `model`/`maxBudgetUsd` fall back to `summaries.*`
 * @property {{ model?: string, maxBudgetUsd?: number }} [summaries]  cheap tool-less summaries in the UI language (src/summarize.js); `model` default "claude-haiku-5-5", `maxBudgetUsd` default 0.1 per ticket-summary run
 * @property {Record<string, { input: number, output: number, cacheRead?: number, cacheWrite?: number }>} [pricing]  API-equivalent $/Mtok per model name or glob (src/shared/pricing.js); checked before the built-in Claude rates
 * @property {{ usdPerKwh: number, source: { type: 'hwmon'|'command'|'watts', name?: string, cmd?: string, watts?: number } }} [energy]  local energy basis (src/shared/energy.js): the power source an `energy: true` step's runs are measured with, and the electricity price
 * @property {{ pauseAboveSevenDay?: number, pauseAboveFiveHour?: number }} [quota]  opt-in Claude quota pacer (src/shared/quota.js): pause admission at/above a window's utilization (0–1], resume at its reset
 * @property {number} port
 * @property {string} trigger
 * @property {number} maxConcurrent
 * @property {boolean} [overlapGuard]  opt-in (default false); hold a createsWorktree step while its predicted paths overlap another in-flight ref's lock
 * @property {string} [language]    optional BCP-47 tag (e.g. "es"); human-facing text agents write (verdict reason/summary.plain, tracker comments, held questions, the Digest) is written in it. Unset = no instruction. Code, commits, PR titles/bodies and identifiers are unaffected.
 * @property {boolean} [fullAuto]   opt-in; adds the agent CLI's skip-permissions flag (code exec from a webhook, on the host unless `sandbox` is set). Default false = headless agents can't prompt: privileged tool calls are denied unless an allow rule (repo `.claude/settings.json` or a step `allow` policy) permits them (claude runs are pinned to dontAsk).
 * @property {boolean} [attribution]  claude-only; commit/PR attribution trailers. Unset = follow the operator's own `~/.claude/settings.json` (seeded into a sandboxed run's HOME so it sees the same preference the host already does); false = force attribution off, host and sandboxed alike; true = leave the CLI's own default. Other agents ignore it.
 * @property {string} repoPath     the default repo's path (else the first declared) — ops readers use it; dispatch goes through `repos`
 * @property {RepoConfig[]} repos    always populated: the declared `repos`, or one synthesized `default` repo from repoPath
 * @property {boolean} multiRepo     true iff the profile declared a `repos` block (worktrees nest under `<base>/<repo.id>/`)
 * @property {string} [agent]      profile-default agent adapter (src/agents/; default "claude"); a step's `agent` overrides it
 * @property {string[]} [agentEnvPassthrough]  extra receiver env var names (or PREFIX*) passed to agents; "*" = all. Default: only the allowlist (src/agent-env.js)
 * @property {boolean} [githubRunToken]  default true; only acts under GitHub App auth (tracker or forge). false = agents get the #470 env (your own GITHUB_TOKEN / gh auth)
 * @property {string} [agentProvider]  profile-default inference provider for a step's agent (hermes `--provider`); a step's `provider` overrides it
 * @property {string} claudeBin
 * @property {string} [worktreePrefix]
 * @property {string} [branchPrefix]  prefix for every receiver-made branch (default "agent/"); two profiles sharing a repo need distinct ones so `ensureWorktree` doesn't reuse the other's branch
 * @property {string} dataDir
 * @property {string} logDir
 * @property {string} instructionsFile
 * @property {string} publicUrlFile
 * @property {string} pidFile
 * @property {string} heartbeatFile
 * @property {string} controlSock
 */

/**
 * One checkout agents can work in (`repos[]` in agenthook.config.json). A task's
 * Task.routeKeys select it via `match` (src/repos.js).
 * @typedef {object} RepoConfig
 * @property {string} id                 stable id ([A-Za-z0-9._-]+); keys the worktree subdir + the sticky store
 * @property {string} path               absolute checkout root
 * @property {string[]} match            route keys selecting this repo (trimmed + lowercased at load)
 * @property {boolean} [default]         the repo an unrouted task (no route key) resolves to; at most one
 * @property {string} [instructionsFile] absolute; repo context prepended to the step's standing instructions
 * @property {string} [worktreePrefix]   per-repo override of the global worktreePrefix (resolved against `path`)
 */

/**
 * Operator runtime overrides persisted in overrides.json (src/store/) and re-applied at boot
 * (src/engine/index.js). Only the operator's own `pause`/`resume`/`set_concurrency` write these;
 * a restart/decommission/quota pause is never persisted.
 * @typedef {object} Overrides
 * @property {true} [paused]           global operator pause (a resume clears it)
 * @property {number} [maxConcurrent]  global cap override (1..64; a reset removes the entry)
 * @property {Record<string, number>} [harnesses]  per-harness slot override (name → 0..64; 0 drains, a reset removes an entry)
 */

export {};
