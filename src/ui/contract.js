// Shared server ↔ browser contract for `ah ui` (docs/web-ui.md). JSDoc typedefs only,
// no runtime code — the frontend `import type`s these so the two sides can't drift.
// Everything here is what the UI server is willing to expose: no ingress URL, no
// paths beyond the instruction-file allowlist, no secrets, no config values beyond these fields.

/**
 * One profile under ~/.agenthook. With no heartbeat (profile down, or never started)
 * only `name`/`up`/`pid` are set; every other field is null.
 * @typedef {object} ProfileView
 * @property {string} name
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
 */

/** @typedef {{ at: string|null, kind: string|null, ref: string|null, step: string|null }} LastEvent */

/** @typedef {'running'|'queued'|'held'|'failed'|'done'|'idle'} TicketStatus */

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
 * @typedef {{ type: 'profile', profile: ProfileView }
 *   | { type: 'profile_removed', name: string }
 *   | { type: 'ticket', ticket: TicketRow }
 *   | { type: 'ticket_removed', profile: string, ref: string }
 *   | { type: 'event', profile: string, event: Record<string, any> }
 *   | { type: 'instructions', profile: string, path: string, hash: string|null, source: 'ui'|'disk' }} UiEvent
 */

/**
 * One run of a ref, from its log file under the profile's `logs/` (`GET /api/runs` → `{ runs }`,
 * newest first). `outcome`/`costUsd` come from the matching `run_end` in the events tail —
 * null while it runs, or when that event has aged out of the tail.
 * @typedef {object} RunView
 * @property {string} run                 log basename — the `run` param of /api/log/stream
 * @property {string} step
 * @property {string} startedAt           ISO, from the log's filename stamp
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

export {};
