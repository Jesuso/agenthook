import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` profile removal — `POST /api/profile/remove` + `GET /api/profile/remove-preview`
// (src/ui/server.js, src/archive.js). Same fake control-socket pattern as ui-control.test.js: a
// running receiver is a socket that answers `decommission`; a stopped one is a state dir with no
// socket, which the UI server archives into `<registry>-archive/`. Temp registry; ephemeral port.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { archiveRoot } from "../src/archive.js";
import { controlSockPath } from "../src/paths.js";
import { tildify } from "../src/profile.js";
import { createUiServer } from "../src/ui/server.js";

const TOKEN = "t0k3n-abcdefghijklmnopqrstuvwxyz0123456789";
const TIMEOUT_MS = 150;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-remove-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const registry = path.join(root, "registry");
fs.mkdirSync(path.join(root, "dist"));

/** A profile with a state dir, no control socket yet. @param {string} name @param {any} [marker] */
function profile(name, marker) {
  const dir = path.join(registry, name);
  fs.mkdirSync(dir, { recursive: true });
  if (marker) fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(marker));
  return { dir, sockPath: controlSockPath(dir, name) };
}

const RUNNING = profile("running");
const AGAIN = profile("again");
const FAIL = profile("fail");
const TIMEOUT = profile("timeout");
const STOPPED = profile("stopped", { configPath: "/cfg/agenthook.config.json", stateKey: "stopped", name: "Stopped Label" });
const LEGACY = profile("legacy"); // no profile.json, no heartbeat
const ZOMBIE = profile("zombie"); // live pid, no socket
fs.writeFileSync(path.join(ZOMBIE.dir, "server.pid"), String(process.pid));

/**
 * Starts a fake control socket at `sockPath`: writes the `hello` line on connect, then calls
 * `onLine(socket, req)` for each NDJSON request line.
 * @param {string} sockPath @param {(socket: net.Socket, req: any) => void} onLine
 * @returns {Promise<net.Server>}
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

/** Every request a fake socket received. @type {any[]} */
const calls = [];
/** @param {net.Socket} s @param {any} req @param {any} result */
const ok = (s, req, result) => s.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");

/** @type {net.Server[]} */
const fakes = [];
test.before(async () => {
  fakes.push(
    await fakeControl(RUNNING.sockPath, (s, req) => {
      calls.push(req);
      ok(s, req, { accepted: true, active: 2, queued: 1 });
    }),
    await fakeControl(AGAIN.sockPath, (s, req) => ok(s, req, { accepted: true, alreadyPending: true, active: 0, queued: 0 })),
    await fakeControl(FAIL.sockPath, (s, req) => {
      calls.push(req);
      s.write(JSON.stringify({ id: req.id, ok: false, error: "decommission: a restart is pending" }) + "\n");
    }),
    await fakeControl(TIMEOUT.sockPath, () => {}), // never replies
  );
});
test.after(() => Promise.all(fakes.map((f) => new Promise((r) => f.close(r)))));

const server = createUiServer({ port: 0, token: TOKEN, distDir: path.join(root, "dist"), registry, restartTimeoutMs: TIMEOUT_MS });
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

const postRemove = (/** @type {any} */ body, /** @type {Record<string, string|null>} */ h = {}) =>
  request("POST", "/api/profile/remove", typeof body === "string" ? body : JSON.stringify(body), h);
const getPreview = (/** @type {string} */ name, /** @type {Record<string, string|null>} */ h = {}) =>
  request("GET", `/api/profile/remove-preview?profile=${encodeURIComponent(name)}`, null, h);

/** The last `ui-audit.jsonl` line in `dir`. @param {string} dir */
function lastAudit(dir) {
  const lines = fs.readFileSync(path.join(dir, "ui-audit.jsonl"), "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

test("POST /api/profile/remove guards, in order: no cookie 401 → bad Origin 403 → missing X-AH-UI 403 → non-JSON 415", async () => {
  const body = { profile: "running" };
  assert.equal((await postRemove(body, { cookie: null })).status, 401);
  assert.equal((await postRemove(body, { origin: "http://evil.com" })).status, 403);
  assert.equal((await postRemove(body, { "x-ah-ui": null })).status, 403);
  assert.equal((await postRemove(body, { "content-type": "text/plain" })).status, 415);
  assert.equal((await postRemove("{not json")).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(RUNNING.dir, "ui-audit.jsonl")), false);
});

test("GET /api/profile/remove → 405 Allow: POST", async () => {
  const res = await request("GET", "/api/profile/remove", null);
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, "POST");
});

test("POST /api/profile/remove: non-string profile / non-boolean unregister → 400, socket never contacted", async () => {
  assert.equal((await postRemove({ profile: 7 })).status, 400);
  assert.equal((await postRemove({})).status, 400);
  for (const unregister of ["yes", 1, null, {}]) assert.equal((await postRemove({ profile: "running", unregister })).status, 400);
  assert.equal(calls.length, 0);
});

test("POST /api/profile/remove: unknown profile → 404", async () => {
  assert.equal((await postRemove({ profile: "nope" })).status, 404);
  assert.equal((await postRemove({ profile: ".." })).status, 404);
});

test("POST /api/profile/remove: running → sends {cmd:'decommission', args:{when:'idle', unregister:true}} → 202, audited", async () => {
  const res = await postRemove({ profile: "running" });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.body), { pending: true, active: 2, queued: 1 });
  assert.equal(calls.at(-1).cmd, "decommission");
  assert.deepEqual(calls.at(-1).args, { when: "idle", unregister: true });
  const a = lastAudit(RUNNING.dir);
  assert.equal(a.action, "remove");
  assert.equal(a.profile, "running");
  assert.equal(a.status, 202);
  assert.equal(a.unregister, true);
  assert.ok(fs.existsSync(RUNNING.dir), "the receiver archives itself; the UI moves nothing");
});

test("POST /api/profile/remove: unregister:false is forwarded and audited", async () => {
  const res = await postRemove({ profile: "running", unregister: false });
  assert.equal(res.status, 202);
  assert.deepEqual(calls.at(-1).args, { when: "idle", unregister: false });
  assert.equal(lastAudit(RUNNING.dir).unregister, false);
});

test("POST /api/profile/remove: a repeat request → 202 with alreadyPending", async () => {
  const res = await postRemove({ profile: "again" });
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.body), { pending: true, active: 0, queued: 0, alreadyPending: true });
});

test("POST /api/profile/remove: ok:false → 502 with the receiver's error; no reply → 504 — each audited, nothing moved", async () => {
  const fail = await postRemove({ profile: "fail" });
  assert.equal(fail.status, 502);
  assert.deepEqual(JSON.parse(fail.body), { error: "decommission: a restart is pending" });
  const to = await postRemove({ profile: "timeout" });
  assert.equal(to.status, 504);
  for (const [prof, status] of /** @type {const} */ ([[FAIL, 502], [TIMEOUT, 504]])) {
    assert.ok(fs.existsSync(prof.dir));
    assert.equal(lastAudit(prof.dir).status, status);
  }
});

test("POST /api/profile/remove: live pid + no socket → 409, nothing moved", async () => {
  const res = await postRemove({ profile: "zombie" });
  assert.equal(res.status, 409);
  assert.match(JSON.parse(res.body).error, new RegExp(`receiver pid ${process.pid} is alive .* run \`agenthook stop\` first`));
  assert.ok(fs.existsSync(ZOMBIE.dir));
  assert.equal(lastAudit(ZOMBIE.dir).status, 409);
});

test("GET /api/profile/remove-preview: 401 without the cookie, 404 for an unknown profile", async () => {
  assert.equal((await getPreview("stopped", { cookie: null })).status, 401);
  assert.equal((await getPreview("nope")).status, 404);
});

test("GET /api/profile/remove-preview: configPath, archivePattern from the injected registry, webhookHint", async () => {
  const res = await getPreview("stopped");
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    profile: "stopped",
    label: "Stopped Label",
    up: false,
    configPath: "/cfg/agenthook.config.json",
    archivePattern: tildify(path.join(archiveRoot(registry), "stopped-<YYYY-MM-DDTHH-MM-SS>")) + "/",
    webhookHint: "agenthook unregister --config /cfg/agenthook.config.json",
  });
  const legacy = JSON.parse((await getPreview("legacy")).body);
  assert.equal(legacy.label, "legacy");
  assert.equal(legacy.configPath, null);
  assert.equal(legacy.webhookHint, null);
  assert.equal(JSON.parse((await getPreview("running")).body).up, false); // no pidfile: up follows the pid, not the socket
});

test("POST /api/profile/remove: stopped → 200, dir archived under <registry>-archive with the audit line + webhookHint", async () => {
  const res = await postRemove({ profile: "stopped" });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.webhookHint, "agenthook unregister --config /cfg/agenthook.config.json");
  assert.ok(path.isAbsolute(body.archivedTo));
  assert.equal(path.dirname(body.archivedTo), archiveRoot(registry));
  assert.match(path.basename(body.archivedTo), /^stopped-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d$/);
  assert.equal(fs.existsSync(STOPPED.dir), false);
  const a = lastAudit(body.archivedTo);
  assert.equal(a.action, "remove");
  assert.equal(a.stateKey, "stopped");
  assert.equal(a.source, "ui");
  // Gone from the registry → a second request is a 404.
  assert.equal((await postRemove({ profile: "stopped" })).status, 404);
});

test("POST /api/profile/remove: stopped without profile.json → 200 with webhookHint null", async () => {
  const res = await postRemove({ profile: "legacy" });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.webhookHint, null);
  assert.equal(fs.existsSync(LEGACY.dir), false);
  assert.ok(fs.existsSync(body.archivedTo));
});
