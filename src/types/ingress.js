/** @typedef {import('./config.js').Config} Config */

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
 * @property {() => import('../wizard.js').WizardStep[]} [wizardSteps]
 * @property {(listener: (reason: string) => void) => void} [onExit] registers a listener an
 *   adapter calls at most once, only when its managed tunnel dies unexpectedly after `up()`
 *   resolved (never during `down()` or a startup failure)
 */

/** A factory `(cfg) => Ingress`. `timeoutMs` bounds a managed tunnel's startup (cloudflared) or each
 * CLI call (tailscale); `run` replaces tailscale's execFile. Both for tests.
 * @typedef {(cfg: Config, opts?: { timeoutMs?: number, run?: IngressRun }) => Ingress} IngressFactory */
/** Runs one CLI call; a non-zero exit resolves with its `code`, a spawn failure rejects. `env`
 * is set over the runner's own env (a `-e NAME` then reads its value from there, never argv).
 * @typedef {(bin: string, args: string[], opts: { timeoutMs: number, env?: Record<string, string> }) => Promise<{ code: number|null, stdout: string, stderr: string }>} IngressRun */

export {};
