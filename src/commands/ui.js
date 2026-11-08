// `agenthook ui [--port 4180] [--host 127.0.0.1] [--no-open]` — local web dashboard + editors over every
// profile under ~/.agenthook (docs/web-ui.md). Binds 127.0.0.1 only (no flag to change
// it), mints a per-launch token and prints/opens the `?token=` URL. Loads no config:
// like `ls`, it reads the state dirs directly.
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createUiServer } from "../ui/server.js";
import { uiBundleState } from "../ui-bundle.js";

export const DEFAULT_PORT = 4180;

/** The bundled frontend, resolved from the install dir (built by `npm run build:ui`). */
const DIST_DIR = fileURLToPath(new URL("../../ui/dist/", import.meta.url));

/** The frontend source, resolved from the install dir. Absent from an npm install (only
 * `ui/dist` ships — see `files` in package.json); present in a dev checkout. */
const SRC_DIR = fileURLToPath(new URL("../../ui/src/", import.meta.url));

/** `--port` → a TCP port; absent → 4180. Throws on a missing/non-integer/out-of-range value.
 * @param {Record<string, any>} args */
export function uiPort(args) {
  if (!("port" in args)) return DEFAULT_PORT;
  const s = String(args.port ?? "");
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid --port "${args.port ?? ""}" — expected an integer 1-65535`);
  return n;
}

/**
 * `--host` → the address to bind; absent → 127.0.0.1 (loopback only, the default and the safe
 * choice). An IP literal, `localhost`, or `0.0.0.0` / `::` for every interface. Anything else
 * (a DNS name) throws: the Host guard matches addresses, not names.
 * @param {Record<string, any>} args
 */
export function uiHost(args) {
  if (!("host" in args)) return "127.0.0.1";
  const h = String(args.host ?? "").trim().toLowerCase();
  if (h === "localhost") return "127.0.0.1";
  if (h && net.isIP(h)) return h;
  throw new Error(`invalid --host "${args.host ?? ""}" — expected an IP address (127.0.0.1, 0.0.0.0, 192.168.1.5, ::)`);
}

/** The URLs the dashboard answers at for a bind address: loopback, plus each interface address when bound to all, or the one address.
 * @param {string} host @param {number} port @param {string} token */
export function uiUrls(host, port, token) {
  const url = (/** @type {string} */ a) => `http://${a.includes(":") ? `[${a}]` : a}:${port}/?token=${token}`;
  const out = [url("127.0.0.1")];
  if (host === "0.0.0.0" || host === "::") {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list ?? []) if (!i.internal && (host === "::" || i.family === "IPv4")) out.push(url(i.address.replace(/%.*$/, "")));
    }
  } else if (host !== "127.0.0.1") out.push(url(host));
  return out;
}

/** Throw unless the frontend bundle is built. @param {string} distDir */
export function checkBundle(distDir) {
  if (!fs.existsSync(path.join(distDir, "index.html"))) throw new Error("UI bundle not built — run `npm run build:ui`");
}

/** Best-effort browser open; the opener is the only process that sees the token. @param {string} url */
function openBrowser(url) {
  /** @type {[string, string[], import('node:child_process').SpawnOptions]} */
  const [cmd, argv, extra] =
    process.platform === "darwin"
      ? ["open", [url], {}]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', url], { windowsVerbatimArguments: true }]
        : ["xdg-open", [url], {}];
  try {
    const child = spawn(cmd, argv, { detached: true, stdio: "ignore", ...extra });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no opener — the printed URL is enough */
  }
}

/** @param {Record<string, any>} args */
export async function ui(args) {
  const port = uiPort(args);
  const host = uiHost(args);
  checkBundle(DIST_DIR);
  const bundle = uiBundleState({ srcDir: SRC_DIR, distDir: DIST_DIR });
  if (bundle.state === "stale") console.warn(`UI bundle is older than ui/src (${bundle.newest}) — run \`npm run build:ui\``);
  const token = crypto.randomBytes(32).toString("base64url");
  const server = createUiServer({ port, token, distDir: DIST_DIR, host });
  await new Promise((resolve, reject) => {
    server.once("error", (/** @type {NodeJS.ErrnoException} */ e) =>
      reject(e.code === "EADDRINUSE" ? new Error(`port ${port} is already in use — pick another with --port <n>`) : e),
    );
    server.listen(port, host, () => resolve(undefined));
  });
  const urls = uiUrls(host, port, token);
  for (const u of urls) console.log(`agenthook ui at ${u}`);
  if (host !== "127.0.0.1") {
    console.warn(`bound to ${host}: the dashboard is reachable from the network over plain HTTP, and the token above is its only credential — anyone who has it can edit configs and drive agents. Keep it to a trusted LAN.`);
  }
  console.log("Ctrl-C to stop.");
  if (!args["no-open"]) openBrowser(urls[0]);
}
