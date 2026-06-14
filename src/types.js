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
 * @property {'implement'|'change'} kind  implement = new assignment; change = `@agent` comment
 * @property {string} ref       provider-native item id (Asana gid, `owner/repo#123`, …)
 * @property {string} [text]    the change request text (change jobs only)
 * @property {string} dedupKey  unique per source event; one key → at most one run
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
 */

/**
 * The provider contract. One file in src/providers/ exports a factory returning
 * this; register it in src/providers/index.js. The engine talks ONLY through here.
 * @typedef {object} Adapter
 * @property {() => AdapterMeta} describe
 * @property {(ctx: EventCtx) => AuthResult} authenticate
 * @property {(ctx: EventCtx) => Promise<Job[]>} processEvents
 * @property {(ref: string) => Promise<Task>} fetchTask
 * @property {(ref: string) => Promise<void>} ensureCommentWebhook
 * @property {(publicUrl: string) => Promise<void>} registerWebhook
 * @property {() => Promise<void>} unregisterWebhooks
 * @property {(ref: string) => ForgedEvent} [forgeCatchup]  optional; catchup needs it
 */

/**
 * A provider factory: `(cfg, store) => Adapter`.
 * @typedef {(cfg: Config, store: Store) => Adapter} AdapterFactory
 */

/**
 * Per-provider config block (providers.<name> in config.json). Loose by design —
 * each adapter reads its own fields. Secrets (`token`, `webhookSecret`) are NOT in
 * config.json; loadConfig resolves them from the environment and attaches them here.
 * @typedef {object} ProviderConfig
 * @property {string} [token]            resolved API token (env/.env; set by loadConfig)
 * @property {string} [tokenEnv]         env var to read the token from (default per provider)
 * @property {string} [tokenFile]        legacy fallback: read the token from this file
 * @property {string} [webhookSecret]    resolved HMAC secret (env wins; config fallback)
 * @property {string} [webhookSecretEnv] env var for the webhook secret (default WEBHOOK_SECRET)
 * @property {string} [repo]
 * @property {string} [assigneeLogin]
 * @property {string} [userGid]
 * @property {string} [workspaceGid]
 * @property {string} [myTasksGid]
 * @property {string} [projectGid]  Asana: watch this project instead of My Tasks
 */

/**
 * Resolved runtime config (paths already expanded to absolutes by config.js).
 * @typedef {object} Config
 * @property {string} root
 * @property {string} provider
 * @property {number} port
 * @property {string} trigger
 * @property {number} maxConcurrent
 * @property {boolean} [fullAuto]
 * @property {string} repoPath
 * @property {string} claudeBin
 * @property {string} [worktreePrefix]
 * @property {string} dataDir
 * @property {string} logDir
 * @property {string} instructionsFile
 * @property {string} publicUrlFile
 * @property {Record<string, ProviderConfig>} providers
 * @property {ProviderConfig} providerConfig  the block for the active provider
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
 */

export {};
