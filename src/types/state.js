/** @typedef {import('./pipeline.js').Job} Job */
/** @typedef {import('./pipeline.js').StepOutcome} StepOutcome */
/** @typedef {import('./config.js').Overrides} Overrides */

/** One stored step summary (summaries.json, keyed ref → stepId).
 * @typedef {object} SummaryRecord
 * @property {Record<string, unknown>} summary  the verdict's `summary`, as written (agent-authored — untrusted)
 * @property {StepOutcome} outcome  the outcome actually applied (after the changes guard / CI bounce)
 * @property {string} run           the run log basename (matches a `runs` row's `run`)
 * @property {string} at            ISO time the run finished
 * @property {string} [headSha]     forge.autoMerge tier step only: the PR head when the run started (what it judged)
 * @property {'agent'|'repaired'|'deduced'} [verdictSource]  where the outcome came from (#680): a verdict file the agent wrote, the #677 repair turn's, or deduced from commits; absent for a receiver-forced verdict or the `requireVerdict:false` assumed-advance
 * @property {'pass'|'fail'} [gate]  the step's `gate` (#710) result, when one ran; absent when the step has no gate or it never ran (no advance to veto)
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
 * @property {string|null} [harness] the harness the run was routed to (null = the step has none)
 * @property {string} [agent]        the agent adapter the run spawned (after the step's and the harness's `agent`)
 * @property {string} [host]         the worker host this run is on, for a remote harness (#691; the ssh executor)
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
 * @property {{sha: string, pr: number, step: string, at: string}} [autoMerge]  forge.autoMerge: we turned GitHub auto-merge on for this approved head (cleared when it comes off)
 * @property {{checks: string[], tier: string, step: string, at: string, pr?: number}} [followUp]  an approval with follow-up checks (src/followup.js): what to verify once the change is live; cleared by `followup done`, a bounce or fail, or a later approval by the same step without checks
 */

/** A `setRefMeta` patch: `undefined` skips a key, `null` deletes it.
 * @typedef {{ [K in keyof RefMeta]?: RefMeta[K] | null }} RefMetaPatch
 */

/** A ref parked by a `hold` verdict (store.held) — the step an owner's `@agent` reply resumes.
 * @typedef {object} HeldInfo
 * @property {string} stepId
 * @property {string} [reason]   the agent's hold reason (its question, in short)
 * @property {string} heldAt     ISO timestamp the hold verdict landed
 * @property {string} [harness]  which harness produced the reason — only set when the step lists 2+ harnesses
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
 * @property {string} [agent]      the agent adapter that ran — only on a harness run (a harness may switch it; otherwise the step names it)
 * @property {string} [harness]    the named harness that ran it — only on a harness run
 * @property {string} [host]       the worker host the run lived on — only on a remote-harness run (the ssh executor, #830)
 * @property {string} [remoteCwd]  the worker launch cwd a remote run lived in (#830) — where its transcript sits and where `resume` reopens it; absent on older records, which can't be located on the worker
 * @property {string} startedAt    ISO timestamp the run was spawned
 * @property {string} endedAt      ISO timestamp the run exited
 * @property {number} [durationMs] `result.duration_ms` if the adapter reports it, else `endedAt - startedAt` (dispatch derives it for agents like opencode/hermes that don't)
 * @property {number} input        usage.input_tokens
 * @property {number} output       usage.output_tokens
 * @property {number} cacheRead    usage.cache_read_input_tokens
 * @property {number} cacheCreate  usage.cache_creation_input_tokens
 * @property {number} [turns]       model turns the parser counted (#645); absent when the agent reports no per-turn usage (cursor/hermes)
 * @property {number} [firstContext]  the first turn's prompt size (input + cache-read + cache-create), only when `turns` is set
 * @property {number} [peakContext]   the largest turn's prompt size, only when `turns` is set
 * @property {number} [lastContext]   the final turn's prompt size, only when `turns` is set
 * @property {number} [compactions]   context compactions the parser saw (#657), only when `turns` is set; claude: `compact_boundary` events; opencode: inferred from a ≥20% prompt-size drop between steps; absent on cursor/hermes
 * @property {number} [costUsd]    result.total_cost_usd (kept raw even when `unpriced` — readers ignore it then)
 * @property {string} [sessionId]  result.session_id
 * @property {true} [unpriced]     local model (step `bin` or a non-Claude model): `costUsd` is not real spend
 * @property {number} [estUsd]     rate-table estimate (src/shared/pricing.js `costOf`), stamped at write time; absent on a reported run or with no rate/tokens
 * @property {'reported'|'rate-table'} [costBasis]  which figure stands for this run: `costUsd` (reported) or `estUsd` (rate-table)
 * @property {number} [energyKwh]   measured energy of an `energy: true` step's run (src/shared/energy.js; 1e-9 kWh), its share of machine power; absent when unmeasured
 * @property {number} [energyUsd]   energyKwh × the profile's `energy.usdPerKwh` (1e-6 $) — a third figure, never in costUsd/estUsd
 * @property {'hwmon'|'command'|'watts'} [energySource]  the `energy.source.type` that measured it
 */
/**
 * The JSON-file store (src/store/).
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
 * @property {(job: Job, opts?: {front?: boolean}) => void} addQueued  `front` re-inserts at index 0 (a harness-breaker requeue keeps its place across a restart)
 * @property {(job: Job) => void} removeQueued
 * @property {() => Job[]} listQueued
 * @property {(ref: string, stepId: string) => number} getAttempt   how many times stepId has run for ref (0 if never)
 * @property {(ref: string, stepId: string) => number} bumpAttempt  increment and return the new count
 * @property {(ref: string, stepId: string) => void} unbumpAttempt  decrement, clamped at 0 (#828): a harness-breaker trip never counts as an attempt
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
 * @property {(ref: string, b: {target: string, text: string, sha?: string}) => void} setCiRed  park a red-CI bounce for ref while a step runs on it (latest wins)
 * @property {(ref: string) => {target: string, text: string, sha?: string}|undefined} takeCiRed  read AND clear ref's parked red-CI bounce
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
 * @property {() => string|null} getMergeWatermark                  merge catch-up: ISO `mergedAt` of the newest merged agent PR listed (null = never ran)
 * @property {(iso: string) => void} setMergeWatermark               persist the merge catch-up watermark
 * @property {() => {down: Record<string, {until: string, strikes: number, reason: string, cause?: 'health'|'quota'}>, unharnessedUntil: string|null}} getHarnessHealth  harness breaker entries (harness-health.json `down`) and the unharnessed quota gate; `down` {} when none
 * @property {(down: Record<string, {until: string, strikes: number, reason: string, cause?: 'health'|'quota'}>, unharnessedUntil: string|null) => void} setHarnessHealth  persist the harness breaker entries (and gate)
 * @property {() => Overrides} getOverrides  operator runtime overrides (overrides.json); {} when missing/corrupt
 * @property {(o: Overrides) => void} setOverrides  persist the overrides; deletes the file when `o` has no entries
 */

export {};
