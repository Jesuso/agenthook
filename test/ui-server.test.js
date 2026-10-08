import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
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

/** The one writer in src/ui (save.js atomicSave, behind both editors) and the write-ish fs calls it needs. */
const WRITER = "save.js";
const WRITER_CALLS = new Set(["fchmodSync", "writeSync", "renameSync", "unlinkSync", "appendFileSync", "mkdirSync"]); // mkdirSync: the 0700 instructions-bak/ / config-bak/ dir
const WRITES = /^[fl]?(write|writev|append|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|cp|truncate|symlink|link|chmod|chown|utimes|createWriteStream)(File)?(Sync)?$/;

/** Write-ish fs usage in one src/ui file that its role doesn't allow. @param {string} name @param {string} src */
function uiWrites(name, src) {
  const writer = name === WRITER;
  /** @type {string[]} */
  const bad = [];
  for (const m of src.matchAll(/\bfs\.(\w+)/g)) if (WRITES.test(m[1]) && !(writer && WRITER_CALLS.has(m[1]))) bad.push(`fs.${m[1]}`);
  if (/fs\.promises|["'](node:)?fs\/promises["']|import\s*\{[^}]*\}\s*from\s*["'](node:)?fs["']|require\(/.test(src)) bad.push("fs import");
  if (!writer) {
    // Only `fs.openSync(<file>, "r")`; no write flag constants anywhere.
    for (const line of src.split("\n")) if (/openSync\(/.test(line) && !/openSync\(.*,\s*["']r["']\)/.test(line)) bad.push(`opens for write: ${line.trim()}`);
    if (/\bO_(WRONLY|RDWR|CREAT|APPEND|TRUNC)\b/.test(src)) bad.push("O_* write flag");
  }
  return bad;
}

test("src/ui never writes files — except the save.js writer, and only its calls", () => {
  const dir = fileURLToPath(new URL("../src/ui/", import.meta.url));
  for (const f of fs.readdirSync(dir)) assert.deepEqual(uiWrites(f, fs.readFileSync(path.join(dir, f), "utf8")), [], f);
  // The rule bites: any write outside save.js, or an unlisted one inside it.
  for (const [f, src] of [
    ["server.js", "fs.writeFileSync(p, x)"],
    ["server.js", "fs.appendFileSync(p, x)"],
    ["watch.js", "fs.renameSync(a, b)"],
    ["rows.js", "fs.fchmodSync(fd, 0o600)"],
    ["logs.js", 'fs.openSync(p, "w")'],
    ["logs.js", "fs.openSync(p, fs.constants.O_WRONLY)"],
    ["logs.js", 'import { writeFileSync } from "node:fs"'],
    ["instructions.js", "fs.renameSync(a, b)"],
    ["config.js", 'fs.openSync(p, "w")'],
    ["save.js", "fs.writeFileSync(p, x)"],
    ["save.js", "fs.rmSync(p)"],
    ["save.js", "fs.chmodSync(p, 0o777)"],
    ["save.js", "fs.promises.writeFile(p, x)"],
  ]) {
    assert.notDeepEqual(uiWrites(f, src), [], `${f}: ${src}`);
  }
});

/**
 * Open `/api/stream` and collect raw SSE text until `until(text)` holds.
 * @param {(text: string) => boolean} until
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, done: Promise<string>, abort(): void }>}
 */
function stream(until) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, path: "/api/stream", headers: { host: `127.0.0.1:${port}`, cookie: good() } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        const done = new Promise((r2) => {
          res.on("data", (c) => {
            text += c;
            if (until(text)) r2(text);
          });
        });
        resolve({ status: res.statusCode || 0, headers: res.headers, done, abort: () => r.destroy() });
      },
    );
    r.on("error", (e) => (e.message === "socket hang up" ? undefined : reject(e)));
    r.end();
  });
}

test("/api/stream: same auth + Host guards as /api/snapshot", async () => {
  assert.equal((await req("/api/stream")).status, 401);
  assert.equal((await req("/api/stream", { cookie: "ah_ui=wrong" })).status, 401);
  assert.equal((await req("/api/stream", { host: "evil.com", cookie: good() })).status, 403);
});

test("/api/stream: 200 text/event-stream; a state change arrives as `event: <type>\\ndata: <json>\\n\\n`", async () => {
  const s = await stream((t) => /event: ticket\n/.test(t) && t.endsWith("\n\n"));
  try {
    assert.equal(s.status, 200);
    assert.equal(s.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(s.headers["cache-control"], "no-store");
    assert.equal(s.headers["x-accel-buffering"], "no");
    await new Promise((r) => setTimeout(r, 100)); // watcher's initial scan is synchronous; let fs.watch arm
    fs.writeFileSync(path.join(registry, "p", "held.json"), JSON.stringify({ 7: { stepId: "code", reason: "why?" } }));
    const text = await s.done;
    const frame = /(?:^|\n\n)event: ticket\ndata: (.*)\n\n/.exec(text);
    assert.ok(frame, text);
    const ev = JSON.parse(frame[1]);
    assert.equal(ev.type, "ticket");
    assert.equal(ev.ticket.ref, "7");
    assert.equal(ev.ticket.status, "held");
    assert.equal(ev.ticket.heldReason, "why?");
    // Once streaming, the snapshot comes from the same watcher state.
    const snap = JSON.parse((await req("/api/snapshot", { cookie: good() })).body);
    assert.equal(snap.tickets.find((/** @type {any} */ t) => t.ref === "7").status, "held");
  } finally {
    s.abort();
  }
});
