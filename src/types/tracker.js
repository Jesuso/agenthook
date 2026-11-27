/** @typedef {import('./pipeline.js').Job} Job */
/** @typedef {import('./pipeline.js').Step} Step */
/** @typedef {import('./pipeline.js').Verdict} Verdict */
/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./state.js').Store} Store */

/**
 * A tracker item resolved to platform-neutral fields.
 * @typedef {object} Task
 * @property {string} ref
 * @property {string} name
 * @property {string} [description]
 * @property {string} url
 * @property {boolean} completed
 * @property {boolean} assignedToUs
 * @property {string} [displayId]  the human-facing id operators use (Asana "ID-1234", GitHub "#94", Jira "CAHUI-7"); undefined when the tracker has none
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
 * @property {string|null} [url]  the ticket's own tracker web URL; null/absent when unknown
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

/** One ticket comment, as served by Adapter.fetchComments (#826). `owner` is computed
 * INSIDE the adapter with the same strict rule as the `@agent` resume gate (our own
 * identity, never `isOurs`); an unresolvable author/identity is `false` (fail closed).
 * @typedef {object} TicketComment
 * @property {string|null} author  the comment author's login, or null when the API gave none
 * @property {string} body
 * @property {string} createdAt  ISO timestamp as the platform reports it
 * @property {boolean} owner */

/** Per-run credentials an adapter hands one agent run (#474; src/github/run-token.js).
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
 * @property {(t: {name: string, description?: string, stepId?: string, blockedBy?: string[]}) => Promise<{ref: string, stage: string, stepId: string, blockedBy?: string[]}>} [createTask]  optional, local only (`agenthook ticket add`); add one item to the board at the step's source stage (default the first non-manual step; a manual/unknown step throws) under the next numeric ref, then push its created-in-stage job through the onJobs sink when wired. `blockedBy`: refs that must exist on the board; while any is open the item rests (no push) and the result echoes the open ones
 * @property {(ref: string) => Promise<Task>} fetchTask
 * @property {(ref: string, stepId: string, verdict: Verdict) => Promise<void>} advance  resolve a finished step's transition (move to the section its outcome maps to)
 * @property {(ref: string, stepId: string, opts?: {assign?: boolean}) => Promise<{stage: string}>} [enterStage]  optional; `agenthook run` uses it. Assign the item to us (unless opts.assign===false), then move it INTO the step's source stage (add source label / addTask to source section / transition to source status) — the live webhook then fires the step. Returns the source stage entered
 * @property {(ref: string) => Promise<string|null>} [currentStage]  optional; `agenthook run`'s guard uses it. The pipeline stage (label / section gid / status) the item currently rests in among ANY step's source/success/failure/hold stage, or null. Read-only — refuses re-injecting an item already mid-flow (one ref = one in-flight flow)
 * @property {() => Promise<Job[]>} listResting  tasks currently resting in step source sections, as jobs — drives the explicit `reconcile` command (NEVER called on boot)
 * @property {(stepId: string) => Promise<string[]>} [listQueued]  optional; refs resting in the step's opt-in QUEUE stage (queueSectionGid/queueStatus/queueLabel), board priority order (top first), filtered exactly like listResting (ours, fail-closed; open; GitHub: not blocked). [] when the step has no queue key. The engine calls it only when a slot frees (run_end) and once on boot — never on a timer. Not the same as store.listQueued (the local queue.json)
 * @property {(ref: string) => Promise<string[]>} [openBlockers]  optional; the item's unresolved blockers (empty = unblocked), re-checked at dispatch time so a dependency added while the job waited in the local queue still gates it. Same fail-open semantics as the receive-time gate (API error → [] + warn)
 * @property {(ref: string) => Promise<"ours"|"not_ours"|"check_failed">} [ownership]  optional; the same fail-closed owner check the mutation gate uses, exposed read-only for `prs`' `mine` flag (asana/github/jira only; absent on github-projects/local)
 * @property {(ref: string, body: string) => Promise<number|null>} [postComment]  optional (#825); post `body` on the item's ticket (trusted text the hub composed — a remote run's outbox comment, src/dispatch/publish.js; github/github-projects only). Returns the posted comment's id (null when the API gave none). Throws on a non-2xx
 * @property {(ref: string) => Promise<{ comments: TicketComment[], omitted?: number }>} [fetchComments]  optional (#826); the ticket's newest 100 comments (oldest→newest) for a REMOTE run's prompt — the worker holds no tracker credentials, so the hub embeds the thread in the prompt instead of pointing the agent at the API. `omitted` is how many OLDER comments were left out of the 100 (the prompt says so); absent when the thread fits or the adapter can't count it. The adapter computes each `owner` flag itself (strict identity, fail closed). Absent = the tracker can't serve comments, which config refuses for a remote harness
 * @property {(publicUrl: string) => Promise<void>} registerWebhook  an HTTP failure throws an Error carrying the numeric `status` (`Object.assign(new Error(msg), {status: res.status})`): boot retries a 5xx/429 (and network errors) indefinitely and a 404 three times (src/engine/boot-retry.js); any other status is fatal
 * @property {() => Promise<void>} unregisterWebhooks
 * @property {(ref: string) => Promise<void>} [complete]  optional; mark the item completed/closed on the tracker (Asana: completed:true). Used by a forge `merge` job; absent = no-op
 * @property {() => Promise<void>} [ensureLabels]  optional; create any pipeline objects the API won't auto-add to a task (GitHub: the issue labels). Called on boot before registerWebhook
 * @property {(ref: string, stepId?: string) => Promise<ForgedEvent>} [forgeCatchup]  optional; catchup needs it. dedupKey matches the server-assigned key; pass stepId to skip the live-section lookup
 * @property {(answers: Record<string, any>) => import('../wizard.js').WizardStep[]} [wizardSteps]  optional; `agenthook init` prompts
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
 * private key replaces the personal token (src/github/auth.js, docs/github-app.md).
 * @typedef {object} GithubAuthConfig
 * @property {"app"} type
 * @property {string|number} appId          the App's id (App settings → General)
 * @property {string|number} installationId the installation on the repo/org (…/installations/<id>)
 * @property {string} [privateKey]          the App's PEM, typically "${GITHUB_APP_PRIVATE_KEY}" (literal `\n` → newline)
 * @property {string} [privateKeyPath]      or a PEM file, relative to the config file
 */

export {};
