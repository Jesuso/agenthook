// Shared type surface for the engine and adapters. JSDoc-only — no runtime code,
// so it stays zero-build (checked by `tsc --noEmit`, never compiled). Reference a
// type from anywhere with `import('./types.js').Adapter`.
//
// The Adapter interface below IS the provider contract. Adding a tracker = writing
// one object that satisfies it (see src/providers/asana.js for the reference impl).

/**
 * The normalized unit of work the engine passes around. Adapters produce these
 * from raw webhook payloads; nothing past processEvents sees platform specifics.
 * @typedef {object} Job
 * @property {'pipeline'|'merge'|'ci'|'ci_green'|'epic_changed'} kind  pipeline: a step fired by a task entering its source section; merge: the forge saw the task's `agent/<ref>` PR merge (no agent — dispatch completes the task); ci: the forge saw a red CI run on that branch (no agent — dispatch re-runs it once, then bounces; ci_green: a green run — a candidate for the `ci_green` event, handled by `src/ci-green.js` outside the queue; epic_changed: the tracker saw an epic's structure change — signal only, `ref` = the epic, handled by `src/epic-changed.js` outside the queue)
 * @property {string} ref       provider-native item id (Asana gid, …)
 * @property {string} stepId    which Step in cfg.pipeline to run (merge: the `completeOnMerge` step, or ""; ci: "")
 * @property {string} dedupKey  unique per source event; one key → at most one run
 * @property {string} [comment] the owner's `trigger`-prefixed reply that resumed a held step (appended to the prompt)
 * @property {CiRun} [ci]       ci jobs only: the red run
 */

/** A red CI run on a ref's agent branch (the `ci` job payload). Receiver-trusted
 * fields only — no workflow/job names or log text (the PR head controls those).
 * @typedef {object} CiRun
 * @property {number} runId
 * @property {number} attempt       the run's `run_attempt` (1 = first run, 2 = our re-run, …)
 * @property {string} headSha       commit the run tested; a newer PR head makes the run stale
 * @property {number|null} prNumber the PR the run belongs to, when the forge names one
 * @property {string} url           the run's web URL
 */

/**
 * A step's `allow` or `deny` policy. Advisory without the sandbox: an allowed interpreter runs
 * anything, and path rules cover the agent's file tools, not a subprocess that opens files itself.
 * @typedef {object} StepPolicy
 * @property {string[]} [commands]  command prefixes, word-boundary matched (`"npm test"` covers `npm test -- foo`)
 * @property {string[]} [paths]     gitignore-style globs relative to the run's cwd (the worktree, or the main checkout on a no-worktree step)
 */

/**
 * One stage of a pipeline (cfg.pipeline[]). The platform-neutral fields are read by
 * the engine; the tracker adapter reads its own binding (e.g. Asana section gids)
 * off the same object. A step with `manual: true` has no agent — entering it only
 * triggers system actions (e.g. drainWorktree), driven by a human moving the task.
 * @typedef {object} Step
 * @property {string} id                       stable id; keys per-step dedup + running state
 * @property {'implement'|'change'|'review'|'triage'} [kind]  prompt shape (default 'implement')
 * @property {string} [instructionsFile]       standing instructions for this step (abs after loadConfig); defaults to cfg.instructionsFile
 * @property {boolean} [createsWorktree]       system creates the shared worktree before the agent runs
 * @property {boolean} [drainWorktree]         system removes the worktree after the step
 * @property {boolean} [manual]                no agent; entering the step only runs system actions
 * @property {boolean} [completeOnMerge]       manual steps only, at most one: a forge merge event moves the task INTO this step (then marks it completed)
 * @property {string} [model]                  per-step `claude --model` override
 * @property {'low'|'medium'|'high'|'xhigh'|'max'} [effort]  per-step reasoning-effort override (claude `--effort`, hermes `--reasoning`, opencode `--variant`; cursor ignores it)
 * @property {string} [agent]                  agent adapter this step spawns (src/agents/; default cfg.agent, else "claude")
 * @property {string} [bin]                    executable for this step's agent: a name on PATH or an absolute path (default the adapter's `defaults.bin`, else cfg.claudeBin)
 * @property {string} [provider]                inference provider for this step's agent (hermes `--provider`); other agents ignore it. Default cfg.agentProvider
 * @property {string[]} [toolsets]            hermes `-t`: the toolsets this step's agent may use (default ["terminal","file"] when isolated); other agents ignore it
 * @property {boolean} [energy]               opt-in: measure this step's runs with the profile's `energy` source (kWh + USD on usage.jsonl / run_end, src/energy.js); needs a profile `energy` block
 * @property {boolean} [isolated]             hermes: run in the profile's own HERMES_HOME (`<stateDir>/hermes-home`, only `config.yaml` copied) with `--ignore-rules --source tool` (default true); false = the user's real Hermes home. Other agents ignore it
 * @property {Record<string, string>} [env]   extra environment for this step's agent only, merged over the agent's filtered env (see agentEnvPassthrough; AGENTHOOK_VERDICT_FILE is reserved)
 * @property {boolean} [sandbox]              false = run this step on the host even when the profile has a `sandbox` (the operator's explicit escape hatch)
 * @property {StepPolicy} [allow]           the only commands this step's agent may run and the only cwd-relative paths it may write (reads inside cwd stay allowed); enforced through the agent CLI (claude only — other agents' runs are refused)
 * @property {StepPolicy} [deny]            commands this step's agent may never run and cwd-relative paths it may never read or write; enforced even under fullAuto (claude only)
 * @property {EgressConfig} [egress]          this step's network policy: `mode` overrides the profile's `sandbox.egress.mode`; `allow`/`deny` are added to the profile's. Needs a profile `sandbox`
 * @property {number} [maxAttempts]            cap on how many times this step may run for one ref before a `changes` loop into it is forced to fail (default 3)
 * @property {number} [maxConcurrent]          max runs of this step at once, counted INSIDE the global `maxConcurrent` (default: bounded only by the global cap)
 * @property {number} [maxMinutes]             wall-clock cap on one run of this step; past it the agent is killed and the run fails with `timeout` (default 120, 0 = no cap)
 * @property {number} [idleMinutes]            opt-in: kill the agent (fail with `timeout`) after this many minutes with no stream-json output (default off)
 * @property {boolean} [requireVerdict]        a clean exit with a missing/unparseable/unrecognized verdict holds (reason "no valid verdict") instead of advancing (default true); set false to opt out and advance on a clean exit as before
 * @property {Record<string, {model?: string, effort?: string}>} [escalate]  difficulty-gated overrides: key = 'easy'|'medium'|'hard', value = {model?,effort?} to substitute when the stored difficulty matches
 * @property {{descriptionHeadings: string[], model?: string, effort?: 'low'|'medium'|'high'|'xhigh'|'max'}} [lite]  description-gated override (intended for triage): when every heading starts a line of the task description, use this model/effort as the base; `escalate` still wins on top
 * @property {string} [sourceSectionGid]       Asana: entering this section fires the step
 * @property {string} [successSectionGid]      Asana: move here on a clean finish (advance)
 * @property {string} [failureSectionGid]      Asana: move here on a failed/interrupted run
 * @property {string} [holdSectionGid]         Asana: move here on `hold` (waiting on a human); absent → leave in place
 * @property {string} [queueSectionGid]        Asana: opt-in queue stage (backlog section) this step pulls from, in section order, when a slot frees
 * @property {string} [sourceStatus]           Jira / github-projects / local / Linear: entering this status (Linear: team workflow state) fires the step (status name)
 * @property {string} [successStatus]          Jira / github-projects / local / Linear: move here on a clean finish (advance)
 * @property {string} [failureStatus]          Jira / github-projects / local / Linear: move here on a failed/interrupted run
 * @property {string} [holdStatus]             Jira / github-projects / local / Linear: move here on `hold`; absent → leave in place
 * @property {string} [queueStatus]            Jira / github-projects / local / Linear: opt-in queue stage (backlog status) this step pulls from, in board order, when a slot frees
 * @property {string} [sourceLabel]            GitHub: an issue carrying this label fires the step
 * @property {string} [successLabel]           GitHub: swap to this label on a clean finish (advance)
 * @property {string} [failureLabel]           GitHub: swap to this label on a failed/interrupted run
 * @property {string} [holdLabel]              GitHub: swap to this label on `hold`; absent → leave in place
 * @property {string} [queueLabel]             GitHub: opt-in queue stage (backlog label) this step pulls from, oldest-created first, when a slot frees
 * @property {boolean} [closeIssue]            GitHub: entering this (terminal) step CLOSES the issue — auto-releasing the dependents it was blocking
 * @property {boolean} [completeTask]          Asana: entering this (terminal) step marks the task COMPLETED — auto-releasing the dependents it was blocking
 */

/**
 * The verdict outcome a finished step resolves to; the adapter maps it to a transition:
 *   advance → successSectionGid · fail → failureSectionGid · hold → holdSectionGid
 *   changes → the target step's sourceSectionGid (re-fires that step — the rework loop)
 * @typedef {'advance'|'fail'|'hold'|'changes'} StepOutcome
 */

/**
 * A finished step's structured verdict. The agent writes {outcome, target?, reason?}
 * to AGENTHOOK_VERDICT_FILE; the dispatcher reads it post-exit (a non-zero exit always
 * overrides to fail), resolves a `changes` target to a concrete stepId, then hands this
 * to adapter.advance. `reason` is logged; `target` (changes only) names the step to
 * bounce back to (defaults to the previous step in pipeline order).
 * @typedef {object} Verdict
 * @property {StepOutcome} outcome
 * @property {string} [target]     changes: the stepId to route back to (resolved to a concrete id by dispatch)
 * @property {string} [reason]     human-readable; logged, not posted
 * @property {string} [findings]   changes: full Markdown review findings, handed verbatim to the target step's next prompt (falls back to `reason`)
 * @property {'easy'|'medium'|'hard'} [difficulty]  optional ticket difficulty emitted by triage; persisted per-ref to gate model/effort on subsequent steps
 * @property {string[]} [paths]    overlapGuard: repo-relative files (dir = trailing `/`) — predicted by a no-worktree step, touched by a worktree step (sanitised, ≤200)
 * @property {Record<string, unknown>} [summary]  optional free-form supervisor summary (plain object, ≤300 chars serialised); stored as-is per (ref, step), shown on `runs`/`prs`, never interpreted or fed back into a prompt
 */

/** One stored step summary (summaries.json, keyed ref → stepId).
 * @typedef {object} SummaryRecord
 * @property {Record<string, unknown>} summary  the verdict's `summary`, as written (agent-authored — untrusted)
 * @property {StepOutcome} outcome  the outcome actually applied (after the changes guard / CI bounce)
 * @property {string} run           the run log basename (matches a `runs` row's `run`)
 * @property {string} at            ISO time the run finished
 */

/** In-flight pipeline job recorded locally for crash recovery (store.running).
 * The `input`/`output` live-tally fields grow during a run (throttled writes) and
 * clear with the record on exit; live displays (`ah agents`) read them.
 * @typedef {object} RunningInfo
 * @property {string} stepId
 * @property {number} [pid]
 * @property {string} startedAt
 * @property {string} [worktree]
 * @property {number} [input]       live input-token tally so far (estimate; final in UsageRecord)
 * @property {number} [output]      live output-token tally so far (estimate; final in UsageRecord)
 * @property {number} [cacheRead]   live cache-read token tally (estimate; final in UsageRecord)
 * @property {number} [cacheCreate] live cache-creation token tally (estimate; final in UsageRecord)
 * @property {string|null} [model]   the model the run was launched with (null = CLI default)
 */

/** Durable per-ref display metadata (refmeta.json). Never cleared: `status`/`events`
 * read it after the run ends to show a human id, title and PR instead of the raw ref.
 * @typedef {object} RefMeta
 * @property {string} [displayId]  the tracker's human id (Asana custom field, "#94", Jira key)
 * @property {string} [title]      the task title
 * @property {number} [pr]         the PR number for the ref's branch, once one exists
 * @property {'merged'|'closed'} [prState]  that PR's terminal state once learned (the `prs` op's `forge.prState` lookup, or a merge job); unset while open/unknown, dropped when a new agent run starts or the PR shows open again
 * @property {string} [url]        the item's tracker web URL (Task.url)
 * @property {string} [summary]    the first prose paragraph of the description, plain and clipped (src/ticket-summary.js); what `ah ui` shows as "what is this about"
 * @property {{ref: string, name: string, url?: string}} [epic]  the ticket's epic, written by dispatch from Task.epic; null drops a stale value when the ticket leaves its epic
 */

/** A `setRefMeta` patch: `undefined` skips a key, `null` deletes it.
 * @typedef {{ [K in keyof RefMeta]?: RefMeta[K] | null }} RefMetaPatch
 */

/** A ref parked by a `hold` verdict (store.held) — the step an owner's `@agent` reply resumes.
 * @typedef {object} HeldInfo
 * @property {string} stepId
 * @property {string} [reason]   the agent's hold reason (its question, in short)
 * @property {string} heldAt     ISO timestamp the hold verdict landed
 */

/** Paths an in-flight ref holds under the file-overlap guard (store.locks). Only grows
 * (predicted paths at gate time, then the union of every worktree step's verdict paths).
 * @typedef {object} LockInfo
 * @property {string[]} paths   repo-relative files; a trailing `/` marks a directory
 * @property {string} stepId    the step that last wrote the lock
 */

/** A ref resting in its source stage behind another ref's lock (store.overlap).
 * @typedef {object} OverlapInfo
 * @property {string} stepId     the gated step, re-fired on release
 * @property {string} blockedBy  the ref whose lock overlaps this ref's predicted paths
 * @property {string} heldAt     ISO timestamp the gate held it
 */

/** A finished run's token/cost record, appended to usage.jsonl (one per line). Totals
 * come from `claude -p`'s stream-json `result` event (`usage` + `total_cost_usd`).
 * @typedef {object} UsageRecord
 * @property {string} ref
 * @property {string} stepId
 * @property {string} [model]      model that ran (step `--model`, else the `modelUsage` key)
 * @property {string} [bin]        the step's agent binary, only when it differs from `claudeBin`
 * @property {string} startedAt    ISO timestamp the run was spawned
 * @property {string} endedAt      ISO timestamp the run exited
 * @property {number} [durationMs] `result.duration_ms` if present
 * @property {number} input        usage.input_tokens
 * @property {number} output       usage.output_tokens
 * @property {number} cacheRead    usage.cache_read_input_tokens
 * @property {number} cacheCreate  usage.cache_creation_input_tokens
 * @property {number} [costUsd]    result.total_cost_usd (kept raw even when `unpriced` — readers ignore it then)
 * @property {string} [sessionId]  result.session_id
 * @property {true} [unpriced]     local model (step `bin` or a non-Claude model): `costUsd` is not real spend
 * @property {number} [estUsd]     rate-table estimate (src/pricing.js `costOf`), stamped at write time; absent on a reported run or with no rate/tokens
 * @property {'reported'|'rate-table'} [costBasis]  which figure stands for this run: `costUsd` (reported) or `estUsd` (rate-table)
 * @property {number} [energyKwh]   measured energy of an `energy: true` step's run (src/energy.js; 1e-9 kWh), its share of machine power; absent when unmeasured
 * @property {number} [energyUsd]   energyKwh × the profile's `energy.usdPerKwh` (1e-6 $) — a third figure, never in costUsd/estUsd
 * @property {'hwmon'|'command'|'watts'} [energySource]  the `energy.source.type` that measured it
 */

/**
 * A tracker item resolved to platform-neutral fields.
 * @typedef {object} Task
 * @property {string} ref
 * @property {string} name
 * @property {string} [description]
 * @property {string} url
 * @property {boolean} completed
 * @property {boolean} assignedToUs
 * @property {string} [displayId]  the human-facing id operators use (Asana "ID-2738", GitHub "#94", Jira "CAHUI-7"); undefined when the tracker has none
 * @property {string[]} [routeKeys]  raw, opaque route keys the engine maps to a repo via cfg.repos[].match (src/repos.js); absent/[] = unrouted (→ the default repo)
 * @property {EpicRef} [epic]  the epic this ticket belongs to (its parent, when the parent is typed as an epic); undefined when it has none
 * @property {boolean} [isEpic]  true when this item IS an epic (its own custom type matches), not a ticket
 */

/**
 * A reference to the epic a ticket belongs to (Task.epic / RefMeta.epic).
 * @typedef {object} EpicRef
 * @property {string} ref
 * @property {string} name
 * @property {string} [url]
 * @property {string} [displayId]
 */

/**
 * An epic, as listed by Adapter.listEpics.
 * @typedef {object} Epic
 * @property {string} ref
 * @property {string} name
 * @property {string} url
 * @property {string} [displayId]
 * @property {string|null} status  tracker-reported status label (Asana: the custom type's status option name), shown as-is; null when unset
 * @property {boolean} completed
 */

/**
 * One of an epic's tickets, as listed by Adapter.listEpicTickets.
 * @typedef {object} EpicTicket
 * @property {string} ref
 * @property {string} [displayId]
 * @property {string} name
 * @property {boolean} completed
 * @property {string|null} stage  the tracker stage the ticket rests in (Asana: the section name of its membership in this project); "" when in this tracker's view but in no stage (backlog); null when outside this tracker's view (untracked)
 */

/**
 * A tracker's available stage, as picked for a pipeline step binding. `id` is written
 * verbatim into the binding key (Asana section gid, Jira/github-projects/local status
 * name, GitHub label name).
 * @typedef {object} StageOption
 * @property {string} id
 * @property {string} label
 */

/**
 * Names the Step binding-key family a tracker uses for source/success/failure/hold/queue,
 * e.g. asana's {source:"sourceSectionGid", …}. Each value is a key on Step.
 * @typedef {object} StageKeys
 * @property {string} source
 * @property {string} success
 * @property {string} failure
 * @property {string} hold
 * @property {string} queue
 */

/**
 * Platform words injected into the prompt builders (src/prompts.js).
 * @typedef {object} AdapterMeta
 * @property {string} platform      e.g. "Asana", "GitHub"
 * @property {string} taskNoun      e.g. "task", "issue"
 * @property {string} trigger       comment prefix that requests a change (default "@agent")
 * @property {string} commentHowTo  one line telling the agent how to comment back
 * @property {string} [readCommentsHowTo] one line telling the agent how to read the task's existing comments (where a human's answer to a held question lands); omitted when the tracker has no comment channel
 * @property {boolean} [usesPR]     does this tracker's workflow revolve around a pull request? Default true. When false (e.g. the local/offline tracker) the prompt builders drop all PR language: the worktree DIFF is the deliverable and review reads it with `git diff`, never `gh pr`
 * @property {StageKeys} [stageKeys]  the Step binding-key family this tracker uses (source/success/failure/hold/queue)
 * @property {boolean} [webhooks]    does this tracker register webhooks? Default true. false (e.g. local) means there's nothing to unregister
 * @property {string[]} [agentEnv]   receiver env vars the commentHowTo / readCommentsHowTo tell the agent to use (e.g. GITHUB_TOKEN); passed to agents through the env allowlist (src/agent-env.js)
 * @property {string[]} [egressHosts] egress rules (host, host:port) for the API the commentHowTo / readCommentsHowTo call; a sandboxed run's allowlist includes them. Omitted when the tracker has no comment channel
 * @property {string} [ownerHint]  who "the owner" is in the held-comments line (e.g. "@octocat"), for a tracker whose agents may post as another account (a GitHub App run token posts as `<app>[bot]`); omitted = "the account you are running as"
 */

/** Per-run credentials an adapter hands one agent run (#474; src/github-run-token.js).
 * @typedef {object} RunCredentials
 * @property {Record<string,string>} env    layered over the #470 allowlisted env, under the step's env
 * @property {string[]} strip               allowlisted names to remove for this run (e.g. GH_TOKEN, GITHUB_TOKEN)
 * @property {string} label                 one line for the run log, e.g. "GitHub App token: o/r (contents:write, pull_requests:write, issues:write), expires 14:05 UTC"; never the token
 * @property {() => Promise<void>} dispose  stop refreshing, revoke, delete the run dir; idempotent, never throws
 */

/** What dispatch passes `runCredentials`: the run's ref, step and task, the routed checkout,
 * the per-run dir the adapter may own (`<dataDir>/run-creds/<safeRef>-<stepId>`), and a run-log writer.
 * @typedef {{ref: string, step: Step, task: Task, repoPath: string, dir: string, log: (line: string) => void}} RunCredentialsInput
 */

/**
 * Per-request context handed to authenticate() and processEvents().
 * @typedef {object} EventCtx
 * @property {string} pathname
 * @property {import('node:http').IncomingHttpHeaders} headers
 * @property {string} rawBody
 */

/**
 * authenticate() verdict. Must be SYNC and do no network I/O so the engine can
 * ACK within the provider's retry window (<10s).
 * @typedef {{type:'handshake', headers: Record<string,string>}
 *         | {type:'reject'}
 *         | {type:'accept'}} AuthResult
 */

/**
 * A forged, signed event that replays a missed item through the live server.
 * @typedef {object} ForgedEvent
 * @property {string} path     receiver path to POST to (e.g. "/mytasks/")
 * @property {string} body     exact request body, signed below
 * @property {Record<string,string>} headers  signature + provider headers
 * @property {string} dedupKey must equal the dedupKey the real event would carry
 * @property {string} [stepId]  the step the item's live stage maps to, or undefined when it rests in NO source stage (the server would silently drop the replay — catchup pre-checks this)
 */

/**
 * The provider contract. One file in src/providers/ exports a factory returning
 * this; register it in src/providers/index.js. The engine talks ONLY through here.
 * @typedef {object} Adapter
 * @property {() => AdapterMeta} describe
 * @property {(ctx: EventCtx) => AuthResult} authenticate
 * @property {(ctx: EventCtx) => Promise<Job[]>} processEvents
 * @property {(emit: (jobs: Job[]) => void) => void} [onJobs]  optional; an in-process event source (local tracker: no webhooks). The engine calls it once at boot with a sink that feeds intake (settle-safe per ref); the adapter pushes the jobs its own stage moves cause. Absent on webhook trackers
 * @property {(t: {name: string, description?: string, stepId?: string}) => Promise<{ref: string, stage: string, stepId: string}>} [createTask]  optional, local only (`agenthook ticket add`); add one item to the board at the step's source stage (default the first non-manual step; a manual/unknown step throws) under the next numeric ref, then push its created-in-stage job through the onJobs sink when wired
 * @property {(ref: string) => Promise<Task>} fetchTask
 * @property {(ref: string, stepId: string, verdict: Verdict) => Promise<void>} advance  resolve a finished step's transition (move to the section its outcome maps to)
 * @property {(ref: string, stepId: string, opts?: {assign?: boolean}) => Promise<{stage: string}>} [enterStage]  optional; `agenthook run` uses it. Assign the item to us (unless opts.assign===false), then move it INTO the step's source stage (add source label / addTask to source section / transition to source status) — the live webhook then fires the step. Returns the source stage entered
 * @property {(ref: string) => Promise<string|null>} [currentStage]  optional; `agenthook run`'s guard uses it. The pipeline stage (label / section gid / status) the item currently rests in among ANY step's source/success/failure/hold stage, or null. Read-only — refuses re-injecting an item already mid-flow (one ref = one in-flight flow)
 * @property {() => Promise<Job[]>} listResting  tasks currently resting in step source sections, as jobs — drives the explicit `reconcile` command (NEVER called on boot)
 * @property {(stepId: string) => Promise<string[]>} [listQueued]  optional; refs resting in the step's opt-in QUEUE stage (queueSectionGid/queueStatus/queueLabel), board priority order (top first), filtered exactly like listResting (ours, fail-closed; open; GitHub: not blocked). [] when the step has no queue key. The engine calls it only when a slot frees (run_end) and once on boot — never on a timer. Not the same as store.listQueued (the local queue.json)
 * @property {(ref: string) => Promise<string[]>} [openBlockers]  optional; the item's unresolved blockers (empty = unblocked), re-checked at dispatch time so a dependency added while the job waited in the local queue still gates it. Same fail-open semantics as the receive-time gate (API error → [] + warn)
 * @property {(ref: string) => Promise<"ours"|"not_ours"|"check_failed">} [ownership]  optional; the same fail-closed owner check the mutation gate uses, exposed read-only for `prs`' `mine` flag (asana/github/jira only; absent on github-projects/local)
 * @property {(publicUrl: string) => Promise<void>} registerWebhook  an HTTP failure throws an Error carrying the numeric `status` (`Object.assign(new Error(msg), {status: res.status})`): boot retries a 5xx/429 (and network errors) indefinitely and a 404 three times (src/engine/boot-retry.js); any other status is fatal
 * @property {() => Promise<void>} unregisterWebhooks
 * @property {(ref: string) => Promise<void>} [complete]  optional; mark the item completed/closed on the tracker (Asana: completed:true). Used by a forge `merge` job; absent = no-op
 * @property {() => Promise<void>} [ensureLabels]  optional; create any pipeline objects the API won't auto-add to a task (GitHub: the issue labels). Called on boot before registerWebhook
 * @property {(ref: string, stepId?: string) => Promise<ForgedEvent>} [forgeCatchup]  optional; catchup needs it. dedupKey matches the server-assigned key; pass stepId to skip the live-section lookup
 * @property {(answers: Record<string, any>) => import('./wizard.js').WizardStep[]} [wizardSteps]  optional; `agenthook init` prompts
 * @property {(answers: Record<string, any>) => (Partial<Step>|null)} [pipelineBindings]  optional; `agenthook init` turns the wizard's live stage picks (the `_*Stage` answers) into the code step's tracker bindings (real source/success/failure), so no TODO_* editing is needed. Null ⇒ init keeps the placeholder skeleton
 * @property {() => Promise<StageOption[]>} [listStages]  optional; the tracker's available stages (Asana sections, Jira statuses, GitHub labels, Projects Status options) for the UI's stage pickers, read off the adapter's own configured board — no credentials leave the receiver
 * @property {(o: RunCredentialsInput) => Promise<RunCredentials|null>} [runCredentials]  optional; scoped credentials for one agent run (GitHub App: a per-run token). null = nothing to scope (the #470 env applies); a throw refuses the run (`fail`, no spawn). Dispatch asks the forge first
 * @property {() => Promise<Epic[]>} [listEpics]  optional; every epic in the tracker's configured scope. Absent = the tracker has no epics
 * @property {(epicRef: string) => Promise<EpicTicket[]>} [listEpicTickets]  optional; the epic's tickets (direct children in scope). Absent = the tracker has no epics
 */

/**
 * A provider factory: `(cfg, store) => Adapter`.
 * @typedef {(cfg: Config, store: Store) => Adapter} AdapterFactory
 */

/**
 * The active tracker's config block (the `tracker` object in agenthook.config.json).
 * Loose by design — each adapter reads its own fields. `${VAR}` refs in any value
 * are already resolved from the environment by loadConfig before adapters see it.
 * @typedef {object} ProviderConfig
 * @property {string} type               tracker adapter key (e.g. "asana")
 * @property {string} [token]            API token (typically a "${ASANA_TOKEN}" / "${JIRA_API_TOKEN}" ref)
 * @property {GithubAuthConfig} [auth]   github / github-projects: GitHub App auth instead of `token` (then assigneeLogin is required)
 * @property {string} [userGid]
 * @property {boolean} [assigneeFilter]  only act on items assigned to us (Asana userGid / Jira assigneeAccountId). Default true (fail-closed: unset id ⇒ refuse all); only false opts into project-wide
 * @property {string} [workspaceGid]
 * @property {string} [projectGid]  Asana: the project whose sections drive the pipeline
 * @property {string} [displayIdField]  Asana: name of the custom field holding the task's human id (default "ID", case-insensitive)
 * @property {string} [site]              Jira: site shortname ("<site>.atlassian.net"); or set baseUrl
 * @property {string} [baseUrl]           Jira: full base URL (overrides site)
 * @property {string} [email]             Jira: account email for Basic auth (typically a "${JIRA_EMAIL}" ref)
 * @property {string|false} [webhookSecret]  Jira/GitHub/Linear: explicit webhook signing secret; omit to let agenthook generate+store one; false disables verification
 * @property {string} [projectKey]        Jira: project key whose statuses drive the pipeline (e.g. "CAHUI")
 * @property {string} [assigneeAccountId] Jira: the bot's accountId — scope work to its issues
 * @property {string} [repository]         GitHub: "owner/name" whose issue labels drive the pipeline
 * @property {string} [owner]              GitHub: repo owner (alternative to repository)
 * @property {string} [repo]               GitHub: repo name (alternative to repository)
 * @property {string} [assigneeLogin]      GitHub / github-projects: the bot's login — scope work to its issues (else derived from /user or GraphQL viewer; required under App `auth`)
 * @property {string} [project]            github-projects: the Projects v2 board as "owner/number" or its URL, whose Status field drives the pipeline
 * @property {string} [team]  Linear: team key or URL whose workflow states drive the pipeline
 * @property {Step[]} [pipeline]  the ordered steps; a task entering a step's source section fires it
 * @property {string} [routeField]  name of the tracker field whose value(s) become Task.routeKeys (multi-repo routing; read by the adapter)
 * @property {string} [epicType]  Asana/GitHub/github-projects/Jira: the custom type name (Asana) / issue type name (GitHub, Projects v2, Jira) an epic is tagged with (Asana, GitHub, Projects v2 default "Epic"; Jira default = the project issue type at hierarchy level 1)
 * @property {string} [epicLabel]  GitHub/github-projects: the label name an epic is tagged with (default "epic"); either this OR epicType marks an epic
 */

/**
 * GitHub App auth (`tracker.auth` / `forge.auth`) — an installation token minted from the App's
 * private key replaces the personal token (src/github-auth.js, docs/github-app.md).
 * @typedef {object} GithubAuthConfig
 * @property {"app"} type
 * @property {string|number} appId          the App's id (App settings → General)
 * @property {string|number} installationId the installation on the repo/org (…/installations/<id>)
 * @property {string} [privateKey]          the App's PEM, typically "${GITHUB_APP_PRIVATE_KEY}" (literal `\n` → newline)
 * @property {string} [privateKeyPath]      or a PEM file, relative to the config file
 */

/**
 * The ingress config block (`ingress` in agenthook.config.json). `type` selects the
 * adapter; the rest are adapter-specific options (already env-interpolated).
 * @typedef {object} IngressConfig
 * @property {string} type           ingress adapter key ("ngrok" | "cloudflared" | "tailscale" | "manual" | "hosted")
 * @property {string} [url]          static public base URL (manual/hosted)
 * @property {string} [authtoken]    ngrok authtoken ("${NGROK_AUTHTOKEN}")
 * @property {string} [domain]       ngrok reserved domain (makes the URL stable)
 * @property {string} [webAddr]      ngrok local web-API address (default 127.0.0.1:4040)
 * @property {string} [tunnel]       cloudflared named tunnel name or UUID (blank = quick tunnel)
 * @property {string} [hostname]     cloudflared: public hostname routed to the named tunnel
 */

/** What an ingress adapter reports about itself.
 * @typedef {object} IngressMeta
 * @property {string} name        e.g. "ngrok", "manual"
 * @property {boolean} ephemeral  true when the public URL changes per restart
 */

/** An ingress adapter: brings up / tears down how the receiver is reachable.
 * @typedef {object} Ingress
 * @property {() => IngressMeta} describe
 * @property {(port: number) => Promise<{ url: string }>} up
 * @property {() => Promise<void>} down
 * @property {() => import('./wizard.js').WizardStep[]} [wizardSteps]
 * @property {(listener: (reason: string) => void) => void} [onExit] registers a listener an
 *   adapter calls at most once, only when its managed tunnel dies unexpectedly after `up()`
 *   resolved (never during `down()` or a startup failure)
 */

/** A factory `(cfg) => Ingress`. `timeoutMs` bounds a managed tunnel's startup (cloudflared) or each
 * CLI call (tailscale); `run` replaces tailscale's execFile. Both for tests.
 * @typedef {(cfg: Config, opts?: { timeoutMs?: number, run?: IngressRun }) => Ingress} IngressFactory */
/** Runs one CLI call; a non-zero exit resolves with its `code`, a spawn failure rejects.
 * @typedef {(bin: string, args: string[], opts: { timeoutMs: number }) => Promise<{ code: number|null, stdout: string, stderr: string }>} IngressRun */

/**
 * The optional sandbox config block (`sandbox` in agenthook.config.json): run each agent in its
 * own container with only its worktree mounted (src/sandbox/). Absent = runs on the host.
 * @typedef {object} SandboxConfig
 * @property {string} type      sandbox backend ("docker" | "podman")
 * @property {string} [image]   agent image (default `agenthook-agent:<package version>`)
 * @property {string} [memory]  container memory cap, e.g. "4g" (unset = runtime default)
 * @property {number} [cpus]    container CPU cap, e.g. 2 (unset = runtime default)
 * @property {EgressConfig} [egress]  the runs' network policy (default mode allowlist)
 */

/**
 * A sandboxed run's network policy (`sandbox.egress`, a step's `egress`; src/sandbox/egress.js).
 * @typedef {object} EgressConfig
 * @property {'allowlist'|'open'|'none'} [mode]  allowlist (default) = only the model API, forge, tracker, origin and `allow`; none = no network; open = unrestricted
 * @property {string[]} [allow]  extra rules (`host`, `*.domain`, `host:port`, `…!private`) or registry presets (`@npm`, `@pypi`, …)
 * @property {string[]} [deny]   rules or presets removed from the defaults (e.g. the tracker API)
 */

/** The egress a run's sandbox enforces: `rules` only matter for `allowlist`.
 * @typedef {object} SandboxEgress
 * @property {'allowlist'|'open'|'none'} mode
 * @property {string[]} rules
 */

/** One bind mount into a sandboxed run.
 * @typedef {object} SandboxMount
 * @property {string} path   absolute host path; mounted at the SAME path inside the container unless `dst` is set
 * @property {string} [dst]  absolute container path (only for a mount under the sandbox's `home`, e.g. a transcript dir)
 * @property {boolean} [ro]  read-only
 * @property {"file"|"dir"} [mask]  hide `path` instead of mounting it: a file behind /dev/null, a dir behind an empty tmpfs
 */

/** What a run's sandbox has to say once it exits (generic, so a sandbox feature needs no new plumbing).
 * @typedef {object} SandboxReport
 * @property {string[]} [notes]             lines dispatch appends to the run log as `[agenthook] <note>`
 * @property {Record<string, any>} [extra]  fields dispatch merges into the run's `run_end` event
 */

/** What `wrap()` returns for one run: dispatch spawns `bin args` (the runtime client) instead
 * of the agent, with `env` over the client's runtime env.
 * @typedef {object} SandboxRun
 * @property {string} bin
 * @property {string[]} args
 * @property {Record<string, string>} env   the container env; the client passes each var by name
 * @property {string} id                    container name
 * @property {() => Promise<void>} kill     force-stop the container (idempotent)
 * @property {() => Promise<SandboxReport>} done  post-exit cleanup (idempotent)
 */

/** A sandbox adapter: where one agent run executes.
 * @typedef {object} Sandbox
 * @property {() => {name: string, home: string}} describe  `home` = the container's HOME
 * @property {() => Promise<{ok: true} | {ok: false, reason: string}>} check  runtime reachable + image present
 * @property {(o: {runId: string, ref: string, stepId: string, bin: string, args: string[], env: Record<string, string>, cwd: string, mounts: SandboxMount[], step: Step, egress?: SandboxEgress}) => Promise<SandboxRun>} wrap  `egress` absent = open (the runtime's default network)
 * @property {() => Promise<string[]>} reap  force-remove every container labelled with this profile; returns their names
 */

/** A factory `(cfg) => Sandbox`; `run` replaces the CLI runner in tests.
 * @typedef {(cfg: Config, opts?: { run?: IngressRun }) => Sandbox} SandboxFactory */

/** A live stdout parser an agent adapter hands dispatch for one run. Pure, stateful:
 * push() chunks, flush() the tail at EOF, then read `result` / `sessionId`.
 * @typedef {object} AgentParser
 * @property {(chunk: string) => string} push   log text rendered from the completed lines
 * @property {() => string} flush               log text from a final unterminated line
 * @property {{input: number, output: number, cacheRead: number, cacheCreate: number}} tally  live token estimate
 * @property {any} result                       the agent's final result record (null until seen); passed to `usageRecord`
 * @property {string|undefined} sessionId       the run's session id, once known
 * @property {(chunk: string) => void} [pushStderr]  stderr reaches the parser only through this (e.g. hermes' session id)
 * @property {import('./quota.js').QuotaReading|null} [quota]  the latest subscription-quota reading (claude's `rate_limit_event`); other agents don't report one
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
 * @property {() => {name: string, stdout: string, promptFile?: boolean, policy?: {allow: boolean, deny: boolean}}} describe  `promptFile: true` = dispatch passes the prompt via a file, not argv; `policy` = which step policies (`allow`/`deny`) the CLI can enforce — a step setting one it can't is refused
 * @property {(o: {prompt: string, model?: string, effort?: string, provider?: string, fullAuto?: boolean, promptFile?: string, maxMs?: number, toolsets?: string[], isolated?: boolean, allow?: StepPolicy, deny?: StepPolicy, cwd?: string, verdictFile?: string}) => string[]} buildArgs  argv after the executable
 * @property {() => AgentParser} createParser
 * @property {(result: any, ctx: AgentUsageCtx) => UsageRecord} usageRecord  `result` may be null (no result seen): zero tokens, `unpriced` still resolved
 * @property {AgentSessions|null} sessions  null = no transcripts to follow/resume
 * @property {(sessionId: string) => string[]} [resumeCommand]  resume argv (after the binary) for an agent with `sessions: null` whose session ids come from usage.jsonl (opencode)
 * @property {(ctx: {cfg: Pick<Config, 'stateDir'|'dataDir'>, step: Step|undefined}) => Record<string, string>|undefined} [env]  extra environment for the agent (at spawn and `resume`), under the step's `env` (hermes: an isolated step's HERMES_HOME)
 * @property {(ctx: {cfg: Pick<Config, 'stateDir'|'dataDir'>, step: Step, provider?: string, sandboxed?: boolean, env?: Record<string, string>}) => string|undefined} [preflight]  run before spawn: a returned reason fails the run with no agent spawned (hermes: prepare the isolated home, refuse a provider it has no credentials for; claude: refuse a sandboxed run with no credential var in `env`, the spawn env)
 * @property {(env: Record<string, string>) => string[]} [egressHosts]  egress rules for the model API a run with this spawn env talks to (claude: api.anthropic.com, ANTHROPIC_BASE_URL's host, Bedrock/Vertex); a sandboxed run's allowlist includes them
 * @property {(ctx: {cfg: Config, step: Step, cwd: string, ownsCwd: boolean, home: string}) => {mounts: SandboxMount[], env?: Record<string, string>}} [sandbox]  what a sandboxed run of this agent needs beyond the worktree (claude: its one transcript dir, under the container `home`). `ownsCwd` = cwd is the run's own worktree; false = the operator's main checkout, so nothing keyed by it on the host may be mounted. An agent without it is refused when sandboxed
 * @property {(ctx: {sessionId: string, bin: string, env: Record<string, string>, dir: string, timeoutMs: number}) => Promise<{input?: number, output?: number, cacheRead?: number, cacheCreate?: number, model?: string}|null>} [finalize]  best-effort, post-exit, bounded token capture (hermes: `sessions export`); may throw or return null — dispatch never lets it affect the verdict
 * @property {{requireVerdict?: boolean, bin?: string}} defaults  step `requireVerdict` / `bin` win over these
 * @property {string[]} [envPassthrough]  receiver env vars (NAME or PREFIX*) this CLI needs, added to the agent env allowlist (src/agent-env.js): auth keys, config vars
 */

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
 * @property {() => Promise<AgentPr[]>} [listAgentPrs]  open PRs on receiver-made `agent/<ref>` branches of this repo, with CI + mergeability (read-only; the MCP `prs` tool)
 * @property {(prNumber: number, sha: string) => Promise<{mergeable: boolean|null, mergeState: string|null, ci: AgentPr['ci']}>} [ciStatus]  CI roll-up for one PR head + its mergeability (backs `ci_green`)
 * @property {(runId: number) => Promise<void>} [rerunFailedJobs]  re-run only the failed jobs of a run
 * @property {(runId: number, attempt: number) => Promise<string>} [failedLogTail]  tail of the failed jobs' logs (UNTRUSTED text); best-effort, "" on error
 * @property {(prNumber: number, body: string, log?: string) => Promise<void>} [prComment]  post `body` (trusted) + `log` (untrusted, fenced inert) on the PR
 * @property {(answers: Record<string, any>) => import('./wizard.js').WizardStep[]} [wizardSteps]  optional; `agenthook init` prompts
 * @property {(o: RunCredentialsInput) => Promise<RunCredentials|null>} [runCredentials]  optional; same contract as Adapter.runCredentials. Dispatch asks the forge first, then the tracker when this returns null
 */

/** One open agent PR as `listAgentPrs` reports it.
 * @typedef {object} AgentPr
 * @property {number} number
 * @property {string} ref        the task ref (branch minus `agent/`)
 * @property {string} title
 * @property {string} url
 * @property {boolean} draft
 * @property {boolean|null} mergeable    null = GitHub has not computed it yet
 * @property {string|null} mergeState    GitHub's mergeable_state (clean|dirty|blocked|behind|unstable|…)
 * @property {'success'|'failure'|'pending'|'none'|'unknown'} ci   unknown = the check-runs call failed (not the same as none)
 * @property {string} updatedAt
 * @property {Record<string, unknown>} [review]  set by ops (not the forge): the newest review-kind step's stored summary + its `outcome`/`at` (agent-authored — untrusted); absent when none is stored
 * @property {boolean} [mine]   set by ops (not the forge): true/false from a 5-min-cached `adapter.ownership` lookup, absent when scoping is off, the adapter has no `ownership`, or the lookup failed
 */

/** A factory `(cfg, store) => Forge`.
 * @typedef {(cfg: Config, store: Store) => Forge} ForgeFactory */

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
 * @property {{ color?: string, emoji?: string }} [ui]  optional profile identity for the web UI (src/identity.js); unset values derive from the state key
 * @property {{ soul: string, access?: 'snapshot', model?: string, maxBudgetUsd?: number }} digest  the on-demand Digest (src/digest.js); `soul` is resolved beside the config
 * @property {Record<string, { input: number, output: number, cacheRead?: number, cacheWrite?: number }>} [pricing]  API-equivalent $/Mtok per model name or glob (src/pricing.js); checked before the built-in Claude rates
 * @property {{ usdPerKwh: number, source: { type: 'hwmon'|'command'|'watts', name?: string, cmd?: string, watts?: number } }} [energy]  local energy basis (src/energy.js): the power source an `energy: true` step's runs are measured with, and the electricity price
 * @property {{ pauseAboveSevenDay?: number, pauseAboveFiveHour?: number }} [quota]  opt-in Claude quota pacer (src/quota.js): pause admission at/above a window's utilization (0–1], resume at its reset
 * @property {number} port
 * @property {string} trigger
 * @property {number} maxConcurrent
 * @property {boolean} [overlapGuard]  opt-in (default false); hold a createsWorktree step while its predicted paths overlap another in-flight ref's lock
 * @property {boolean} [fullAuto]   opt-in; adds the agent CLI's skip-permissions flag (code exec from a webhook, on the host unless `sandbox` is set). Default false = headless agents can't prompt: privileged tool calls are denied unless an allow rule (repo `.claude/settings.json` or a step `allow` policy) permits them (claude runs are pinned to dontAsk).
 * @property {string} repoPath     the default repo's path (else the first declared) — ops readers use it; dispatch goes through `repos`
 * @property {RepoConfig[]} repos    always populated: the declared `repos`, or one synthesized `default` repo from repoPath
 * @property {boolean} multiRepo     true iff the profile declared a `repos` block (worktrees nest under `<base>/<repo.id>/`)
 * @property {string} [agent]      profile-default agent adapter (src/agents/; default "claude"); a step's `agent` overrides it
 * @property {string[]} [agentEnvPassthrough]  extra receiver env var names (or PREFIX*) passed to agents; "*" = all. Default: only the allowlist (src/agent-env.js)
 * @property {boolean} [githubRunToken]  default true; only acts under GitHub App auth (tracker or forge). false = agents get the #470 env (your own GITHUB_TOKEN / gh auth)
 * @property {string} [agentProvider]  profile-default inference provider for a step's agent (hermes `--provider`); a step's `provider` overrides it
 * @property {string} claudeBin
 * @property {string} [worktreePrefix]
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
 * The JSON-file store (src/store.js).
 * @typedef {object} Store
 * @property {(key: string) => string|undefined} getSecret
 * @property {(key: string, value: string) => void} setSecret
 * @property {() => number} secretCount
 * @property {() => void} reloadSeen
 * @property {(key: string) => boolean} hasSeen
 * @property {(key: string) => void} markSeen
 * @property {(key: string) => void} unmarkSeen
 * @property {() => number} seenCount
 * @property {string} seenFile
 * @property {(ref: string, info: RunningInfo) => void} setRunning
 * @property {(ref: string) => void} clearRunning
 * @property {() => Record<string, RunningInfo>} listRunning
 * @property {(job: Job) => void} addQueued
 * @property {(job: Job) => void} removeQueued
 * @property {() => Job[]} listQueued
 * @property {(ref: string, stepId: string) => number} getAttempt   how many times stepId has run for ref (0 if never)
 * @property {(ref: string, stepId: string) => number} bumpAttempt  increment and return the new count
 * @property {(ref: string) => void} clearAttempts                  drop all attempt counters for ref (it left the loop)
 * @property {(ref: string) => 'easy'|'medium'|'hard'|undefined} getDifficulty  stored difficulty for ref (undefined = unknown)
 * @property {(ref: string, difficulty: 'easy'|'medium'|'hard') => void} setDifficulty  persist difficulty from triage verdict
 * @property {(ref: string) => void} clearDifficulty                drop stored difficulty for ref
 * @property {(ref: string) => string|undefined} getRepo          the repo id ref is stuck to (multi-repo sticky routing; undefined = not routed yet)
 * @property {(ref: string, repoId: string) => void} setRepo        persist ref's routed repo id
 * @property {(ref: string) => void} clearRepo                      drop ref's sticky repo (terminal state)
 * @property {(ref: string) => HeldInfo|undefined} getHeld          the step ref is parked on by a `hold` verdict (undefined = not held)
 * @property {(ref: string, info: HeldInfo) => void} setHeld        record a `hold` verdict for ref
 * @property {(ref: string) => void} clearHeld                      drop the held record for ref (resumed / re-entered / terminal)
 * @property {(ref: string) => {target: string, fromStep: string, text: string}|undefined} getFindings  review findings pending for ref's rework step
 * @property {(ref: string, f: {target: string, fromStep: string, text: string}) => void} setFindings  persist findings on a `changes` bounce (latest wins)
 * @property {(ref: string) => void} clearFindings                  drop pending findings for ref
 * @property {(ref: string, b: {target: string, text: string}) => void} setCiRed  park a red-CI bounce for ref while a step runs on it (latest wins)
 * @property {(ref: string) => {target: string, text: string}|undefined} takeCiRed  read AND clear ref's parked red-CI bounce
 * @property {(ref: string) => Record<string, SummaryRecord>|undefined} getSummaries  ref's stored step summaries, keyed by stepId
 * @property {(ref: string, stepId: string, rec: SummaryRecord) => void} setSummary  store (replace) one step's summary; caps the file at 500 refs
 * @property {(ref: string, stepId: string) => void} clearSummary   drop one step's summary (a re-run that wrote none)
 * @property {(ref: string) => void} clearSummaries                 drop all of ref's summaries (terminal fail/cancel, merge)
 * @property {(rec: UsageRecord) => void} recordUsage               append one per-run token/cost record to usage.jsonl
 * @property {() => UsageRecord[]} readUsage                        parsed usage records (tolerates a trailing/garbage line)
 * @property {(ref: string) => string[]|undefined} getPredictedPaths  overlapGuard: paths a no-worktree step predicted for ref
 * @property {(ref: string, paths: string[]) => void} setPredictedPaths
 * @property {(ref: string) => void} clearPredictedPaths
 * @property {(ref: string) => LockInfo|undefined} getLock          overlapGuard: the paths ref holds while in flight
 * @property {(ref: string, lock: LockInfo) => void} setLock
 * @property {(ref: string) => void} clearLock
 * @property {() => Record<string, LockInfo>} listLocks
 * @property {(ref: string) => OverlapInfo|undefined} getOverlap    overlapGuard: the lock ref is waiting behind (undefined = not waiting)
 * @property {(ref: string, info: OverlapInfo) => void} setOverlap
 * @property {(ref: string) => void} clearOverlap
 * @property {() => Record<string, OverlapInfo>} listOverlap
 * @property {(ref: string) => RefMeta|undefined} getRefMeta        display metadata for ref (undefined = none recorded)
 * @property {(ref: string, patch: RefMetaPatch) => void} setRefMeta  shallow-merge patch into ref's record (undefined skipped, null deletes)
 * @property {() => Record<string, RefMeta>} listRefMeta            every ref's display metadata
 */

export {};
