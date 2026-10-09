// Shared server ↔ browser contract for `ah ui` (docs/web-ui.md). JSDoc typedefs plus one
// runtime constant (SENSITIVE_FIELDS) — the frontend imports these so the two sides can't
// drift. Keep it import-free: the browser bundles this file, so it must never pull in a Node
// module (src/config.js drags in node:fs). Everything here is what the UI server is willing to
// expose: no ingress URL, no paths beyond the instruction-file allowlist and the profile's
// config file, no resolved secrets (the config editor sees the raw file, `${VAR}` refs unresolved).

/**
 * Config paths whose change the audit line names and the config editor confirms twice: the
 * agent's permission mode and binary, the tracker identity that scopes which items are ours,
 * and every src/config.js SECRET_FIELDS path (a test keeps that list a subset of this one).
 * `[*]` expands every element of an array.
 */
export const SENSITIVE_FIELDS = /** @type {const} */ ([
  "name",
  "fullAuto",
  "claudeBin",
  "tracker.userGid",
  "tracker.assigneeFilter",
  "tracker.email",
  "tracker.token",
  "tracker.webhookSecret",
  "forge.token",
  "forge.webhookSecret",
  "ingress.authtoken",
  "sinks[*].url",
  "sinks[*].botToken",
]);

/**
 * One profile under ~/.agenthook. With no heartbeat (profile down, or never started)
 * only `name`/`label`/`up`/`pid` and the provenance fields (`configPath` … `configMissing`, from
 * the state dir's profile.json) are set; every other field is null.
 * @typedef {object} ProfileView
 * @property {string} name                the state key (state-dir name) — the stable id every
 *                                        API `profile` param and SSE `profile` field carries
 * @property {string} label               display name: heartbeat.name, else profile.json's, else `name`
 * @property {boolean} up                 pidfile pid is alive
 * @property {number|null} pid
 * @property {number|null} port
 * @property {string|null} tracker
 * @property {string|null} ingress
 * @property {boolean|null} fullAuto
 * @property {number|null} maxConcurrent  configured agent slots (heartbeat.maxConcurrent)
 * @property {string|null} startedAt
 * @property {string|null} updatedAt
 * @property {number|null} active         agents running (heartbeat.queue.active); null when down
 * @property {number|null} queued         jobs waiting behind maxConcurrent; null when down
 * @property {LastEvent|null} lastEvent  the last job the receiver took in
 * @property {string|null} configPath     the owning config file, tildified (profile.json, else heartbeat)
 * @property {string|null} createdAt      profile.json createdAt, else the state dir's birth time
 * @property {string|null} lastSeenAt     heartbeat.updatedAt, else the later of profile.json updatedAt / events.jsonl mtime
 * @property {boolean} ghost              no receiver ever ran here: no marker, no heartbeat, nothing but an empty logs/
 * @property {boolean} configMissing      configPath is set but the file no longer exists
 * @property {RecentCost[]} recentCosts   `run_end` costs from the events tail's last 48 h, oldest
 *                                        first — the browser buckets them by its local midnight
 *                                        (approximate: the tail is byte-bounded)
 */

/** @typedef {{ at: string, costUsd: number }} RecentCost */

/** @typedef {{ at: string|null, kind: string|null, ref: string|null, step: string|null }} LastEvent */

/** @typedef {'running'|'queued'|'held'|'failed'|'done'|'idle'|'interrupted'|'stalled'} TicketStatus */
/* `interrupted` (was `running`) / `stalled` (was `queued`) replace those statuses when the
 * owning profile is down: the receiver that would finish or drain the job isn't running. */

/**
 * One merged record per (profile, ref): running ∪ queue ∪ held ∪ refmeta ∪ recent events.
 * @typedef {object} TicketRow
 * @property {string} profile
 * @property {string} ref
 * @property {string} displayId           refmeta.displayId, else ref
 * @property {string|null} title
 * @property {string|null} step           current / last step id
 * @property {TicketStatus} status
 * @property {string|null} model          from running.json, else the last run_start
 * @property {string|null} startedAt
 * @property {number} costUsd             sum of run_end.costUsd within the events tail (approximation)
 * @property {string|null} trackerUrl     refmeta.url
 * @property {string|null} prUrl          https://github.com/<repository>/pull/<refmeta.pr>
 * @property {string|null} heldReason
 */

/**
 * `GET /api/snapshot` body.
 * @typedef {object} Snapshot
 * @property {ProfileView[]} profiles
 * @property {TicketRow[]} tickets
 */

/**
 * SSE delta (`GET /api/stream`), framed as `event: <type>` + `data: <this, as JSON>`. Sent only
 * on a real change; the client re-fetches `/api/snapshot` on every (re)connect (no replay).
 * - `profile` — a profile appeared or its view changed (incl. `up` flipping on socket close)
 * - `profile_removed` — its state dir is gone (its tickets get `ticket_removed` first)
 * - `ticket` — a row is new or changed; `ticket_removed` — the ref left every state source
 * - `event` — one new events.jsonl line, parsed, tagged with its profile
 * - `instructions` — an allowlisted instruction file's content changed; `hash` is the new
 *   sha256, null when the file is gone. `source: 'ui'` — saved through `PUT
 *   /api/instructions/file`; `'disk'` — changed on disk by anything else (an `$EDITOR` save)
 * - `config` — the profile's config file (heartbeat.configPath) changed; `hash`/`source` as for
 *   `instructions` (`'ui'` = saved through `PUT /api/config`)
 * @typedef {{ type: 'profile', profile: ProfileView }
 *   | { type: 'profile_removed', name: string }
 *   | { type: 'ticket', ticket: TicketRow }
 *   | { type: 'ticket_removed', profile: string, ref: string }
 *   | { type: 'event', profile: string, event: Record<string, any> }
 *   | { type: 'instructions', profile: string, path: string, hash: string|null, source: 'ui'|'disk' }
 *   | { type: 'config', profile: string, hash: string|null, source: 'ui'|'disk' }} UiEvent
 */

/**
 * One run of a ref, from its log file under the profile's `logs/` (`GET /api/runs` → `{ runs }`,
 * newest first). `outcome`/`costUsd` come from the matching `run_end` in the events tail —
 * null while it runs, or when that event has aged out of the tail.
 * @typedef {object} RunView
 * @property {string} run                 log basename — the `run` param of /api/log/stream
 * @property {string} step
 * @property {string} startedAt           ISO, from the log's filename stamp
 * @property {string|null} endedAt        run_end.ts; null while it runs or once run_end left the tail
 * @property {string|null} outcome        run_end.outcome (advance/fail/hold/changes…)
 * @property {number|null} costUsd
 * @property {boolean} running            no outcome yet, newest run, and running.json has it
 * @property {number} bytes               log size when listed
 */

/**
 * `GET /api/log/stream` SSE frame, framed as `event: <type>` + `data: <the rest, as JSON>`.
 * - `init` — the last ≤ 64 KB; when `truncated` it starts on a line boundary. `size` = file bytes.
 * - `append` — bytes written since the previous frame.
 * - `reset` — the file was truncated/replaced: clear, an `init` follows.
 * @typedef {{ type: 'init', text: string, truncated: boolean, size: number }
 *   | { type: 'append', text: string }
 *   | { type: 'reset' }} LogFrame
 */

/**
 * One allowlisted standing-instructions file (heartbeat.instructions). `ids` are step ids for
 * `step`/`default` scope and repo ids for `repo`.
 * @typedef {object} InstructionFileView
 * @property {string} path                absolute — the `path` param of /api/instructions/file
 * @property {'step'|'default'|'repo'} scope
 * @property {string[]} ids
 * @property {string|null} hash           sha256 hex of the content; null when missing
 * @property {number} bytes
 * @property {string|null} mtime          ISO
 * @property {boolean} exists
 * @property {number} agentsRunning       running agents on a step that reads it (repo: all)
 */

/**
 * `GET /api/instructions` body.
 * @typedef {object} InstructionsView
 * @property {string|null} configPath     heartbeat.configPath
 * @property {InstructionFileView[]} files
 */

/**
 * `GET /api/prompt-preview` body: the step's last real prompt split at `=== TICKET ===`
 * (`standing` is '' when the prompt had no standing part). `run` is the matching log
 * basename, as in RunView; `{ run: null }` when the step has no saved prompt yet.
 * @typedef {{ run: string, standing: string, ticket: string } | { run: null }} PromptPreview
 */

/**
 * `GET /api/config` body: the profile's raw `agenthook.config.json` (heartbeat.configPath —
 * `${VAR}` refs unresolved). `errors` is [] when it passes validateRawConfig, its errors when not,
 * `["invalid JSON: …"]` when it doesn't parse. `literalSecrets` names the SECRET_FIELDS paths
 * holding a literal instead of a `${VAR}` ref (a warning; [] when it doesn't parse).
 * @typedef {object} ConfigView
 * @property {string} path
 * @property {string} text
 * @property {string} hash                sha256 hex — the `baseHash` of `PUT /api/config`
 * @property {string[]} errors
 * @property {string[]} literalSecrets
 */

/**
 * `GET /api/profile/remove-preview` body — what the Remove… modal shows before `POST
 * /api/profile/remove`. Paths are tildified; `configPath` (and so `webhookHint`) is null for a
 * legacy state dir with neither a `profile.json` nor a heartbeat naming it.
 * @typedef {object} RemovePreview
 * @property {string} profile             the state key
 * @property {string} label               ProfileView.label — what the confirm input must match
 * @property {boolean} up
 * @property {string|null} configPath
 * @property {string} archivePattern      `<registry>-archive/<key>-<YYYY-MM-DDTHH-MM-SS>/`
 * @property {string|null} webhookHint    `agenthook unregister --config <configPath>`
 */
