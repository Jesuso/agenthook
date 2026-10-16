import "./_setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickTunnel, webAddrFromLog } from "../src/ingress/ngrok.js";

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
