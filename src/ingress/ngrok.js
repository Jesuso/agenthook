// ngrok ingress: spawns a managed `ngrok http <port>` tunnel and reads the public
// URL back from ngrok's local web API. The URL rotates every restart on the free
// plan, so ephemeral=true UNLESS a reserved `domain` is configured (then it's
// stable and the engine skips the boot-time webhook scrub).
//
// Parallel profiles: ngrok's web API defaults to 127.0.0.1:4040, which collides if
// two tunnels run at once. Set ingress.webAddr per profile (and note the free plan
// only permits one simultaneous agent session anyway — use `manual`/`hosted` for
// real parallelism).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * The https tunnel that forwards to local `port` (ngrok reports it as `config.addr`, e.g.
 * `http://localhost:4124`). Never "the first https tunnel": with parallel profiles the web API
 * we read may belong to another profile's agent, and trusting its first tunnel registers that
 * profile's URL as ours (webhooks then land on the wrong receiver). `domain`, when configured,
 * must match too.
 * @param {any[]} tunnels @param {number|string} port @param {string} [domain]
 * @returns {string|null}
 */
export function pickTunnel(tunnels, port, domain) {
  for (const t of tunnels || []) {
    if (!String(t?.public_url ?? "").startsWith("https")) continue;
    const m = /:(\d+)\/?$/.exec(String(t?.config?.addr ?? ""));
    if (!m || m[1] !== String(port)) continue;
    const url = String(t.public_url).replace(/\/$/, "");
    if (domain && new URL(url).host !== domain) continue;
    return url;
  }
  return null;
}

/** The web API address ngrok actually bound (it falls back from 4040 when taken), from its log. @param {string} log */
export function webAddrFromLog(log) {
  const m = /starting web service[^\n]*\baddr=(\S+)/.exec(log);
  return m ? m[1] : null;
}

/** @type {import('../types.js').IngressFactory} */
export function createNgrokIngress(cfg) {
  const opts = cfg.ingress || { type: "ngrok" };
  const webAddr = opts.webAddr || "127.0.0.1:4040";
  const bin = process.env.NGROK || "ngrok";
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let stopping = false; // down() is killing the child: its exit is expected
  let connected = false; // up() has resolved a URL: a later exit is unexpected
  /** @type {((reason: string) => void) | null} */
  let exitListener = null;

  let out = ""; // our child's early output: names the web address it really bound

  /** Poll ngrok's web API until OUR https tunnel (forwarding to `port`) appears. */
  async function waitForUrl(/** @type {number} */ port) {
    for (let i = 0; i < 40; i++) {
      // The address our own ngrok logged first; the configured one is only a fallback (it may be
      // another profile's agent: ngrok moves to the next free port when 4040 is taken).
      for (const addr of new Set([webAddrFromLog(out), webAddr].filter(Boolean))) {
        try {
          const res = await fetch(`http://${addr}/api/tunnels`);
          if (!res.ok) continue;
          const url = pickTunnel(/** @type {any} */ (await res.json()).tunnels, port, opts.domain);
          if (url) return url;
        } catch {
          /* not up yet */
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`ngrok: no https tunnel for port ${port} after 20s (web API ${webAddrFromLog(out) ?? webAddr}). Check the ngrok log in ${cfg.logDir}.`);
  }

  return {
    describe: () => ({ name: "ngrok", ephemeral: !opts.domain }),

    onExit(listener) {
      exitListener = listener;
    },

    async up(port) {
      // ngrok v3 has no --web-addr CLI flag (it's config-file only); the inspect/API
      // address defaults to 127.0.0.1:4040, which we read tunnels from below. For
      // parallel profiles set `web_addr` in ngrok.yml and ingress.webAddr to match.
      const args = ["http", String(port), "--log", "stdout"];
      if (opts.domain) args.push("--domain", opts.domain);
      // Auth: only pass --authtoken when explicitly configured (headless/CI). Otherwise
      // the ngrok binary self-auths from its own config (`ngrok config add-authtoken`).
      if (opts.authtoken) args.push("--authtoken", opts.authtoken);
      else console.log("[ngrok] no ingress.authtoken set — using ngrok's own config for auth");

      stopping = false;
      connected = false;
      const logPath = path.join(cfg.logDir, "ngrok.log");
      const log = fs.createWriteStream(logPath, { flags: "a" });
      const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      child = proc;
      proc.stdout?.on("data", (c) => {
        if (out.length < 8192) out += c;
      });
      proc.stdout?.pipe(log);
      proc.stderr?.pipe(log);
      proc.on("error", (e) => console.error(`[ngrok] spawn failed: ${e.message} (is "${bin}" installed?)`));
      proc.on("exit", (code, signal) => {
        if (child === proc) child = null;
        if (!connected || stopping) return;
        const reason = `exited (${code ?? signal})`;
        console.error(`[ngrok] ${reason}; the tunnel is down — webhooks can't reach this receiver until \`agenthook restart\`. See ${logPath}.`);
        exitListener?.(reason);
      });

      const url = await waitForUrl(port);
      connected = true;
      console.log(`[ngrok] tunnel up: ${url} -> 127.0.0.1:${port}`);
      return { url };
    },

    async down() {
      stopping = true;
      if (child && !child.killed) {
        child.kill();
        child = null;
      }
    },

    wizardSteps: () => [
      {
        // Most users have run `ngrok config add-authtoken` already, so default blank:
        // leave it and agenthook lets the ngrok binary self-auth. Only set this for
        // headless/CI hosts where ngrok isn't pre-configured.
        key: "authtokenEnv",
        message: "Env var for ngrok authtoken — leave BLANK if ngrok is already authed",
        default: "",
      },
      { key: "domain", message: "Reserved ngrok domain for a stable URL (blank = ephemeral)", default: "" },
    ],
  };
}
