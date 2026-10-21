import "./_setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCloudflaredIngress, quickUrlFromLog, connectedFromLog, bareHostname } from "../src/ingress/cloudflared.js";
import { createIngress } from "../src/ingress/index.js";
import { ingressChecks } from "../src/commands/doctor.js";

// A real quick-tunnel start (cloudflared 2024.x logs to stderr).
const QUICK_LOG = `2024-06-01T10:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms. If you intend to use Tunnels in production you should use a pre-created named tunnel by following: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks
2024-06-01T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2024-06-01T10:00:01Z INF +--------------------------------------------------------------------------------------------+
2024-06-01T10:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2024-06-01T10:00:01Z INF |  https://seasonal-deck-organisms-sf.trycloudflare.com                                      |
2024-06-01T10:00:01Z INF +--------------------------------------------------------------------------------------------+
2024-06-01T10:00:01Z INF Cannot determine default configuration path. No file [config.yml config.yaml] in [~/.cloudflared ~/.cloudflare-warp ~/cloudflare-warp /etc/cloudflared /usr/local/etc/cloudflared]
2024-06-01T10:00:01Z INF Version 2024.6.0
2024-06-01T10:00:01Z INF Generated Connector ID: 5b0f8f1e-4c2a-4b4f-9d0e-1f2a3b4c5d6e
2024-06-01T10:00:01Z INF Initial protocol quic
2024-06-01T10:00:01Z INF Starting metrics server on 127.0.0.1:41357/metrics
`;
const QUICK_REGISTERED = "2024-06-01T10:00:02Z INF Registered tunnel connection connIndex=0 connection=0e5d7c1a-8b3f-4e2d-9a6c-7f1e2d3c4b5a event=0 ip=198.41.200.13 location=sjc08 protocol=quic\n";
const NAMED_LOG = `2024-06-01T10:00:00Z INF Starting tunnel tunnelID=6ff42ae2-765d-4adf-8112-31c55c1551ef
2024-06-01T10:00:00Z INF Version 2024.6.0
2024-06-01T10:00:00Z INF Settings: map[no-autoupdate:true url:http://127.0.0.1:4124]
2024-06-01T10:00:01Z INF Registered tunnel connection connIndex=0 connection=a1b2c3d4-0000-4000-8000-000000000000 event=0 ip=198.41.192.7 location=fra13 protocol=quic
2024-06-01T10:00:01Z INF Registered tunnel connection connIndex=1 connection=a1b2c3d4-0000-4000-8000-000000000001 event=0 ip=198.41.200.33 location=ams08 protocol=quic
`;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ah-cloudflared-"));

/** A fake `cloudflared`: records its pid + argv, prints `stderr`, then either exits, sleeps, or
 * (with `exitAfterMs`) sleeps briefly and then exits — simulating a post-connect crash.
 * @param {string} dir @param {string} stderr @param {{ exit?: number, exitAfterMs?: number }} [o] */
function fake(dir, stderr, { exit, exitAfterMs } = {}) {
  const bin = path.join(dir, "cloudflared");
  const tail = exitAfterMs != null ? `sleep ${exitAfterMs / 1000}\nexit 1` : exit == null ? "exec sleep 60" : `exit ${exit}`;
  const body = ["#!/bin/sh", `echo $$ > "${dir}/pid"`, `echo "$@" > "${dir}/args"`, `cat >&2 <<'EOF'\n${stderr}EOF`, tail].join("\n");
  fs.writeFileSync(bin, body + "\n", { mode: 0o755 });
  return bin;
}

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} dir @param {Record<string, any>} [ingress] */
const cfgFor = (dir, ingress = {}) => /** @type {any} */ ({ logDir: path.join(dir, "logs"), port: 4124, ingress: { type: "cloudflared", ...ingress } });

/** @param {string} bin @param {() => Promise<void>} fn */
async function withBin(bin, fn) {
  const prev = process.env.CLOUDFLARED;
  process.env.CLOUDFLARED = bin;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.CLOUDFLARED;
    else process.env.CLOUDFLARED = prev;
  }
}

test("quickUrlFromLog: the banner URL, not the scheme-less request line or other links", () => {
  assert.equal(quickUrlFromLog(QUICK_LOG), "https://seasonal-deck-organisms-sf.trycloudflare.com");
  assert.equal(quickUrlFromLog(QUICK_LOG.split("\n").slice(0, 2).join("\n")), null);
  assert.equal(quickUrlFromLog(""), null);
});

test("connectedFromLog: true only once an edge connection is registered (quick and named)", () => {
  assert.equal(connectedFromLog(QUICK_LOG), false);
  assert.equal(connectedFromLog(QUICK_LOG + QUICK_REGISTERED), true);
  assert.equal(connectedFromLog(NAMED_LOG), true);
  assert.equal(connectedFromLog(NAMED_LOG.split("\n").slice(0, 3).join("\n")), false);
});

test("bareHostname: strips scheme and trailing slashes", () => {
  assert.equal(bareHostname("https://hook.example.com/"), "hook.example.com");
  assert.equal(bareHostname(" hook.example.com "), "hook.example.com");
  assert.equal(bareHostname(undefined), "");
});

test("describe: quick is ephemeral, named is stable; registry resolves cloudflared", () => {
  const dir = tmp();
  assert.deepEqual(createCloudflaredIngress(cfgFor(dir)).describe(), { name: "cloudflared", ephemeral: true });
  assert.deepEqual(createCloudflaredIngress(cfgFor(dir, { tunnel: "t", hostname: "h.example.com" })).describe(), { name: "cloudflared", ephemeral: false });
  assert.equal(createIngress(/** @type {any} */ ({ ingress: { type: "cloudflared" } })).describe().name, "cloudflared");
});

test("quick: resolves the trycloudflare URL once connected; logs to <logDir>/cloudflared.log", async () => {
  const dir = tmp();
  await withBin(fake(dir, QUICK_LOG + QUICK_REGISTERED), async () => {
    const ing = createCloudflaredIngress(cfgFor(dir), { timeoutMs: 5000 });
    const { url } = await ing.up(4124);
    assert.equal(url, "https://seasonal-deck-organisms-sf.trycloudflare.com");
    assert.equal(fs.readFileSync(path.join(dir, "args"), "utf8").trim(), "tunnel --no-autoupdate --url http://127.0.0.1:4124");
    const pid = Number(fs.readFileSync(path.join(dir, "pid"), "utf8"));
    await ing.down();
    assert.equal(isAlive(pid), false);
    assert.match(fs.readFileSync(path.join(dir, "logs", "cloudflared.log"), "utf8"), /Your quick Tunnel has been created/);
  });
});

test("quick: a URL without a registered connection is not enough — times out", async () => {
  const dir = tmp();
  await withBin(fake(dir, QUICK_LOG), async () => {
    await assert.rejects(createCloudflaredIngress(cfgFor(dir), { timeoutMs: 400 }).up(4124), /no tunnel connection/);
  });
});

test("startup timeout: rejects with the last log lines and kills the fake", async () => {
  const dir = tmp();
  await withBin(fake(dir, "2024-06-01T10:00:00Z INF Starting tunnel\n2024-06-01T10:00:01Z ERR failed to dial edge: i/o timeout\n"), async () => {
    const t0 = Date.now();
    await assert.rejects(createCloudflaredIngress(cfgFor(dir), { timeoutMs: 400 }).up(4124), (e) => {
      assert.match(e.message, /quick tunnel, port 4124/);
      assert.match(e.message, /ERR failed to dial edge: i\/o timeout/);
      return true;
    });
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(isAlive(Number(fs.readFileSync(path.join(dir, "pid"), "utf8"))), false);
  });
});

test("child exits before connecting: rejects at once with its output", async () => {
  const dir = tmp();
  await withBin(fake(dir, "2024-06-01T10:00:00Z ERR Error validating origin URL\n", { exit: 1 }), async () => {
    const t0 = Date.now();
    await assert.rejects(createCloudflaredIngress(cfgFor(dir), { timeoutMs: 10_000 }).up(4124), /exited \(1\) before connecting[\s\S]*Error validating origin URL/);
    assert.ok(Date.now() - t0 < 5000);
  });
});

test("missing binary: rejects immediately with install hints", async () => {
  const dir = tmp();
  await withBin("/nonexistent/cloudflared", async () => {
    const t0 = Date.now();
    await assert.rejects(createCloudflaredIngress(cfgFor(dir), { timeoutMs: 10_000 }).up(4124), (e) => {
      assert.match(e.message, /brew install cloudflared/);
      assert.match(e.message, /winget/);
      return true;
    });
    assert.ok(Date.now() - t0 < 2000);
  });
});

test("named: returns https://<hostname> once connected, with run --url <target> <tunnel>", async () => {
  const dir = tmp();
  await withBin(fake(dir, NAMED_LOG), async () => {
    const ing = createCloudflaredIngress(cfgFor(dir, { tunnel: "agenthook", hostname: "https://hook.example.com/" }), { timeoutMs: 5000 });
    assert.deepEqual(await ing.up(4124), { url: "https://hook.example.com" });
    assert.equal(fs.readFileSync(path.join(dir, "args"), "utf8").trim(), "tunnel --no-autoupdate run --url http://127.0.0.1:4124 agenthook");
    await ing.down();
  });
});

test("named: tunnel without hostname (or the reverse) rejects before spawning", async () => {
  const dir = tmp();
  await withBin(fake(dir, NAMED_LOG), async () => {
    await assert.rejects(createCloudflaredIngress(cfgFor(dir, { tunnel: "agenthook" })).up(4124), /both ingress\.tunnel and ingress\.hostname/);
    await assert.rejects(createCloudflaredIngress(cfgFor(dir, { hostname: "hook.example.com" })).up(4124), /both ingress\.tunnel and ingress\.hostname/);
    assert.equal(fs.existsSync(path.join(dir, "pid")), false);
  });
});

test("down: kills only our child; idempotent and a no-op before up", async () => {
  const dir = tmp();
  await createCloudflaredIngress(cfgFor(dir)).down();
  const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    await withBin(fake(dir, NAMED_LOG), async () => {
      const ing = createCloudflaredIngress(cfgFor(dir, { tunnel: "agenthook", hostname: "hook.example.com" }), { timeoutMs: 5000 });
      await ing.up(4124);
      const pid = Number(fs.readFileSync(path.join(dir, "pid"), "utf8"));
      assert.equal(isAlive(pid), true);
      await ing.down();
      await ing.down();
      assert.equal(isAlive(pid), false);
      assert.equal(isAlive(/** @type {number} */ (sleeper.pid)), true);
    });
  } finally {
    sleeper.kill("SIGKILL");
  }
});

test("doctor ingressChecks: cloudflared checks its binary and never demands ingress.url", () => {
  const has = () => true;
  assert.deepEqual(ingressChecks({ type: "cloudflared" }, has).map(({ ok, label }) => ({ ok, label })), [{ ok: true, label: "cloudflared binary on PATH" }]);
  assert.equal(ingressChecks({ type: "cloudflared" }, () => false)[0].ok, false);
  const half = ingressChecks({ type: "cloudflared", tunnel: "agenthook" }, has);
  assert.equal(half[1].ok, false);
  assert.match(String(half[1].note), /hostname/);
  assert.ok(ingressChecks({ type: "cloudflared", tunnel: "agenthook", hostname: "hook.example.com" }, has).every((c) => c.ok));
  assert.equal(ingressChecks({ type: "manual" }, has)[0].ok, false);
  assert.equal(ingressChecks({ type: "ngrok" }, has)[0].label, "ngrok binary on PATH");
});

test("onExit: a post-connect crash fires the listener once with a reason; down() does not", async () => {
  const dir = tmp();
  await withBin(fake(dir, QUICK_LOG + QUICK_REGISTERED, { exitAfterMs: 300 }), async () => {
    const ing = createCloudflaredIngress(cfgFor(dir), { timeoutMs: 5000 });
    /** @type {string[]} */
    const reasons = [];
    ing.onExit((reason) => reasons.push(reason));
    await ing.up(4124);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /exited/);
  });
});

test("onExit: does not fire on down(), and not on a pre-connect exit (that only rejects up())", async () => {
  const dir = tmp();
  await withBin(fake(dir, QUICK_LOG + QUICK_REGISTERED), async () => {
    const ing = createCloudflaredIngress(cfgFor(dir), { timeoutMs: 5000 });
    const reasons = [];
    ing.onExit((reason) => reasons.push(reason));
    await ing.up(4124);
    await ing.down();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(reasons.length, 0);
  });

  const dir2 = tmp();
  await withBin(fake(dir2, "2024-06-01T10:00:00Z ERR boom\n", { exit: 1 }), async () => {
    const ing = createCloudflaredIngress(cfgFor(dir2), { timeoutMs: 5000 });
    const reasons = [];
    ing.onExit((reason) => reasons.push(reason));
    await assert.rejects(ing.up(4124));
    assert.equal(reasons.length, 0);
  });
});
