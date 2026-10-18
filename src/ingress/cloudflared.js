// cloudflared ingress: spawns a managed `cloudflared tunnel` and reads the public URL
// back from its log. Two modes:
//   - quick (no ingress.tunnel): an account-less trycloudflare.com tunnel. The URL
//     rotates every start, so ephemeral=true and the engine scrubs webhooks on boot.
//   - named (ingress.tunnel + ingress.hostname): a tunnel the user created and routed
//     with `cloudflared tunnel create` / `route dns`. The URL is https://<hostname>,
//     stable, so ephemeral=false.
//
// Parallel profiles: each profile runs its own cloudflared process and there is no
// shared local web API (unlike ngrok's :4040), so tunnels never collide.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const BUF_MAX = 64 * 1024; // keep only the recent output: enough to parse + report a tail
const TAIL_LINES = 20;
const KILL_GRACE_MS = 5000;

const INSTALL_HINT = [
  "Install cloudflared:",
  "  macOS:         brew install cloudflared",
  "  Debian/Ubuntu: add Cloudflare's apt repo (https://pkg.cloudflare.com), then sudo apt install cloudflared",
  "  Windows:       winget install --id Cloudflare.cloudflared",
  "  Other:         https://github.com/cloudflare/cloudflared/releases",
  "or point CLOUDFLARED at the binary.",
].join("\n");

/** The quick tunnel's public URL from cloudflared's log (the boxed "Your quick Tunnel has been
 * created!" banner), else null. The earlier "Requesting new quick Tunnel on trycloudflare.com..."
 * line has no scheme, so it never matches. @param {string} text @returns {string|null} */
export function quickUrlFromLog(text) {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
  return m ? m[0] : null;
}

/** True once cloudflared has an edge connection: the URL is printed before that exists, and the
 * tracker's handshake hits it during webhook registration. @param {string} text */
export function connectedFromLog(text) {
  return /Registered tunnel connection/.test(text);
}

/** `https://hook.example.com/` → `hook.example.com`. @param {string|undefined} h */
export function bareHostname(h) {
  return String(h ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

/** @param {string} text */
const tail = (text) => text.split(/\r?\n/).filter(Boolean).slice(-TAIL_LINES).join("\n");

/** @param {import('node:child_process').ChildProcess} proc */
const alive = (proc) => proc.pid != null && proc.exitCode === null && proc.signalCode === null;

/** Resolve true once `proc` exits, false after `ms`. @param {import('node:child_process').ChildProcess} proc @param {number} ms */
function waitExit(proc, ms) {
  if (!alive(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

/** SIGTERM our own child (never its group, never by name), SIGKILL it if it lingers.
 * @param {import('node:child_process').ChildProcess} proc */
async function stop(proc) {
  if (!alive(proc)) return;
  proc.kill("SIGTERM");
  if (await waitExit(proc, KILL_GRACE_MS)) return;
  proc.kill("SIGKILL");
  await waitExit(proc, KILL_GRACE_MS);
}

/** `timeoutMs` (default 30s) bounds startup; tests shorten it. Not a config key.
 * @type {import('../types.js').IngressFactory} */
export function createCloudflaredIngress(cfg, { timeoutMs = 30_000 } = {}) {
  const opts = cfg.ingress || { type: "cloudflared" };
  const tunnel = opts.tunnel || "";
  const hostname = bareHostname(opts.hostname);
  const named = !!tunnel;
  const mode = named ? "named tunnel" : "quick tunnel";
  const bin = process.env.CLOUDFLARED || "cloudflared";
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let stopping = false; // down() or the startup timeout is killing the child: its exit is expected

  return {
    describe: () => ({ name: "cloudflared", ephemeral: !named }),

    async up(port) {
      if (!!tunnel !== !!hostname) {
        throw new Error(
          `cloudflared: a named tunnel needs both ingress.tunnel and ingress.hostname ` +
            `(got ${tunnel ? `tunnel "${tunnel}"` : "no tunnel"}, ${hostname ? `hostname "${hostname}"` : "no hostname"}). ` +
            `Leave both blank for a quick tunnel.`,
        );
      }
      stopping = false;
      const target = `http://127.0.0.1:${port}`;
      const args = named ? ["tunnel", "--no-autoupdate", "run", "--url", target, tunnel] : ["tunnel", "--no-autoupdate", "--url", target];

      fs.mkdirSync(cfg.logDir, { recursive: true });
      const logPath = path.join(cfg.logDir, "cloudflared.log");
      const log = fs.createWriteStream(logPath, { flags: "a" });
      log.on("error", (e) => console.error(`[cloudflared] log write failed: ${e.message}`));

      // Own process group: a terminal Ctrl-C reaches only the receiver, whose shutdown runs down().
      const proc = spawn(bin, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      child = proc;

      return await new Promise((resolve, reject) => {
        let buf = ""; // cloudflared logs to stderr; both streams land here and in the log
        /** @type {string|null} */
        let url = null;
        let settled = false;

        /** @param {Error|null} err @param {{ url: string }} [val] */
        const settle = (err, val) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(/** @type {{ url: string }} */ (val));
        };

        /** @param {Buffer|string} c */
        const onData = (c) => {
          log.write(c);
          buf = (buf + c).slice(-BUF_MAX);
          if (!named) url ??= quickUrlFromLog(buf);
          if (settled || !connectedFromLog(buf)) return;
          if (named) url = `https://${hostname}`;
          if (!url) return;
          console.log(`[cloudflared] ${mode} up: ${url} -> ${target}`);
          settle(null, { url });
        };
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", onData);

        proc.on("error", (e) => {
          if (child === proc) child = null;
          const hint = /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" ? `"${bin}" not found.\n${INSTALL_HINT}` : `spawn "${bin}" failed: ${e.message}`;
          settle(new Error(`cloudflared: ${hint}`));
        });

        proc.on("close", (code, signal) => {
          log.end();
          if (child === proc) child = null;
          if (settled) {
            if (!stopping) console.error(`[cloudflared] exited (${code ?? signal}); the tunnel is down — webhooks can't reach this receiver until \`agenthook restart\`. See ${logPath}.`);
            return;
          }
          settle(new Error(`cloudflared (${mode}, port ${port}) exited (${code ?? signal}) before connecting. Last log lines:\n${tail(buf)}`));
        });

        const timer = setTimeout(async () => {
          if (settled) return;
          settled = true; // the close handler must not win the race while we kill
          stopping = true;
          await stop(proc);
          if (child === proc) child = null;
          reject(new Error(`cloudflared (${mode}, port ${port}): no tunnel connection after ${Math.round(timeoutMs / 1000)}s. See ${logPath}. Last log lines:\n${tail(buf)}`));
        }, timeoutMs);
      });
    },

    async down() {
      const proc = child;
      child = null;
      if (!proc) return;
      stopping = true;
      await stop(proc);
    },

    wizardSteps: () => [
      {
        key: "_mode",
        message: "cloudflared tunnel",
        type: "select",
        default: "quick",
        choices: [
          { title: "quick — no account; the URL rotates every start", value: "quick" },
          { title: "named — stable https://<hostname> (you create + route the tunnel first)", value: "named" },
        ],
      },
      {
        key: "tunnel",
        message: "Named tunnel name or UUID (from `cloudflared tunnel create <name>`)",
        when: (a) => a._mode === "named",
        validate: (v) => (String(v).trim() ? true : "required for a named tunnel"),
      },
      {
        key: "hostname",
        message: "Public hostname routed to the tunnel (e.g. hook.example.com)",
        when: (a) => a._mode === "named",
        validate: (v) => (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(String(v).trim()) ? true : "a bare hostname: no https://, no path"),
      },
    ],
  };
}
