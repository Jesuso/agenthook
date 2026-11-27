/** @typedef {import('./pipeline.js').Job} Job */
/** @typedef {import('./state.js').Store} Store */
/** @typedef {import('./tracker.js').RunCredentials} RunCredentials */
/** @typedef {import('./tracker.js').RunCredentialsInput} RunCredentialsInput */
/** @typedef {import('./tracker.js').EventCtx} EventCtx */
/** @typedef {import('./tracker.js').AuthResult} AuthResult */
/** @typedef {import('./tracker.js').GithubAuthConfig} GithubAuthConfig */
/** @typedef {import('./config.js').Config} Config */

/**
 * The optional forge config block (`forge` in agenthook.config.json). `type` selects
 * the adapter; values are already env-interpolated.
 * @typedef {object} ForgeConfig
 * @property {string} type              forge adapter key ("github" | "gitlab")
 * @property {string} [token]           API token (typically "${GITHUB_TOKEN}" / "${GITLAB_TOKEN}")
 * @property {GithubAuthConfig} [auth]  GitHub: GitHub App auth instead of `token`
 * @property {string} [repository]      GitHub: "owner/name" whose PRs complete tasks
 * @property {string} [owner]           GitHub: repo owner (alternative to repository)
 * @property {string} [repo]            GitHub: repo name (alternative to repository)
 * @property {string} [project]         GitLab: "group/sub/project" whose MRs complete tasks
 * @property {string} [baseUrl]         GitLab: instance base URL (default "https://gitlab.com")
 * @property {string} [webhookSecret]   explicit signing secret (GitLab: the hook's secret token); omit to let agenthook generate+store one (no opt-out — always verified)
 * @property {boolean} [redCi]          react to red CI on agent PRs (re-run once, then bounce with `changes`). Default on; false disables
 * @property {boolean} [greenCi]        emit a `ci_green` event when an agent PR's checks all pass (a supervisor signal; moves nothing). Default on; false disables
 * @property {string} [ciTarget]        step a red-CI bounce goes back to; default the `createsWorktree` step (the branch owner)
 * @property {boolean} [boardClosesOnMerge]  the board closes its own tickets on merge (e.g. Jira/Linear with a dev-tool integration): every merge job is self-closing, so dispatch doesn't bridge it. Default false
 * @property {AutoMergeConfig} [autoMerge]  GitHub only, opt-in: when the approving step advances with a risk tier in `tiers`, mark the PR ready and enable GitHub auto-merge; a later bounce turns it off. Absent = off
 */

/**
 * `forge.autoMerge`: auto-merge an agent PR once a step approves it (src/auto-merge.js).
 * @typedef {object} AutoMergeConfig
 * @property {string[]} tiers    the `summary.tier` values that may auto-merge (e.g. ["low","medium"]); a verdict with no tier never does
 * @property {'squash'|'merge'|'rebase'} [method]  GitHub merge method (default "squash")
 * @property {string} [step]     the step whose `advance` triggers it; default the pipeline's last review-kind step
 * @property {string} [tierFrom] the step whose verdict carries the tier (its stored summary, which must be an `advance`); default `step`. Must not run after `step`, and must run after the `createsWorktree` step
 */

/** A forge adapter: where the CODE lives (PRs), as opposed to the tracker (tasks).
 * Serves the `/forge` path; turns a merged agent PR into a `merge` job and a red CI
 * run on one into a `ci` job. The CI methods are optional (a forge without them
 * never emits `ci` jobs); each throws on a non-2xx unless noted.
 * @typedef {object} Forge
 * @property {() => {name: string, agentEnv?: string[], egressHosts?: string[]}} describe  `agentEnv` = receiver env vars agents get with this forge (github: GH_TOKEN/GITHUB_TOKEN for `gh`); `egressHosts` = egress rules a sandboxed run needs to push and use the forge's CLI/API
 * @property {(ctx: EventCtx) => AuthResult} authenticate  sync, no network (same ACK window as the tracker)
 * @property {(ctx: EventCtx) => Promise<Job[]>} processEvents
 * @property {(publicUrl: string) => Promise<void>} registerWebhook  best-effort; a missing hook scope prints manual setup
 * @property {() => Promise<void>} unregisterWebhooks  deletes only this forge's hooks
 * @property {(prNumber: number|null, ref: string) => Promise<{number: number, sha: string, open: boolean}|null>} [prHead]  the ref's agent-branch PR (by number, else the open one), or null
 * @property {(prNumber: number) => Promise<'open'|'merged'|'closed'>} [prState]  one PR's state by number (any branch); throws on a non-2xx
 * @property {(since: string) => Promise<MergedAgentPr[]>} [listMergedAgentPrs]  PRs on the profile's branchPrefix (default `agent/`) branches merged after `since` (ISO), any order; backs the explicit merge catch-up (`runMergeCatchup`), never a timer. Throws on a non-2xx
 * @property {() => Promise<AgentPr[]>} [listAgentPrs]  open PRs on receiver-made branchPrefix (default `agent/`) branches of this repo, with CI + mergeability (read-only; the MCP `prs` tool)
 * @property {(prNumber: number, sha: string) => Promise<{mergeable: boolean|null, mergeState: string|null, ci: AgentPr['ci']}>} [ciStatus]  CI roll-up for one PR head + its mergeability (backs `ci_green`)
 * @property {(runId: number) => Promise<void>} [rerunFailedJobs]  re-run only the failed jobs of a run
 * @property {(runId: number, attempt: number) => Promise<string>} [failedLogTail]  tail of the failed jobs' logs (UNTRUSTED text); best-effort, "" on error
 * @property {(prNumber: number, body: string, log?: string) => Promise<void>} [prComment]  post `body` (trusted) + `log` (untrusted, fenced inert) on the PR
 * @property {(prNumber: number, o: {method: 'squash'|'merge'|'rebase', expectedSha: string}) => Promise<AutoMergeResult>} [enableAutoMerge]  mark the agent PR ready (if draft), then enable auto-merge pinned to `expectedSha` (`moved` when the head is no longer it). Idempotent; throws on a refusal (repo setting, permissions, network)
 * @property {(prNumber: number) => Promise<{status: 'disabled'|'off'|'merged'|'closed'}>} [disableAutoMerge]  turn auto-merge off on the agent PR (`off` = it was not on). Throws on a refusal
 * @property {(o: {worktree: string, branch: string, base?: string}) => Promise<{pushed: string[]}|{workflow: string, viaMerge?: boolean}>} [publishBranch]  optional (#825); hub-side push of `branch` at `worktree`'s HEAD under the forge's own credentials (a remote run's outbox — the agent itself never holds them). Refuses to push when ANY commit in the range — `origin/<branch>..HEAD` if the branch already exists on the remote, else `origin/<default>..HEAD` (`base` names that default, defaulting to the repo's) — touches `.github/workflows/`: returns `{workflow}` without pushing and the caller holds. When the touched file appears ONLY via a merge commit's diff (no plain commit in the range touches it) `viaMerge` is true — the held reason should say so (#829). Empty range (nothing new) → `{pushed: []}`. Throws on a push rejection — the message is what the caller reports as the fail reason
 * @property {(o: {branch: string, title: string, body: string}) => Promise<{number: number, created: boolean}>} [openPr]  optional (#825); hub-side open of the DRAFT PR for `branch` under the forge's own credentials. Reuses an already-open PR on the same head — then `created` is false (a rework run reuses the original PR). Throws on a non-2xx
 * @property {(text: string) => Promise<string[]>} [liveMentions]  optional (#829 redesign); render `text` through the forge's own Markdown engine (never notifies anyone) and return the lowercase user/team logins it would actually notify. Used to verify worker-written text is safe to publish under the hub's identity instead of re-implementing the renderer's code-vs-prose rules locally. Throws on a non-2xx, a timeout, or an unparseable response — the caller treats a throw as "assume live, fail closed"
 * @property {(answers: Record<string, any>) => import('../wizard.js').WizardStep[]} [wizardSteps]  optional; `agenthook init` prompts
 * @property {(o: RunCredentialsInput) => Promise<RunCredentials|null>} [runCredentials]  optional; same contract as Adapter.runCredentials. Dispatch asks the forge first, then the tracker when this returns null
 */

/** What `Forge.enableAutoMerge` did. `enabled`: auto-merge is now on; `already`: it was on before
 * (nothing changed); `merged_now`: GitHub reported nothing left to wait for, so the PR was merged
 * directly (what `gh pr merge --auto` does); `merged` / `closed`: the PR was no longer open.
 * @typedef {object} AutoMergeResult
 * @property {'enabled'|'already'|'merged_now'|'merged'|'closed'|'moved'} status  moved: the PR head is no longer the approved sha — nothing written
 * @property {boolean} readied  the PR was a draft and was marked ready for review first
 * @property {string} [headSha]  moved only: the PR's current head
 */

/** One merged agent PR as `listMergedAgentPrs` reports it.
 * @typedef {object} MergedAgentPr
 * @property {number} pr
 * @property {string} ref        the task ref (branch minus the profile's branchPrefix, default `agent/`)
 * @property {string} mergedAt   ISO timestamp
 * @property {boolean} [boardCloses]  the board closes the ticket itself (see `Job.boardCloses`); absent when not
 */

/** One open agent PR as `listAgentPrs` reports it.
 * @typedef {object} AgentPr
 * @property {number} number
 * @property {string} ref        the task ref (branch minus the profile's branchPrefix, default `agent/`)
 * @property {string} title
 * @property {string} url
 * @property {boolean} draft
 * @property {boolean|null} mergeable    null = GitHub has not computed it yet
 * @property {string|null} mergeState    GitHub's mergeable_state (clean|dirty|blocked|behind|unstable|…)
 * @property {'success'|'failure'|'pending'|'none'|'unknown'} ci   unknown = the check-runs call failed (not the same as none)
 * @property {string} updatedAt
 * @property {boolean} [autoMerge]  true when GitHub auto-merge is enabled on the PR; absent otherwise
 * @property {Record<string, unknown>} [review]  set by ops (not the forge): the newest review-kind step's stored summary + its `outcome`/`at` (agent-authored — untrusted); absent when none is stored
 * @property {boolean} [mine]   set by ops (not the forge): true/false from a 5-min-cached `adapter.ownership` lookup, absent when scoping is off, the adapter has no `ownership`, or the lookup failed
 */
/** A factory `(cfg, store) => Forge`.
 * @typedef {(cfg: Config, store: Store) => Forge} ForgeFactory */

export {};
