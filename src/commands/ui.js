// `agenthook ui [--port 4180] [--no-open]` — local read-only web dashboard over every
// profile under ~/.agenthook (docs/web-ui.md). Binds 127.0.0.1 only (no flag to change
// it), mints a per-launch token and prints/opens the `?token=` URL. Loads no config:
// like `ls`, it reads the state dirs directly.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createUiServer } from "../ui/server.js";

export const DEFAULT_PORT = 4180;

/** The bundled frontend, resolved from the install dir (built by `npm run build:ui`). */
const DIST_DIR = fileURLToPath(new URL("../../ui/dist/", import.meta.url));

/** `--port` → a TCP port; absent → 4180. Throws on a missing/non-integer/out-of-range value.
 * @param {Record<string, any>} args */
export function uiPort(args) {
  if (!("port" in args)) return DEFAULT_PORT;
  const s = String(args.port ?? "");
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid --port "${args.port ?? ""}" — expected an integer 1-65535`);
  return n;
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
  checkBundle(DIST_DIR);
  const token = crypto.randomBytes(32).toString("base64url");
  const server = createUiServer({ port, token, distDir: DIST_DIR });
  await new Promise((resolve, reject) => {
    server.once("error", (/** @type {NodeJS.ErrnoException} */ e) =>
      reject(e.code === "EADDRINUSE" ? new Error(`port ${port} is already in use — pick another with --port <n>`) : e),
    );
    server.listen(port, "127.0.0.1", () => resolve(undefined));
  });
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  console.log(`agenthook ui (read-only) at ${url}`);
  console.log("Ctrl-C to stop.");
  if (!args["no-open"]) openBrowser(url);
}
