// tailscale ingress: exposes the receiver through Tailscale Funnel at a stable
// https://<machine>.<tailnet>.ts.net URL, so ephemeral=false.
//
// Funnel is configured by one-shot CLI calls and served by tailscaled itself: there is no child
// to supervise. up() mounts `/<stateKey>` → http://127.0.0.1:<port>; down() removes only that
// mount (never `reset`, never another path).
//
// Parallel profiles share the machine's hostname, so each gets its own path prefix. Tailscale's
// serve proxy strips the mount point before proxying (http.StripPrefix, tailscale#6571), so
// https://<host>/<stateKey>/forge reaches the receiver as /forge: only publicUrl carries the path.
import { execFile } from "node:child_process";

const INSTALL_HINT = [
  "Install Tailscale: https://tailscale.com/download",
  "  macOS (App Store app): the CLI is /Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "or point TAILSCALE at the binary.",
].join("\n");

/** @typedef {import('../types.js').IngressRun} Run */
/** @typedef {Awaited<ReturnType<Run>>} RunResult */

/** The default `run`: execFile, killed after `timeoutMs`. A non-zero exit resolves; a spawn
 * failure (ENOENT) or a kill rejects. @type {Run} */
const execRun = (bin, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") return reject(err);
      resolve({ code: err ? Number(err.code) : 0, stdout, stderr });
    });
  });

/** The tailnet DNS name of this machine from `tailscale status --json`, trailing dot stripped.
 * @param {any} json @returns {string} */
export function hostFromStatus(json) {
  return String(json?.Self?.DNSName ?? "").replace(/\.$/, "");
}

/** Why Funnel can't work from `tailscale status --json`, else null. Checked before any funnel
 * call: with Funnel off, `tailscale funnel` can block on an interactive enable prompt.
 * @param {any} json @returns {string|null} */
export function statusProblem(json) {
  const state = json?.BackendState;
  if (state !== "Running") return `tailscale is not connected (state ${state || "unknown"}): run \`tailscale up\`.`;
  if (!Array.isArray(json.CertDomains) || !json.CertDomains.length) {
    return "tailscale: HTTPS certificates are disabled for this tailnet. Enable HTTPS on the admin console DNS page: https://login.tailscale.com/admin/dns";
  }
  const caps = [...Object.keys(json.Self?.CapMap || {}), ...(json.Self?.Capabilities || [])];
  if (!caps.some((c) => c === "funnel" || String(c).startsWith("https://tailscale.com/cap/funnel"))) {
    return "tailscale: Funnel is not permitted for this node. Add the funnel node attribute to the tailnet policy: https://tailscale.com/kb/1223/funnel";
  }
  return null;
}

/** `timeoutMs` (default 30s) bounds each CLI call; `run` replaces execFile in tests. Not config keys.
 * @type {import('../types.js').IngressFactory} */
export function createTailscaleIngress(cfg, { timeoutMs = 30_000, run = execRun } = {}) {
  const bin = process.env.TAILSCALE || "tailscale";
  const mountPath = "/" + cfg.stateKey;
  let mounted = false;

  /** Run one CLI call, rejecting after `timeoutMs` so a hang is an error, never a stuck boot.
   * @param {string[]} args @returns {Promise<RunResult>} */
  async function call(args) {
    const hung = new Error(`tailscale ${args.join(" ")}: no answer after ${Math.round(timeoutMs / 1000)}s.`);
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(hung), timeoutMs);
    });
    try {
      return /** @type {RunResult} */ (await Promise.race([run(bin, args, { timeoutMs }), timeout]));
    } catch (e) {
      if (e === hung || e.killed) throw hung;
      if (e.code === "ENOENT") throw new Error(`tailscale: "${bin}" not found.\n${INSTALL_HINT}`);
      throw new Error(`tailscale: running "${bin}" failed: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    describe: () => ({ name: "tailscale", ephemeral: false }),

    async up(port) {
      const st = await call(["status", "--json"]);
      if (st.code !== 0) throw new Error(`tailscale status failed (exit ${st.code}): ${st.stderr.trim() || st.stdout.trim()}`);
      let json;
      try {
        json = JSON.parse(st.stdout);
      } catch (e) {
        throw new Error(`tailscale status --json: unparseable output (${e.message})`);
      }
      const problem = statusProblem(json);
      if (problem) throw new Error(problem);
      const host = hostFromStatus(json);
      if (!host) throw new Error("tailscale status --json: no Self.DNSName for this machine");

      const target = `http://127.0.0.1:${port}`;
      const res = await call(["funnel", "--bg", "--set-path", mountPath, target]);
      if (res.code !== 0) {
        const err = res.stderr.trim() || res.stdout.trim();
        const hint = /access denied|serve config denied/i.test(err) ? "\nLet your user manage serve config: sudo tailscale set --operator=$USER" : "";
        throw new Error(`tailscale funnel failed (exit ${res.code}): ${err}${hint}`);
      }
      mounted = true;
      const url = `https://${host}${mountPath}`;
      console.log(`[tailscale] funnel up: ${url} -> ${target}`);
      return { url };
    },

    async down() {
      if (!mounted) return;
      mounted = false;
      try {
        const res = await call(["funnel", "--set-path", mountPath, "off"]);
        if (res.code !== 0) console.error(`[tailscale] removing funnel ${mountPath} failed (exit ${res.code}): ${res.stderr.trim()}`);
      } catch (e) {
        console.error(`[tailscale] removing funnel ${mountPath} failed: ${e.message}`);
      }
    },

    wizardSteps: () => [], // nothing to ask: the path derives from the profile
  };
}
