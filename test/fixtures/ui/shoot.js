#!/usr/bin/env node
// Screenshot a running `ah ui` in headless Chrome over the DevTools protocol (README.md here).
// Zero deps: Node 22's global WebSocket talks CDP. Plain `--screenshot` can't be used reliably —
// `--virtual-time-budget` never settles while the SSE stream is open, and without it the shot
// races the snapshot fetch — so this waits for a selector before capturing.
//
//   node test/fixtures/ui/shoot.js '<?token= URL>' <out.png> [--scheme dark|light]
//     [--size 1440x900] [--wait <css selector>] [--click <css selector>] [--chrome <bin>]
//
// `--click` waits for its selector, clicks the first match, then waits for `--wait` (e.g. open the
// ticket drawer: `--click '[data-ticket-row="221"]' --wait '[data-drawer] pre'`).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
/** @param {string} name @param {string} def */
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const scheme = opt("scheme", "dark");
const [width, height] = opt("size", "1440x900").split("x").map(Number);
const waitFor = opt("wait", "table tbody tr");
const click = opt("click", "");
const chrome = opt("chrome", "google-chrome");
const [url, out] = argv;
if (!url || !out) {
  console.error("usage: node test/fixtures/ui/shoot.js '<url>' <out.png> [--scheme dark|light] [--size WxH] [--wait <selector>] [--click <selector>]");
  process.exit(2);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ah-shoot-"));
const proc = spawn(
  chrome,
  ["--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run", `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--window-size=${width},${height}`, "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] },
);

/** The DevTools ws URL Chrome prints on stderr. @returns {Promise<string>} */
const devtoolsUrl = () =>
  new Promise((resolve, reject) => {
    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    proc.on("exit", (c) => reject(new Error(`chrome exited ${c}: ${buf}`)));
  });

/** @param {string} wsUrl */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  /** @type {Map<number, (msg: any) => void>} */
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  };
  /** @param {string} method @param {Record<string, any>} [params] @param {string} [sessionId] @returns {Promise<any>} */
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ws, send };
}

let code = 0;
/** @type {Awaited<ReturnType<typeof connect>>|null} */
let cdp = null;
try {
  cdp = await connect(await devtoolsUrl());
  const { send } = cdp;
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  /** @param {string} m @param {Record<string, any>} [p] */
  const s = (m, p) => send(m, p, sessionId);
  await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await s("Page.enable");
  await s("Page.navigate", { url });
  /** Poll until `sel` matches (15 s). @param {string} sel */
  const waitSel = async (sel) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const { result } = await s("Runtime.evaluate", { expression: `!!document.querySelector(${JSON.stringify(sel)})`, returnByValue: true });
      if (result.value) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${sel}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  if (click) {
    await waitSel(click);
    await s("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(click)}).click()` });
  }
  await waitSel(waitFor);
  await new Promise((r) => setTimeout(r, 500)); // fonts + SSE open → the connection dot settles
  const { data } = await s("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`wrote ${out} (${scheme}, ${width}x${height})`);
} catch (e) {
  console.error(e.message);
  code = 1;
} finally {
  // `google-chrome` is a wrapper script: killing it leaves the browser running, so ask the browser
  // itself to quit, and remove its profile only once it has (it writes there until exit).
  const exited = new Promise((r) => proc.once("exit", r));
  if (cdp) await cdp.send("Browser.close").catch(() => {});
  else proc.kill();
  await exited;
  cdp?.ws.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
process.exit(code);
