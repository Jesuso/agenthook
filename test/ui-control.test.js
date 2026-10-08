import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` control-socket actions — `GET /api/discover` + `POST /api/restart` (src/ui/control-
// client.js, src/control.js protocol). A fake control socket per profile stands in for the
// receiver: it sends the v1 `hello` line, then replies to one request per test scenario (ok,
// ok:false, or never — to exercise the 503/504/502/200 mapping). Temp registry; ephemeral port.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { controlSockPath } from "../src/paths.js";
import { controlRequest, resolveProfileSock } from "../src/ui/control-client.js";
import { createUiServer } from "../src/ui/server.js";

const TOKEN = "t0k3n-abcdefghijklmnopqrstuvwxyz0123456789";
const DISCOVER_MS = 150;
const RESTART_MS = 150;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-control-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const registry = path.join(root, "registry");
fs.mkdirSync(path.join(root, "dist"));

/** A profile with a state dir, no control socket yet. @param {string} name */
function profile(name) {
  const dir = path.join(registry, name);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, sockPath: controlSockPath(dir, name) };
}

const DOWN = profile("down"); // dir exists, nothing listens
const TIMEOUT = profile("timeout");
const FAIL = profile("fail");
const OK = profile("ok");
const RESTARTED = profile("restarted");

/**
 * Starts a fake control socket at `sockPath`: writes the `hello` line on connect, then calls
 * `onLine(socket, req)` for each NDJSON request line. Returns a closer.
 * @param {string} sockPath @param {(socket: net.Socket, req: any) => void} onLine
 */
function fakeControl(sockPath, onLine) {
  const server = net.createServer((socket) => {
    socket.write(JSON.stringify({ type: "hello", name: "x", pid: 1, startedAt: "t" }) + "\n");
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() !== "") onLine(socket, JSON.parse(line));
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(sockPath, () => resolve(server)));
}

/** @type {{restart: any[]}} */
const calls = { restart: [] };

/** @type {net.Server[]} */
const fakes = [];
test.before(async () => {
  fakes.push(
    await fakeControl(TIMEOUT.sockPath, () => {}), // never replies
    await fakeControl(FAIL.sockPath, (s, req) => s.write(JSON.stringify({ id: req.id, ok: false, error: "unknown command" }) + "\n")),
    await fakeControl(OK.sockPath, (s, req) =>
      s.write(JSON.stringify({ id: req.id, ok: true, result: { tracker: "github", stageKeys: null, stages: [{ id: "code", label: "Code" }] } }) + "\n"),
    ),
    await fakeControl(RESTARTED.sockPath, (s, req) => {
      calls.restart.push(req);
      s.write(JSON.stringify({ id: req.id, ok: true, result: { accepted: true, active: 0, queued: 0 } }) + "\n");
    }),
  );
});
test.after(() => Promise.all(fakes.map((f) => new Promise((r) => f.close(r)))));

const server = createUiServer({ port: 0, token: TOKEN, distDir: path.join(root, "dist"), registry, discoverTimeoutMs: DISCOVER_MS, restartTimeoutMs: RESTART_MS });
/** @type {number} */
let port;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const a = server.address();
  port = a && typeof a === "object" ? a.port : 0;
});
test.after(() => new Promise((r) => server.close(() => r(undefined))));

/** A valid request's headers, with `o` overriding (null drops one). @param {Record<string, string|null>} [o] */
function hdrs(o = {}) {
  /** @type {Record<string, string|null>} */
  const h = {
    host: `127.0.0.1:${port}`,
    cookie: `ah_ui=${TOKEN}`,
    origin: `http://127.0.0.1:${port}`,
    "x-ah-ui": "1",
    "content-type": "application/json",
    ...o,
  };
  return /** @type {Record<string, string>} */ (Object.fromEntries(Object.entries(h).filter(([, v]) => v !== null)));
}

/**
 * @param {string} method @param {string} p @param {string|null} body @param {Record<string, string|null>} [headers]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: hdrs(headers), setHost: false, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: text }));
    });
    r.on("error", reject);
    r.end(body ?? undefined);
  });
}

const getDiscover = (/** @type {string} */ name, /** @type {Record<string, string|null>} */ h = {}) =>
  request("GET", `/api/discover?profile=${encodeURIComponent(name)}`, null, h);
const postRestart = (/** @type {any} */ body, /** @type {Record<string, string|null>} */ h = {}) => request("POST", "/api/restart", JSON.stringify(body), h);

test("GET /api/discover: unknown profile → 404, socket never contacted", async () => {
  const res = await getDiscover("nope");
  assert.equal(res.status, 404);
});

test("GET /api/discover: no cookie → 401 (before profile is even checked)", async () => {
  assert.equal((await getDiscover("ok", { cookie: null })).status, 401);
});

test("GET /api/discover: receiver down (no socket) → 503", async () => {
  const res = await getDiscover("down");
  assert.equal(res.status, 503);
  assert.deepEqual(JSON.parse(res.body), { error: "receiver not running" });
});

test("GET /api/discover: no reply within timeout → 504", async () => {
  const res = await getDiscover("timeout");
  assert.equal(res.status, 504);
  assert.deepEqual(JSON.parse(res.body), { error: "receiver timed out" });
});

test("GET /api/discover: receiver ok:false → 502 with its error", async () => {
  const res = await getDiscover("fail");
  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(res.body), { error: "unknown command" });
});

test("GET /api/discover: success → 200 + the discover result as is", async () => {
  const res = await getDiscover("ok");
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { tracker: "github", stageKeys: null, stages: [{ id: "code", label: "Code" }] });
});

test("POST /api/restart guards, in order: no cookie 401 → bad Origin 403 → missing X-AH-UI 403 → non-JSON 415", async () => {
  const body = JSON.stringify({ profile: "ok" });
  assert.equal((await postRestart(body, { cookie: null })).status, 401);
  assert.equal((await postRestart(body, { origin: "http://evil.com" })).status, 403);
  assert.equal((await postRestart(body, { "x-ah-ui": null })).status, 403);
  assert.equal((await postRestart(body, { "content-type": "text/plain" })).status, 415);
});

test("POST /api/restart: non-string profile → 400", async () => {
  assert.equal((await postRestart({ profile: 7 })).status, 400);
  assert.equal((await postRestart({})).status, 400);
});

test("POST /api/restart: unknown profile → 404", async () => {
  assert.equal((await postRestart({ profile: "nope" })).status, 404);
});

test("POST /api/restart: receiver down → 503, timeout → 504, ok:false → 502 — each audited", async () => {
  const down = await postRestart({ profile: "down" });
  assert.equal(down.status, 503);
  const to = await postRestart({ profile: "timeout" });
  assert.equal(to.status, 504);
  const fail = await postRestart({ profile: "fail" });
  assert.equal(fail.status, 502);
  for (const [prof, status] of [[DOWN, 503], [TIMEOUT, 504], [FAIL, 502]]) {
    const lines = fs.readFileSync(path.join(prof.dir, "ui-audit.jsonl"), "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.action, "restart");
    assert.equal(last.status, status);
    assert.ok(typeof last.ts === "string");
  }
});

test("POST /api/restart: guard failures never reach the socket, so no audit line is written", async () => {
  assert.equal((await postRestart({ profile: "restarted" }, { cookie: null })).status, 401);
  assert.equal(fs.existsSync(path.join(RESTARTED.dir, "ui-audit.jsonl")), false);
});

test("POST /api/restart: sends exactly {cmd:'restart', args:{when:'idle'}} and returns the ack on 200", async () => {
  const res = await postRestart({ profile: "restarted" });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { accepted: true, active: 0, queued: 0 });
  assert.equal(calls.restart.length, 1);
  assert.equal(calls.restart[0].cmd, "restart");
  assert.deepEqual(calls.restart[0].args, { when: "idle" });
  const lines = fs.readFileSync(path.join(RESTARTED.dir, "ui-audit.jsonl"), "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.action, "restart");
  assert.equal(last.status, 200);
  assert.equal(last.profile, "restarted");
});

test("POST /api/restart: non-string moveTo → 400, socket never contacted", async () => {
  const n = calls.restart.length;
  for (const moveTo of [5, null, {}, ["x"]]) assert.equal((await postRestart({ profile: "restarted", moveTo })).status, 400);
  assert.equal(calls.restart.length, n);
});

test("POST /api/restart: forwards moveTo as {when:'idle', moveTo} and audits it", async () => {
  const res = await postRestart({ profile: "restarted", moveTo: "new-key" });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.restart.at(-1).args, { when: "idle", moveTo: "new-key" });
  const lines = fs.readFileSync(path.join(RESTARTED.dir, "ui-audit.jsonl"), "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.action, "restart");
  assert.equal(last.moveTo, "new-key");
});

test("resolveProfileSock: only names listProfiles returns resolve, to the right control.sock path", () => {
  assert.deepEqual(resolveProfileSock(registry, "nope"), null);
  const r = resolveProfileSock(registry, "ok");
  assert.equal(r?.sockPath, OK.sockPath);
});

test("controlRequest: ignores the hello line and replies for other ids, destroys the socket after", async () => {
  const sockPath = path.join(root, "manual.sock");
  const srv = net.createServer((socket) => {
    socket.write(JSON.stringify({ type: "hello" }) + "\n");
    socket.write(JSON.stringify({ id: 999999, ok: true, result: "not-mine" }) + "\n");
    let buf = "";
    socket.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        socket.write(JSON.stringify({ id: req.id, ok: true, result: "mine" }) + "\n");
      }
    });
  });
  await new Promise((r) => srv.listen(sockPath, () => r(undefined)));
  try {
    const r = await controlRequest(sockPath, "discover", {}, { timeoutMs: 1000 });
    assert.deepEqual(r, { ok: true, result: "mine" });
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("controlRequest: no socket file → rejects with code 'down'", async () => {
  await assert.rejects(controlRequest(path.join(root, "no-such.sock"), "discover", {}, { timeoutMs: 500 }), (e) => e.code === "down");
});

test("controlRequest: no reply within timeoutMs → rejects with code 'timeout'", async () => {
  const sockPath = path.join(root, "hang.sock");
  const srv = net.createServer((socket) => {
    socket.write(JSON.stringify({ type: "hello" }) + "\n");
    socket.resume(); // drain the client's request so the socket can close cleanly later
  });
  await new Promise((r) => srv.listen(sockPath, () => r(undefined)));
  try {
    await assert.rejects(controlRequest(sockPath, "discover", {}, { timeoutMs: 100 }), (e) => e.code === "timeout");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
