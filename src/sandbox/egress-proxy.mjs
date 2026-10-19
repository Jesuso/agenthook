// @ts-check
// The per-run egress proxy of a sandboxed run (docs/sandbox.md#egress). It runs in its own
// container, on the run's `--internal` network AND on the runtime's default network, so it is
// the agent's only way out. `node egress-proxy.mjs <dir>` reads `<dir>/allow.json`
// (`{ rules: string[] }`), listens on 0.0.0.0:3128 (EGRESS_PORT for tests), writes
// `<dir>/ready`, and then answers:
// - `CONNECT host:port` (HTTPS and anything tunnelled): piped when allowed;
// - absolute-URI plain HTTP (`GET http://host/…`): forwarded when allowed (port 80 needs a
//   `host:80` rule);
// anything else gets a 403 naming the host, and one line in `<dir>/denied.jsonl`.
// Rules match the REQUESTED hostname; the connection then goes to the address it resolved to,
// which must not be loopback, link-local (cloud metadata), RFC1918 or ULA unless the rule ends
// in `!private` — so an allowlisted name can't be pointed at the host's LAN.
// Standalone on purpose (`.mjs`, `node:` imports only): the container has no package.json.
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{host: string, wildcard: boolean, port: number, allowPrivate: boolean}} EgressRule */

const LABEL = "[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?";
const NAME_RE = new RegExp(`^(\\*\\.)?(${LABEL}(?:\\.${LABEL})*)\\.?(?::(\\d+))?$`);
const V6_RE = /^\[([0-9A-Fa-f:.]+)\](?::(\d+))?$/;

/** A hostname as rules compare it: lower case, no trailing dot, no IPv6 brackets. @param {string} h */
const normHost = (h) => h.toLowerCase().replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1");

/**
 * One allowlist rule: `host` (port 443), `*.domain` (any subdomain, not the apex), `host:port`,
 * an IP literal (`10.0.0.5`, `[fd00::1]:8443`), each optionally suffixed `!private` (the target
 * may resolve to a private address). Throws on anything else.
 * @param {string} rule @returns {EgressRule}
 */
export function parseRule(rule) {
  if (typeof rule !== "string") throw new Error(`egress rule must be a string, got ${JSON.stringify(rule)}`);
  let s = rule.trim();
  const allowPrivate = s.endsWith("!private");
  if (allowPrivate) s = s.slice(0, -"!private".length);
  const bad = () => new Error(`invalid egress rule ${JSON.stringify(rule)} (expected host, *.domain or host:port, optionally ending in !private)`);
  /** @type {string} */ let host;
  /** @type {string|undefined} */ let portText;
  let wildcard = false;
  const v6 = V6_RE.exec(s);
  if (v6) {
    if (net.isIPv6(v6[1]) === false) throw bad();
    [host, portText] = [v6[1].toLowerCase(), v6[2]];
  } else {
    const m = NAME_RE.exec(s);
    if (!m) throw bad();
    [wildcard, host, portText] = [!!m[1], m[2].toLowerCase(), m[3]];
    if (wildcard && net.isIP(host)) throw bad();
  }
  const port = portText === undefined ? 443 : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad();
  return { host, wildcard, port, allowPrivate };
}

/** @type {Map<string, EgressRule>} */
const parsed = new Map();
/** @param {string} r */
const cachedRule = (r) => {
  let p = parsed.get(r);
  if (!p) parsed.set(r, (p = parseRule(r)));
  return p;
};

/**
 * The rule that lets `host:port` through, or null. Case-insensitive, ignores a trailing dot. An
 * IP-literal target only matches a rule naming that exact literal (never a wildcard).
 * @param {string} host @param {number} port @param {string[]} rules @returns {EgressRule|null}
 */
export function egressAllowed(host, port, rules) {
  const h = normHost(host);
  const ip = net.isIP(h) !== 0;
  for (const r of rules) {
    const p = cachedRule(r);
    if (p.port !== port) continue;
    if (ip ? !p.wildcard && net.isIP(p.host) !== 0 && sameIp(p.host, h) : p.wildcard ? h.endsWith(`.${p.host}`) : h === p.host) return p;
  }
  return null;
}

/** @param {string} a @param {string} b */
const sameIp = (a, b) => (net.isIPv6(a) && net.isIPv6(b) ? expand6(a).join(":") === expand6(b).join(":") : a === b);

/** An IPv6 address as 8 numbers (an embedded dotted IPv4 tail becomes the last two). @param {string} ip */
function expand6(ip) {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    s = s.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, undefined];
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - a.length - b.length).fill("0");
  return [...a, ...fill, ...b].map((x) => parseInt(x, 16) || 0);
}

/** @param {string} ip @param {string} base @param {number} bits */
function inV4(ip, base, bits) {
  /** @param {string} x */
  const n = (x) => x.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
  const size = 2 ** (32 - bits);
  return Math.floor(n(ip) / size) === Math.floor(n(base) / size);
}

/**
 * Whether a connection to `ip` would reach the host or its LAN rather than the internet:
 * loopback (127/8, ::1), "this network" (0/8, ::), link-local (169.254/16 — cloud metadata —
 * and fe80::/10), RFC1918, shared CGNAT space (100.64/10, e.g. a tailnet) and ULA (fc00::/7).
 * An IPv4-mapped IPv6 address is judged by its IPv4 part.
 * @param {string} ip @returns {boolean}
 */
export function isPrivateAddress(ip) {
  const a = normHost(ip);
  if (net.isIPv4(a)) {
    return [["127.0.0.0", 8], ["0.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16], ["100.64.0.0", 10]].some(([b, bits]) => inV4(a, /** @type {string} */ (b), /** @type {number} */ (bits)));
  }
  if (!net.isIPv6(a)) return false;
  const w = expand6(a);
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return isPrivateAddress(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`);
  if (w.slice(0, 7).every((x) => x === 0) && (w[7] === 0 || w[7] === 1)) return true; // :: and ::1
  return (w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xfe00) === 0xfc00;
}

const DENY_HEADER = "X-Agenthook-Egress";

/** The 403 body a denied client sees (and the agent can quote). @param {string} host @param {number} port */
export const deniedBody = (host, port) => `agenthook egress: ${host}:${port} is not in this sandbox's allowlist (add it to sandbox.egress.allow)\n`;

/**
 * The address to connect to for an allowed `host:port`, or a refusal. Never resolves a host the
 * rules don't name; a private resolution is refused unless the matching rule allows it.
 * @param {string} host @param {number} port @param {string[]} rules
 * @param {(host: string) => Promise<string>} [lookup]
 * @returns {Promise<{address: string} | {denied: true} | {error: string}>}
 */
export async function resolveTarget(host, port, rules, lookup = defaultLookup) {
  const rule = egressAllowed(host, port, rules);
  if (!rule) return { denied: true };
  const h = normHost(host);
  let address = h;
  if (!net.isIP(h)) {
    try {
      address = await lookup(h);
    } catch (e) {
      return { error: `cannot resolve ${h}: ${e.code || e.message}` };
    }
  }
  if (!rule.allowPrivate && isPrivateAddress(address)) return { denied: true };
  return { address };
}

/** @param {string} host @returns {Promise<string>} */
const defaultLookup = (host) => dns.promises.lookup(host).then((r) => r.address);

/** @param {string} dir */
function startProxy(dir) {
  const { rules } = JSON.parse(fs.readFileSync(path.join(dir, "allow.json"), "utf8"));
  if (!Array.isArray(rules)) throw new Error("allow.json: rules must be an array");
  rules.forEach(parseRule); // fail at start, not on the first request
  const deniedFile = path.join(dir, "denied.jsonl");
  /** @param {string} host @param {number} port */
  const logDenied = (host, port) => {
    try {
      fs.appendFileSync(deniedFile, JSON.stringify({ at: new Date().toISOString(), host: normHost(host), port }) + "\n");
    } catch (e) {
      console.error(`[egress] could not record a denial: ${e.message}`);
    }
  };
  /** @param {string} host @param {number} port */
  const deniedHead = (host, port) => {
    const body = deniedBody(normHost(host), port);
    return { body, head: `HTTP/1.1 403 Forbidden\r\n${DENY_HEADER}: denied\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n` };
  };

  const server = http.createServer(async (req, res) => {
    /** @type {URL} */ let url;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("agenthook egress: only proxy requests (absolute http:// URLs or CONNECT) are served\n");
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400, { "Content-Type": "text/plain" }).end(`agenthook egress: ${url.protocol} is not proxied; use https:// (CONNECT)\n`);
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    const target = await resolveTarget(url.hostname, port, rules);
    if ("denied" in target) {
      logDenied(url.hostname, port);
      const { body } = deniedHead(url.hostname, port);
      res.writeHead(403, { [DENY_HEADER]: "denied", "Content-Type": "text/plain; charset=utf-8", Connection: "close" }).end(body);
      return;
    }
    if ("error" in target) {
      res.writeHead(502, { "Content-Type": "text/plain" }).end(`agenthook egress: ${target.error}\n`);
      return;
    }
    // An absolute-form request's target wins over its Host header (RFC 9112 §3.2.2).
    /** @type {import('node:http').OutgoingHttpHeaders} */
    const headers = { ...req.headers, host: url.host };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request({ host: target.address, port, method: req.method, path: url.pathname + url.search, headers, setHost: false }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`agenthook egress: upstream ${url.host} failed: ${e.message}\n`);
    });
    req.pipe(upstream);
  });

  server.on("connect", async (req, client, head) => {
    client.on("error", () => client.destroy());
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "");
    if (!m) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const [host, port] = [m[1], Number(m[2])];
    const target = await resolveTarget(host, port, rules);
    if ("denied" in target) {
      logDenied(host, port);
      const { head: h, body } = deniedHead(host, port);
      client.end(h + body);
      return;
    }
    if ("error" in target) {
      client.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nagenthook egress: ${target.error}\n`);
      return;
    }
    let connected = false;
    const upstream = net.connect({ host: target.address, port }, () => {
      connected = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (e) => {
      if (!connected && client.writable) client.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nagenthook egress: ${host}:${port} failed: ${e.message}\n`);
      else client.destroy();
    });
    client.on("close", () => upstream.destroy());
  });
  server.on("clientError", (_e, socket) => socket.destroy());

  const port = Number(process.env.EGRESS_PORT || 3128);
  server.listen(port, "0.0.0.0", () => {
    fs.writeFileSync(path.join(dir, "ready"), `${port}\n`);
    console.log(`[egress] listening on :${port} with ${rules.length} rule(s)`);
  });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node egress-proxy.mjs <dir>");
    process.exit(2);
  }
  startProxy(dir);
}
