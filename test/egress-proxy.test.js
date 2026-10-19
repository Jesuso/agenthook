import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The sandbox egress proxy (src/sandbox/egress-proxy.mjs): its pure rule matcher, and the real
// proxy process spawned with node on the host against local servers (no container needed).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { egressAllowed, parseRule, isPrivateAddress } from "../src/sandbox/egress-proxy.mjs";

const PROXY = fileURLToPath(new URL("../src/sandbox/egress-proxy.mjs", import.meta.url));

test("parseRule: host (443), *.domain, host:port, [v6]:port, !private; malformed throws", () => {
  assert.deepEqual(parseRule("api.github.com"), { host: "api.github.com", wildcard: false, port: 443, allowPrivate: false });
  assert.deepEqual(parseRule("*.githubusercontent.com"), { host: "githubusercontent.com", wildcard: true, port: 443, allowPrivate: false });
  assert.deepEqual(parseRule("registry.local:8443"), { host: "registry.local", wildcard: false, port: 8443, allowPrivate: false });
  assert.deepEqual(parseRule("10.0.0.5:3128!private"), { host: "10.0.0.5", wildcard: false, port: 3128, allowPrivate: true });
  assert.deepEqual(parseRule("[FD00::1]:8443"), { host: "fd00::1", wildcard: false, port: 8443, allowPrivate: false });
  assert.equal(parseRule("Example.COM.").host, "example.com");
  for (const bad of ["", "*", "*.", "http://x.com", "x.com/path", "x.com:0", "x.com:70000", "a b", "::1", "*.10.0.0.5", "x.com:", "-x.com", 42]) {
    assert.throws(() => parseRule(/** @type {any} */ (bad)), /egress rule/, String(bad));
  }
});

test("egressAllowed: exact host, *.x vs apex, explicit port vs default 443, case and trailing dot", () => {
  const rules = ["api.github.com", "*.githubusercontent.com", "registry.local:8443"];
  assert.equal(egressAllowed("api.github.com", 443, rules)?.host, "api.github.com");
  assert.equal(egressAllowed("API.GitHub.com.", 443, rules)?.host, "api.github.com");
  assert.equal(egressAllowed("api.github.com", 80, rules), null, "443 only unless a port is named");
  assert.equal(egressAllowed("evil-api.github.com", 443, rules), null);
  assert.equal(egressAllowed("objects.githubusercontent.com", 443, rules)?.wildcard, true);
  assert.equal(egressAllowed("a.b.githubusercontent.com", 443, rules)?.wildcard, true, "one or more labels");
  assert.equal(egressAllowed("githubusercontent.com", 443, rules), null, "a wildcard is not the apex");
  assert.equal(egressAllowed("xgithubusercontent.com", 443, rules), null);
  assert.equal(egressAllowed("registry.local", 8443, rules)?.port, 8443);
  assert.equal(egressAllowed("registry.local", 443, rules), null);
});

test("egressAllowed: an IP literal is denied unless a rule names that literal", () => {
  assert.equal(egressAllowed("140.82.112.3", 443, ["api.github.com", "*.github.com"]), null);
  assert.equal(egressAllowed("140.82.112.3", 443, ["140.82.112.3"])?.host, "140.82.112.3");
  assert.equal(egressAllowed("[2001:db8::1]", 443, ["[2001:db8:0::1]"])?.host, "2001:db8:0::1", "v6 compared canonically");
  assert.equal(egressAllowed("[2001:db8::2]", 443, ["[2001:db8::1]"]), null);
});

test("isPrivateAddress: loopback, link-local, RFC1918, ULA (and v4-mapped); a public IP is not", () => {
  for (const ip of ["127.0.0.1", "127.255.0.9", "::1", "169.254.169.254", "fe80::1", "febf::1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "0.0.0.0", "::", "100.64.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "140.82.112.3", "172.32.0.1", "192.169.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "fec0::1"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("isPrivateAddress: NAT64 (64:ff9b::/96) and 6to4 (2002::/16) unwrap to their embedded IPv4", () => {
  for (const ip of ["64:ff9b::a9fe:a9fe", "64:ff9b::0a00:0005", "64:ff9b::169.254.169.254", "2002:a9fe:a9fe::1", "2002:0a00:0005::1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["64:ff9b::0808:0808", "2002:0808:0808::1"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

// --- the real proxy, spawned with node on the host ---

/** @returns {Promise<number>} a free TCP port */
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const a = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(a.port));
    });
    s.on("error", reject);
  });

/** A plain TCP echo server on 127.0.0.1. @returns {Promise<{port: number, close: () => void}>} */
const echoServer = () =>
  new Promise((resolve) => {
    const s = net.createServer((c) => c.pipe(c)).listen(0, "127.0.0.1", () => resolve({ port: /** @type {net.AddressInfo} */ (s.address()).port, close: () => s.close() }));
  });

/** Send `CONNECT target`, return the response head + body (up to close or `then` bytes echoed).
 * @param {number} proxyPort @param {string} target @param {string} [payload] */
function connectVia(proxyPort, target, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, "127.0.0.1", () => sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = "";
    let sent = false;
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      buf += d;
      if (!sent && payload && buf.startsWith("HTTP/1.1 200") && buf.includes("\r\n\r\n")) {
        sent = true;
        sock.write(payload);
      }
      if (sent && buf.endsWith(/** @type {string} */ (payload))) {
        sock.end();
        resolve(buf);
      }
    });
    sock.on("end", () => resolve(buf));
    sock.on("error", reject);
  });
}

/** Start the proxy over `rules`; resolves once `ready` exists. @param {string[]} rules @param {Record<string,string>} [env] */
async function startProxy(rules, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-egress-"));
  fs.writeFileSync(path.join(dir, "allow.json"), JSON.stringify({ rules }));
  const port = await freePort();
  const child = spawn(process.execPath, [PROXY, dir], { env: { ...process.env, EGRESS_PORT: String(port), ...env }, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 200 && !fs.existsSync(path.join(dir, "ready")); i++) await new Promise((r) => setTimeout(r, 25));
  const denied = () => (fs.existsSync(path.join(dir, "denied.jsonl")) ? fs.readFileSync(path.join(dir, "denied.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const exited = new Promise((resolve) => child.on("exit", resolve));
  return { dir, port, denied, stop: () => child.kill("SIGTERM"), exited };
}

test("proxy: ready appears; an allowed CONNECT is piped; a denied one gets the 403 and a denied.jsonl line", { timeout: 20000 }, async () => {
  const echo = await echoServer();
  const p = await startProxy([`127.0.0.1:${echo.port}!private`, `localhost:${echo.port}`]);
  try {
    assert.ok(fs.existsSync(path.join(p.dir, "ready")), "ready written once listening");

    const piped = await connectVia(p.port, `127.0.0.1:${echo.port}`, "ping-123");
    assert.match(piped, /^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    assert.ok(piped.endsWith("ping-123"), "bytes go both ways");

    const denied = await connectVia(p.port, "example.invalid:443");
    assert.match(denied, /^HTTP\/1\.1 403 Forbidden\r\n/);
    assert.match(denied, /\r\nX-Agenthook-Egress: denied\r\n/);
    assert.ok(denied.endsWith("agenthook egress: example.invalid:443 is not in this sandbox's allowlist (add it to sandbox.egress.allow)\n"), denied);
    assert.deepEqual(p.denied().map((d) => [d.host, d.port]), [["example.invalid", 443]]);
    assert.match(p.denied()[0].at, /^\d{4}-\d\d-\d\dT/);
  } finally {
    p.stop();
    echo.close();
  }
});

test("proxy: an IP literal with no rule is denied; an allowlisted name resolving to loopback is refused without !private", { timeout: 20000 }, async () => {
  const echo = await echoServer();
  const p = await startProxy([`localhost:${echo.port}`]);
  try {
    const ip = await connectVia(p.port, `127.0.0.1:${echo.port}`);
    assert.match(ip, /^HTTP\/1\.1 403 /);
    // Real resolver: localhost → 127.0.0.1/::1, which the rule (no !private) may not reach.
    const local = await connectVia(p.port, `localhost:${echo.port}`);
    assert.match(local, /^HTTP\/1\.1 403 /);
    assert.match(local, /localhost:\d+ is not in this sandbox's allowlist/);
    assert.deepEqual(p.denied().map((d) => d.host), ["127.0.0.1", "localhost"]);
  } finally {
    p.stop();
    echo.close();
  }
});

test("proxy: plain-HTTP absolute-URI requests are checked the same way (port 80 needs a rule)", { timeout: 20000 }, async () => {
  const p = await startProxy([]);
  try {
    const res = await fetch(`http://127.0.0.1:${p.port}/`, { method: "GET" }).catch(() => null);
    assert.equal(res?.status, 400, "an origin-form request is not proxied");
    const body = await new Promise((resolve, reject) => {
      const sock = net.connect(p.port, "127.0.0.1", () => sock.write("GET http://example.invalid/x HTTP/1.1\r\nHost: example.invalid\r\nConnection: close\r\n\r\n"));
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (d) => (buf += d));
      sock.on("end", () => resolve(buf));
      sock.on("error", reject);
    });
    assert.match(/** @type {string} */ (body), /^HTTP\/1\.1 403 /);
    assert.match(/** @type {string} */ (body), /x-agenthook-egress: denied/i);
    assert.match(/** @type {string} */ (body), /example\.invalid:80 is not in this sandbox's allowlist/);
    assert.deepEqual(p.denied().map((d) => [d.host, d.port]), [["example.invalid", 80]]);
  } finally {
    p.stop();
  }
});

test("proxy: an allowed plain-HTTP request is forwarded with its path and method", { timeout: 20000 }, async () => {
  const http = await import("node:http");
  const origin = http.createServer((req, res) => res.end(`${req.method} ${req.url} host=${req.headers.host}`));
  await new Promise((r) => origin.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {net.AddressInfo} */ (origin.address()).port;
  const p = await startProxy([`127.0.0.1:${port}!private`]);
  try {
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: p.port, method: "POST", path: `http://127.0.0.1:${port}/a/b?c=1` }, (res) => {
        let b = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve(`${res.statusCode} ${b}`));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(body, `200 POST /a/b?c=1 host=127.0.0.1:${port}`);
    assert.deepEqual(p.denied(), []);
  } finally {
    p.stop();
    origin.close();
  }
});

test("proxy: denied.jsonl stops at a line cap; SIGTERM appends a {truncated} summary", { timeout: 20000 }, async () => {
  const limit = 5;
  const p = await startProxy([], { EGRESS_DENIED_LOG_MAX_LINES: String(limit) });
  try {
    const sent = limit + 3;
    for (let i = 0; i < sent; i++) await connectVia(p.port, `denied-${i}.invalid:443`);
    const beforeStop = p.denied();
    assert.equal(beforeStop.length, limit, "writes stop at the line cap");
    p.stop();
    await p.exited;
    const after = p.denied();
    assert.equal(after.length, limit + 1, "one summary line is appended past the cap");
    assert.deepEqual(after[limit], { truncated: sent - limit });
  } finally {
    p.stop();
  }
});
