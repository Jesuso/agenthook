// `ah ui` server — Host guard, token→cookie auth, snapshot, traversal-safe static files,
// and the "writes nothing" rule. Binds an ephemeral 127.0.0.1 port over a temp registry.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createUiServer, safeEqual, cookieToken } from "../src/ui/server.js";

const TOKEN = "t0k3n-abcdefghijklmnopqrstuvwxyz0123456789";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-server-"));
const distDir = path.join(root, "dist");
const registry = path.join(root, "registry");
fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>ah</title>");
fs.writeFileSync(path.join(distDir, "assets", "app.js"), "console.log(1)");
fs.writeFileSync(path.join(root, "package.json"), '{"secret":"outside-dist"}');
fs.mkdirSync(path.join(registry, "p"), { recursive: true });
fs.writeFileSync(path.join(registry, "p", "refmeta.json"), JSON.stringify({ 7: { displayId: "#7" } }));

const server = createUiServer({ port: 0, token: TOKEN, distDir, registry });
/** @type {number} */
let port;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const a = server.address();
  port = a && typeof a === "object" ? a.port : 0;
});
test.after(() => new Promise((r) => server.close(() => r(undefined))));

/**
 * Raw request (fetch can't set Host, and normalizes `..` paths).
 * @param {string} p @param {{ host?: string|null, cookie?: string, method?: string }} [o]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function req(p, { host, cookie, method = "GET" } = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (cookie) headers.cookie = cookie;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers, setHost: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    r.on("error", reject);
    const h = host === undefined ? `127.0.0.1:${port}` : host;
    if (h !== null) r.setHeader("host", h);
    r.end();
  });
}

const good = () => `ah_ui=${TOKEN}`;

test("safeEqual / cookieToken", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(cookieToken("x=1; ah_ui=tok; y=2"), "tok");
  assert.equal(cookieToken("x=1"), null);
  assert.equal(cookieToken(undefined), null);
});

test("token exchange: bad → 401, good → 302 / with a strict HttpOnly cookie", async () => {
  assert.equal((await req("/?token=nope")).status, 401);
  assert.equal((await req("/?token=")).status, 401);
  assert.equal((await req(`/?token=${TOKEN}x`)).status, 401);
  const ok = await req(`/?token=${TOKEN}`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, "/");
  assert.deepEqual(ok.headers["set-cookie"], [`ah_ui=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`]);
});

test("/api/snapshot needs the cookie; with it → 200 JSON {profiles, tickets}", async () => {
  assert.equal((await req("/api/snapshot")).status, 401);
  assert.equal((await req("/api/snapshot", { cookie: "ah_ui=wrong" })).status, 401);
  assert.equal((await req("/api/snapshot", { cookie: `other=${TOKEN}` })).status, 401);
  const res = await req("/api/snapshot", { cookie: `x=1; ${good()}` });
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /^application\/json/);
  assert.equal(res.headers["cache-control"], "no-store");
  const snap = JSON.parse(res.body);
  assert.deepEqual(Object.keys(snap).sort(), ["profiles", "tickets"]);
  assert.equal(snap.profiles[0].name, "p");
  assert.equal(snap.tickets[0].displayId, "#7");
  // Encoded /api paths still hit the auth gate, not the static handler.
  assert.equal((await req("/%61pi/snapshot")).status, 401);
});

test("unknown /api → 404 (after auth); non-GET → 405", async () => {
  assert.equal((await req("/api/nope", { cookie: good() })).status, 404);
  assert.equal((await req("/api/nope")).status, 401);
  assert.equal((await req("/api/snapshot", { cookie: good(), method: "POST" })).status, 405);
  assert.equal((await req("/", { method: "DELETE" })).status, 405);
});

test("Host guard: anything but 127.0.0.1:<port> / localhost:<port> → 403, even with a valid cookie", async () => {
  for (const host of ["evil.com:" + port, `127.0.0.1:${port + 1}`, "127.0.0.1", `localhost.evil.com:${port}`, ""]) {
    assert.equal((await req("/api/snapshot", { host, cookie: good() })).status, 403, `host ${host}`);
  }
  assert.equal((await req("/api/snapshot", { host: null, cookie: good() })).status, 403);
  assert.equal((await req(`/?token=${TOKEN}`, { host: "evil.com" })).status, 403);
  assert.equal((await req("/api/snapshot", { host: `127.0.0.1:${port}`, cookie: good() })).status, 200);
  assert.equal((await req("/api/snapshot", { host: `localhost:${port}`, cookie: good() })).status, 200);
});

test("static: / → index.html, assets served with a content type + nosniff, no SPA fallback", async () => {
  const idx = await req("/");
  assert.equal(idx.status, 200);
  assert.match(idx.body, /<title>ah<\/title>/);
  assert.match(String(idx.headers["content-type"]), /^text\/html/);
  assert.equal(idx.headers["x-content-type-options"], "nosniff");
  const js = await req("/assets/app.js");
  assert.equal(js.status, 200);
  assert.match(String(js.headers["content-type"]), /^text\/javascript/);
  assert.equal((await req("/missing")).status, 404);
  assert.equal((await req("/assets")).status, 404); // a directory is not a file
});

test("static: traversal and NUL paths never escape distDir", async () => {
  for (const p of ["/../package.json", "/%2e%2e/%2e%2e/etc/passwd", "/..%2fpackage.json", "/%2e%2e%2fpackage.json", "/assets/../../package.json", "/index.html%00.js", "/%00"]) {
    const res = await req(p);
    assert.ok([400, 403, 404].includes(res.status), `${p} → ${res.status}`);
    assert.ok(!res.body.includes("outside-dist"), `${p} leaked`);
  }
});

test("src/ui never writes files", () => {
  const dir = fileURLToPath(new URL("../src/ui/", import.meta.url));
  const writes = /\b(write|append|mkdir|rm|rmdir|unlink|rename|copyFile|cp|truncate|symlink|chmod|utimes|createWriteStream)(File)?(Sync)?\s*\(/;
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/fs\.(\w+)/g)) assert.ok(!writes.test(m[1] + "("), `${f} calls fs.${m[1]}`);
    assert.ok(!/["']w[+x]?["']|["']a\+?["']/.test(src.match(/openSync\([^)]*\)/g)?.join("") || ""), `${f} opens for write`);
  }
});
