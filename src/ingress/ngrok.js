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

/** @type {import('../types.js').IngressFactory} */
export function createNgrokIngress(cfg) {
  const opts = cfg.ingress || { type: "ngrok" };
  const webAddr = opts.webAddr || "127.0.0.1:4040";
  const bin = process.env.NGROK || "ngrok";
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;

  /** Poll ngrok's web API until a https tunnel appears. */
  async function waitForUrl() {
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://${webAddr}/api/tunnels`);
        if (res.ok) {
          const data = /** @type {any} */ (await res.json());
          const t = (data.tunnels || []).find((/** @type {any} */ x) => x.public_url?.startsWith("https"));
          if (t) return t.public_url.replace(/\/$/, "");
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`ngrok: no https tunnel after 20s (web API ${webAddr}). Check the ngrok log in ${cfg.logDir}.`);
  }

  return {
    describe: () => ({ name: "ngrok", ephemeral: !opts.domain }),

    async up(port) {
      const args = ["http", String(port), "--web-addr", webAddr, "--log", "stdout"];
      if (opts.domain) args.push("--domain", opts.domain);
      if (opts.authtoken) args.push("--authtoken", opts.authtoken);

      const logPath = path.join(cfg.logDir, "ngrok.log");
      const log = fs.createWriteStream(logPath, { flags: "a" });
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.pipe(log);
      child.stderr?.pipe(log);
      child.on("error", (e) => console.error(`[ngrok] spawn failed: ${e.message} (is "${bin}" installed?)`));

      const url = await waitForUrl();
      console.log(`[ngrok] tunnel up: ${url} -> 127.0.0.1:${port}`);
      return { url };
    },

    async down() {
      if (child && !child.killed) {
        child.kill();
        child = null;
      }
    },

    wizardSteps: () => [
      {
        key: "authtokenEnv",
        message: "Env var holding your ngrok authtoken (blank = use ngrok's own config)",
        default: "NGROK_AUTHTOKEN",
      },
      { key: "domain", message: "Reserved ngrok domain for a stable URL (blank = ephemeral)", default: "" },
    ],
  };
}
