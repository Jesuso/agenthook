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
 * @property {'pipeline'} kind  a step fired by a task entering its source section
 * @property {string} ref       provider-native item id (Asana gid, …)
 * @property {string} stepId    which Step in cfg.pipeline to run
 * @property {string} dedupKey  unique per source event; one key → at most one run
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
 * @property {string} [model]                  per-step `claude --model` override
 * @property {number} [maxAttempts]            cap on how many times this step may run for one ref before a `changes` loop into it is forced to fail (default 3)
 * @property {string} [sourceSectionGid]       Asana: entering this section fires the step
 * @property {string} [successSectionGid]      Asana: move here on a clean finish (advance)
 * @property {string} [failureSectionGid]      Asana: move here on a failed/interrupted run
 * @property {string} [holdSectionGid]         Asana: move here on `hold` (waiting on a human); absent → leave in place
 * @property {string} [sourceStatus]           Jira: entering this status fires the step (status name)
 * @property {string} [successStatus]          Jira: transition here on a clean finish (advance)
 * @property {string} [failureStatus]          Jira: transition here on a failed/interrupted run
 * @property {string} [holdStatus]             Jira: transition here on `hold`; absent → leave in place
 * @property {string} [sourceLabel]            GitHub: an issue carrying this label fires the step
 * @property {string} [successLabel]           GitHub: swap to this label on a clean finish (advance)
 * @property {string} [failureLabel]           GitHub: swap to this label on a failed/interrupted run
 * @property {string} [holdLabel]              GitHub: swap to this label on `hold`; absent → leave in place
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
 * @property {string} [target]   changes: the stepId to route back to (resolved to a concrete id by dispatch)
 * @property {string} [reason]   human-readable; logged, not posted
 */

/** In-flight pipeline job recorded locally for crash recovery (store.running).
 * @typedef {object} RunningInfo
 * @property {string} stepId
 * @property {number} [pid]
 * @property {string} startedAt
 * @property {string} [worktree]
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
 */

/**
 * Platform words injected into the prompt builders (src/prompts.js).
 * @typedef {object} AdapterMeta
 * @property {string} platform      e.g. "Asana", "GitHub"
 * @property {string} taskNoun      e.g. "task", "issue"
 * @property {string} trigger       comment prefix that requests a change (default "@agent")
 * @property {string} commentHowTo  one line telling the agent how to comment back
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
 * @property {(ref: string) => Promise<Task>} fetchTask
 * @property {(ref: string, stepId: string, verdict: Verdict) => Promise<void>} advance  resolve a finished step's transition (move to the section its outcome maps to)
 * @property {(ref: string, stepId: string, opts?: {assign?: boolean}) => Promise<{stage: string}>} [enterStage]  optional; `agenthook run` uses it. Assign the item to us (unless opts.assign===false), then move it INTO the step's source stage (add source label / addTask to source section / transition to source status) — the live webhook then fires the step. Returns the source stage entered
 * @property {(ref: string) => Promise<string|null>} [currentStage]  optional; `agenthook run`'s guard uses it. The pipeline stage (label / section gid / status) the item currently rests in among ANY step's source/success/failure/hold stage, or null. Read-only — refuses re-injecting an item already mid-flow (one ref = one in-flight flow)
 * @property {() => Promise<Job[]>} listResting  tasks currently resting in step source sections, as jobs — drives the explicit `reconcile` command (NEVER called on boot)
 * @property {(publicUrl: string) => Promise<void>} registerWebhook
 * @property {() => Promise<void>} unregisterWebhooks
 * @property {() => Promise<void>} [ensureLabels]  optional; create any pipeline objects the API won't auto-add to a task (GitHub: the issue labels). Called on boot before registerWebhook
 * @property {(ref: string, stepId?: string) => Promise<ForgedEvent>} [forgeCatchup]  optional; catchup needs it. dedupKey matches the server-assigned key; pass stepId to skip the live-section lookup
 * @property {(answers: Record<string, any>) => import('./wizard.js').WizardStep[]} [wizardSteps]  optional; `agenthook init` prompts
 * @property {(answers: Record<string, any>) => (Partial<Step>|null)} [pipelineBindings]  optional; `agenthook init` turns the wizard's live stage picks (the `_*Stage` answers) into the code step's tracker bindings (real source/success/failure), so no TODO_* editing is needed. Null ⇒ init keeps the placeholder skeleton
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
 * @property {string} [userGid]
 * @property {boolean} [assigneeFilter]  only act on items assigned to us (Asana userGid / Jira assigneeAccountId). Default true (fail-closed: unset id ⇒ refuse all); only false opts into project-wide
 * @property {string} [workspaceGid]
 * @property {string} [projectGid]  Asana: the project whose sections drive the pipeline
 * @property {string} [site]              Jira: site shortname ("<site>.atlassian.net"); or set baseUrl
 * @property {string} [baseUrl]           Jira: full base URL (overrides site)
 * @property {string} [email]             Jira: account email for Basic auth (typically a "${JIRA_EMAIL}" ref)
 * @property {string|false} [webhookSecret]  Jira/GitHub: explicit webhook signing secret; omit to let agenthook generate+store one; false disables verification
 * @property {string} [projectKey]        Jira: project key whose statuses drive the pipeline (e.g. "CAHUI")
 * @property {string} [assigneeAccountId] Jira: the bot's accountId — scope work to its issues
 * @property {string} [repository]         GitHub: "owner/name" whose issue labels drive the pipeline
 * @property {string} [owner]              GitHub: repo owner (alternative to repository)
 * @property {string} [repo]               GitHub: repo name (alternative to repository)
 * @property {string} [assigneeLogin]      GitHub / github-projects: the bot's login — scope work to its issues (else derived from /user or GraphQL viewer)
 * @property {string} [project]            github-projects: the Projects v2 board as "owner/number" or its URL, whose Status field drives the pipeline
 * @property {Step[]} [pipeline]  the ordered steps; a task entering a step's source section fires it
 */

/**
 * The ingress config block (`ingress` in agenthook.config.json). `type` selects the
 * adapter; the rest are adapter-specific options (already env-interpolated).
 * @typedef {object} IngressConfig
 * @property {string} type           ingress adapter key ("ngrok" | "manual" | "hosted")
 * @property {string} [url]          static public base URL (manual/hosted)
 * @property {string} [authtoken]    ngrok authtoken ("${NGROK_AUTHTOKEN}")
 * @property {string} [domain]       ngrok reserved domain (makes the URL stable)
 * @property {string} [webAddr]      ngrok local web-API address (default 127.0.0.1:4040)
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
 */

/** A factory `(cfg) => Ingress`.
 * @typedef {(cfg: Config) => Ingress} IngressFactory */

/**
 * Resolved runtime config. All paths are absolute. See config.js for the four
 * distinct location fields (install/config/state/repo).
 * @typedef {object} Config
 * @property {string} name           profile name; keys the central state dir
 * @property {string} installDir     read-only package root
 * @property {string} configPath     absolute path to the loaded agenthook.config.json
 * @property {string} configDir      dir holding the config
 * @property {string} stateDir       ~/.agenthook/<name>
 * @property {string} provider       active tracker key (= tracker.type)
 * @property {ProviderConfig} tracker
 * @property {ProviderConfig} providerConfig  alias of tracker, for adapter back-compat
 * @property {Step[]|null} pipeline  resolved tracker.pipeline (null when not configured)
 * @property {IngressConfig} ingress
 * @property {number} port
 * @property {string} trigger
 * @property {number} maxConcurrent
 * @property {boolean} [fullAuto]   opt-in; adds --dangerously-skip-permissions (unsandboxed code exec from a webhook). Default false = agents prompt for permission.
 * @property {string} repoPath
 * @property {string} claudeBin
 * @property {string} [worktreePrefix]
 * @property {string} dataDir
 * @property {string} logDir
 * @property {string} instructionsFile
 * @property {string} publicUrlFile
 * @property {string} pidFile
 * @property {string} heartbeatFile
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
 * @property {(ref: string, stepId: string) => number} getAttempt   how many times stepId has run for ref (0 if never)
 * @property {(ref: string, stepId: string) => number} bumpAttempt  increment and return the new count
 * @property {(ref: string) => void} clearAttempts                  drop all attempt counters for ref (it left the loop)
 */

export {};
