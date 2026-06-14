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
 * @property {(answers: Record<string, any>) => import('./wizard.js').WizardStep[]} [wizardSteps]  optional; `agenthook init` prompts
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
 * @property {string} type               tracker adapter key (e.g. "asana", "github")
 * @property {string} [token]            API token (typically a "${ASANA_TOKEN}" ref)
 * @property {string} [webhookSecret]    HMAC secret (GitHub-style; "${WEBHOOK_SECRET}")
 * @property {string} [repo]
 * @property {string} [assigneeLogin]
 * @property {string} [userGid]
 * @property {string} [workspaceGid]
 * @property {string} [myTasksGid]
 * @property {string} [projectGid]  Asana: watch this project instead of My Tasks
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
 * @property {IngressConfig} ingress
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
 */

export {};
