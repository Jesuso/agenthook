/** @typedef {import('./sandbox.js').EgressConfig} EgressConfig */

/**
 * The normalized unit of work the engine passes around. Adapters produce these
 * from raw webhook payloads; nothing past processEvents sees platform specifics.
 * @typedef {object} Job
 * @property {'pipeline'|'merge'|'ci'|'ci_green'|'epic_changed'|'board_done'|'pr_push'} kind  pr_push: the forge saw a new commit on an agent PR with auto-merge on — signal only, handled by `createPrPushGuard` (src/auto-merge.js) outside the queue; pipeline: a step fired by a task entering its source section; merge: the forge saw the task's `agent/<ref>` PR merge (no agent — dispatch completes the task); ci: the forge saw a red CI run on that branch (no agent — dispatch re-runs it once, then bounces; ci_green: a green run — a candidate for the `ci_green` event, handled by `src/ci-green.js` outside the queue; epic_changed: the tracker saw an epic's structure change — signal only, `ref` = the epic, handled by `src/epic-changed.js` outside the queue; board_done: the tracker saw the board's own done flag flip on a ticket of ours — signal only, handled by `src/board-done.js` outside the queue)
 * @property {string} ref       provider-native item id (Asana gid, …)
 * @property {string} stepId    which Step in cfg.pipeline to run (merge: the `completeOnMerge` step, or ""; ci: "")
 * @property {string} dedupKey  unique per source event; one key → at most one run
 * @property {string} [comment] the owner's `trigger`-prefixed reply that resumed a held step (appended to the prompt)
 * @property {CiRun} [ci]       ci jobs only: the red run
 * @property {{prNumber: number, headSha: string}} [push]  pr_push jobs only: the PR and its new head
 * @property {boolean} [boardCloses]  merge jobs only: the board closes this ticket itself on merge; dispatch doesn't bridge
 * @property {string} [queuedAt]  persisted queue entries only: ISO timestamp of the first enqueue (stamped by `store.addQueued`, kept across a re-add/restart)
 * @property {string} [harness]   pipeline jobs of a step with `harness`: the harness the queue picked when the job started (never trusted from disk — re-routed at start)
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
 * One element of a step's `harness` list (the object form): a harness name plus per-entry
 * `model`/`effort` pins that apply only to runs routed to that harness — they beat the step's
 * own `model`/`effort`, the harness's, `escalate` and `lite` for that harness alone.
 * @typedef {object} HarnessEntry
 * @property {string} name    the harness name (a key of `harnesses`)
 * @property {string} [model] model for runs routed to this harness only
 * @property {string} [effort] effort for runs routed to this harness only
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
 * @property {string|(string|HarnessEntry)[]} [harness]  name(s) from the profile's `harnesses` this step's runs use; the queue picks one with a free slot when a job starts. An element may instead be `{name, model?, effort?}`, whose `model`/`effort` pin only runs routed to that harness — they win over the step's, the harness's, `escalate` and `lite` for that harness alone. Otherwise the step's own agent/model/bin/provider/toolsets/opencodeConfig win over the harness's; `env` merges (step keys win)
 * @property {'first-free'|'round-robin'} [routing]  how a `harness` list is picked: first-free (default) = the first listed harness with room; round-robin = rotate, skipping full ones. Needs a list
 * @property {boolean} [energy]               opt-in: measure this step's runs with the profile's `energy` source (kWh + USD on usage.jsonl / run_end, src/shared/energy.js); needs a profile `energy` block
 * @property {boolean} [isolated]             hermes: run in the profile's own HERMES_HOME (`<stateDir>/hermes-home`, only `config.yaml` copied) with `--ignore-rules --source tool` (default true); false = the user's real Hermes home. Other agents ignore it
 * @property {Record<string, string>} [env]   extra environment for this step's agent only, merged over the agent's filtered env (see agentEnvPassthrough; AGENTHOOK_VERDICT_FILE is reserved)
 * @property {boolean} [sandbox]              false = run this step on the host even when the profile has a `sandbox` (the operator's explicit escape hatch)
 * @property {string} [opencodeConfig]        opencode only, sandbox only: host path to an OpenCode JSON config, copied into the per-run sandbox HOME at `.config/opencode/opencode.json`; a leading `~/` resolves against the home dir, a relative path against the config dir. Unset on a host run (opencode reads the operator's own `~/.config/opencode`)
 * @property {string} [piConfigDir]           pi only, sandbox only: host dir holding pi's `models.json` and/or `settings.json` (each optional), copied into the per-run sandbox HOME at `.pi/agent/`; a leading `~/` resolves against the home dir, a relative path against the config dir. Unset on a host run (pi reads the operator's own `~/.pi`)
 * @property {StepPolicy} [allow]           the only commands this step's agent may run and the only cwd-relative paths it may write (reads inside cwd stay allowed); enforced through the agent CLI (claude only — other agents' runs are refused)
 * @property {StepPolicy} [deny]            commands this step's agent may never run and cwd-relative paths it may never read or write; enforced even under fullAuto (claude only)
 * @property {EgressConfig} [egress]          this step's network policy: `mode` overrides the profile's `sandbox.egress.mode`; `allow`/`deny` are added to the profile's. Needs a profile `sandbox`
 * @property {string[]} [services]           names from the profile's `sandbox.services` this step's sandboxed runs get, fresh per run (at most 8). Needs a sandboxed step
 * @property {number} [maxAttempts]            cap on how many times this step may run for one ref before a `changes` loop into it is forced to fail (default 3)
 * @property {number} [maxConcurrent]          max runs of this step at once, counted INSIDE the global `maxConcurrent` (default: bounded only by the global cap)
 * @property {number} [maxMinutes]             wall-clock cap on one run of this step; past it the agent is killed and the run fails with `timeout` (default 120, 0 = no cap)
 * @property {number} [contextTokens]          the model's context window (tokens), for the running record's `ctxMax` (#658); wins over the harness's; unset falls back to src/models.js's built-in table (and, for opencode, its opencodeConfig's `limit.context`)
 * @property {number} [idleMinutes]            opt-in: kill the agent (fail with `timeout`) after this many minutes with no stream-json output (default off)
 * @property {boolean} [requireVerdict]        a clean exit with a missing/unparseable/unrecognized verdict holds (reason "no valid verdict") instead of advancing (default true); set false to opt out and advance on a clean exit as before
 * @property {number} [verdictRepairs]         how many receiver-driven repair turns (#677) a clean exit with no valid verdict gets — each resumes the same agent session with a fixed prompt — before the hold above fires (default 1, 0 disables); needs the agent's `resumeArgs` and a captured session id
 * @property {boolean} [deduceVerdict]         (#680) a clean exit with no valid verdict, on an `implement`/`change` step whose worktree branch gained commits, advances with a deduced verdict instead of running a repair turn (default true); false opts out, falling through to `verdictRepairs` then the hold
 * @property {string|string[]} [gate]          (#710) a command the receiver runs, in the run's own executor, after an `advance` (agent-written, repaired or deduced) and before the move: a non-empty string runs as `["sh", "-c", gate]`, an array runs verbatim as argv. A non-zero exit or timeout vetoes the advance — one more agent turn gets the gate's output and a chance to fix it (up to the step's `maxAttempts`), then a hold. Never runs on `hold`/`fail`/`changes`/missing-verdict. Not allowed on a manual step
 * @property {number} [gateTimeoutMinutes]     wall-clock cap on one `gate` run; past it the gate is killed and counted as a veto (default 10)
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
 * @property {string[]} [followUp]  advance only: checks to verify once the change is live (src/followup.js); an allowed `summary.tier` approves and records them, any other tier holds
 */

export {};
