import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` control-socket protocol — `GET /api/discover` + `POST /api/restart` (src/ui/control-
// client.js, src/control.js protocol), plus the raw `controlRequest`/`resolveProfileSock`
// building blocks underneath them. Fixture: `setupUiControl()` (see _ui-control-helpers.js)
// stands a fake control socket per profile that sends the v1 `hello` line, then replies to one
// request per test scenario (ok, ok:false, or never — to exercise the 503/504/502/200 mapping),
// in front of a real createUiServer on an ephemeral port.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { controlRequest, resolveProfileSock } from "../src/ui/control-client.js";
import { setupUiControl } from "./_ui-control-helpers.js";

const { root, registry, profiles, calls, request } = setupUiControl();
const { DOWN, TIMEOUT, FAIL, OK, RESTARTED } = profiles;

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
