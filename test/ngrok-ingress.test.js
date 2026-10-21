import "./_setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickTunnel, webAddrFromLog, createNgrokIngress } from "../src/ingress/ngrok.js";

const t = (/** @type {string} */ url, /** @type {number} */ port) => ({ public_url: url, config: { addr: `http://localhost:${port}` } });

test("pickTunnel: the tunnel forwarding to our port, never another profile's", () => {
  // Seen live: our configured web API belonged to the cahui agent, whose only tunnel is on 4125.
  const other = [t("https://together-caring-skunk.ngrok-free.app", 4125)];
  assert.equal(pickTunnel(other, 4124), null);
  const both = [t("https://a.ngrok-free.app", 4125), t("https://b.ngrok-free.app/", 4124)];
  assert.equal(pickTunnel(both, 4124), "https://b.ngrok-free.app");
});

test("pickTunnel: ignores http tunnels, trailing slashes and garbage; port is matched whole", () => {
  assert.equal(pickTunnel([{ public_url: "http://x.ngrok.io", config: { addr: "http://localhost:4124" } }], 4124), null);
  assert.equal(pickTunnel([t("https://x.ngrok.io", 41240)], 4124), null);
  assert.equal(pickTunnel([{ public_url: "https://x.ngrok.io", config: { addr: "http://localhost:4124/" } }], 4124), "https://x.ngrok.io");
  assert.equal(pickTunnel([null, {}, { public_url: 5 }], 4124), null);
  assert.equal(pickTunnel(undefined, 4124), null);
});

test("pickTunnel: a configured domain must match the host", () => {
  const tunnels = [t("https://random.ngrok-free.app", 4124)];
  assert.equal(pickTunnel(tunnels, 4124, "mine.ngrok-free.app"), null);
  assert.equal(pickTunnel(tunnels, 4124, "random.ngrok-free.app"), "https://random.ngrok-free.app");
});

test("webAddrFromLog: reads the address ngrok bound after falling back from 4040", () => {
  const log = [
    'lvl=warn msg="can\'t bind default web address, trying alternatives" obj=web addr=127.0.0.1:4040',
    'lvl=info msg="starting web service" obj=web addr=127.0.0.1:4042 allow_hosts=[]',
  ].join("\n");
  assert.equal(webAddrFromLog(log), "127.0.0.1:4042");
  assert.equal(webAddrFromLog("nothing yet"), null);
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ah-ngrok-"));

/** A fake `ngrok`: a node script serving its local web API so `waitForUrl` finds our tunnel,
 * optionally exiting after `exitAfterMs` to simulate a post-connect crash.
 * @param {string} dir @param {{ webPort: number, exitAfterMs?: number }} o */
function fake(dir, { webPort, exitAfterMs }) {
  const bin = path.join(dir, "ngrok");
  const body = `#!/usr/bin/env node
const http = require("node:http");
const port = process.argv[3];
console.log('lvl=info msg="starting web service" obj=web addr=127.0.0.1:${webPort}');
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ tunnels: [{ public_url: "https://fake.ngrok-free.app", config: { addr: \`http://localhost:\${port}\` } }] }));
});
server.listen(${webPort}, "127.0.0.1", () => {
  ${exitAfterMs != null ? `setTimeout(() => process.exit(1), ${exitAfterMs});` : ""}
});
`;
  fs.writeFileSync(bin, body, { mode: 0o755 });
  return bin;
}

/** @param {string} bin @param {() => Promise<void>} fn */
async function withBin(bin, fn) {
  const prev = process.env.NGROK;
  process.env.NGROK = bin;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.NGROK;
    else process.env.NGROK = prev;
  }
}

/** @param {string} dir @param {number} webPort */
const cfgFor = (dir, webPort) => {
  const logDir = path.join(dir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  return /** @type {any} */ ({ logDir, ingress: { type: "ngrok", webAddr: `127.0.0.1:${webPort}` } });
};

test("onExit: a post-connect crash fires the listener once with a reason; down() does not", async () => {
  const dir = tmp();
  await withBin(fake(dir, { webPort: 41401, exitAfterMs: 1500 }), async () => {
    const ing = createNgrokIngress(cfgFor(dir, 41401));
    /** @type {string[]} */
    const reasons = [];
    ing.onExit((reason) => reasons.push(reason));
    await ing.up(4124);
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /exited/);
  });
});

test("onExit: does not fire on down()", async () => {
  const dir = tmp();
  await withBin(fake(dir, { webPort: 41402 }), async () => {
    const ing = createNgrokIngress(cfgFor(dir, 41402));
    /** @type {string[]} */
    const reasons = [];
    ing.onExit((reason) => reasons.push(reason));
    await ing.up(4125);
    await ing.down();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(reasons.length, 0);
  });
});
