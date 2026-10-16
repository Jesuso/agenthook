import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` `GET /api/epics[/<ref>]` — the receiver's `epics` op over a fake control socket per
// profile (ok / ok:false / never / unsupported), and the receiver-down fallback built from the
// profile's refmeta.epic. Temp registry; ephemeral port.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { controlSockPath } from "../src/paths.js";
import { createUiServer } from "../src/ui/server.js";

const TOKEN = "t0k3n-abcdefghijklmnopqrstuvwxyz0123456789";
const TIMEOUT_MS = 150;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-epics-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const registry = path.join(root, "registry");
fs.mkdirSync(path.join(root, "dist"));

/** A profile with a state dir, no control socket yet. @param {string} name */
function profile(name) {
  const dir = path.join(registry, name);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, sockPath: controlSockPath(dir, name) };
}

const OK = profile("ok");
const FAIL = profile("fail");
const TIMEOUT = profile("timeout");
const UNSUPPORTED = profile("unsupported");
const DOWN = profile("down"); // dir + refmeta fixture, nothing listens
fs.writeFileSync(
  path.join(DOWN.dir, "refmeta.json"),
  JSON.stringify({
    "11": { title: "First", displayId: "#11", epic: { ref: "E1", name: "Epic one", url: "https://x/E1" } },
    "12": { title: "Second", epic: { ref: "E1", name: "Epic one", url: "https://x/E1" } },
    "13": { title: "Left its epic", epic: null },
  }),
);
fs.writeFileSync(path.join(DOWN.dir, "held.json"), JSON.stringify({ "12": { stepId: "code", reason: "q?", heldAt: "2026-10-15T00:00:00Z" } }));

/** @param {string} sockPath @param {(socket: net.Socket, req: any) => void} onLine */
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

/** @type {any[]} */
const okCalls = [];
const LIVE = { at: "2026-10-15T00:00:00Z", live: true, supported: true, epics: [{ ref: "E1", total: 3 }] };

/** @type {net.Server[]} */
const fakes = [];
test.before(async () => {
  fakes.push(
    await fakeControl(OK.sockPath, (s, req) => {
      okCalls.push(req);
      s.write(JSON.stringify({ id: req.id, ok: true, result: LIVE }) + "\n");
    }),
    await fakeControl(FAIL.sockPath, (s, req) => s.write(JSON.stringify({ id: req.id, ok: false, error: "no epic E9" }) + "\n")),
    await fakeControl(TIMEOUT.sockPath, () => {}),
    await fakeControl(UNSUPPORTED.sockPath, (s, req) => s.write(JSON.stringify({ id: req.id, ok: true, result: { at: "t", live: true, supported: false, epics: [] } }) + "\n")),
  );
});
test.after(() => Promise.all(fakes.map((f) => new Promise((r) => f.close(r)))));

const server = createUiServer({ port: 0, token: TOKEN, distDir: path.join(root, "dist"), registry, epicsTimeoutMs: TIMEOUT_MS });
/** @type {number} */
let port;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const a = server.address();
  port = a && typeof a === "object" ? a.port : 0;
});
test.after(() => new Promise((r) => server.close(() => r(undefined))));

/** @param {string} p @param {{cookie?: boolean}} [o] @returns {Promise<{status: number, body: string}>} */
function get(p, { cookie = true } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie: `ah_ui=${TOKEN}` } : {}) } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on("error", reject);
    r.end();
  });
}

test("GET /api/epics: no cookie → 401; unknown profile → 404; bad ref or tz → 400 — socket never contacted", async () => {
  assert.equal((await get("/api/epics?profile=ok", { cookie: false })).status, 401);
  assert.equal((await get("/api/epics?profile=nope")).status, 404);
  assert.equal((await get("/api/epics/..%2Fx?profile=ok")).status, 400);
  assert.equal((await get("/api/epics/a/b?profile=ok")).status, 400);
  assert.equal((await get("/api/epics/?profile=ok")).status, 400);
  assert.equal((await get("/api/epics?profile=ok&tz=abc")).status, 400);
  assert.equal((await get("/api/epics?profile=ok&tz=9999")).status, 400);
  assert.equal(okCalls.length, 0);
});

test("GET /api/epics[/<ref>]: ok → 200 passthrough; sends {cmd:'epics', args:{ref?, tz}}", async () => {
  const list = await get("/api/epics?profile=ok&tz=-120");
  assert.equal(list.status, 200);
  assert.deepEqual(JSON.parse(list.body), LIVE);
  const one = await get("/api/epics/E1?profile=ok");
  assert.equal(one.status, 200);
  assert.deepEqual(okCalls.map((c) => [c.cmd, c.args]), [["epics", { tz: -120 }], ["epics", { ref: "E1", tz: 0 }]]);
});

test("GET /api/epics: ok:false → 502 with its error; no reply → 504; unsupported → 200 supported:false", async () => {
  const fail = await get("/api/epics/E9?profile=fail");
  assert.equal(fail.status, 502);
  assert.deepEqual(JSON.parse(fail.body), { error: "no epic E9" });
  assert.equal((await get("/api/epics?profile=timeout")).status, 504);
  const un = await get("/api/epics?profile=unsupported");
  assert.equal(un.status, 200);
  assert.equal(JSON.parse(un.body).supported, false);
});

test("GET /api/epics: receiver down → 200 live:false from refmeta.epic; detail of an unknown epic → 404", async () => {
  const list = await get("/api/epics?profile=down");
  assert.equal(list.status, 200);
  const l = JSON.parse(list.body);
  assert.equal(l.live, false);
  assert.equal(l.supported, true);
  assert.deepEqual(l.epics.map((/** @type {any} */ e) => [e.ref, e.name, e.url, e.status, e.total, e.needsYou]), [["E1", "Epic one", "https://x/E1", null, 2, ["12"]]]);
  const one = await get("/api/epics/E1?profile=down");
  assert.equal(one.status, 200);
  const d = JSON.parse(one.body);
  assert.equal(d.live, false);
  assert.deepEqual(d.epic.tickets.map((/** @type {any} */ t) => [t.ref, t.displayId, t.name, t.bucket, t.status]), [["11", "#11", "First", "untracked", "idle"], ["12", undefined, "Second", "needsYou", "held"]]);
  assert.equal((await get("/api/epics/E9?profile=down")).status, 404);
});
