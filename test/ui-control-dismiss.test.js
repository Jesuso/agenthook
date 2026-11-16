import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` control ops — dismiss/retry/recheck/close-on-board/release/pause/resume.
// Fixture: setupUiControl() (_ui-control-helpers.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupUiControl } from "./_ui-control-helpers.js";

const { profiles, calls, request } = setupUiControl();
const { DOWN, TIMEOUT, FAIL, RETRIED, RECHECKED, RELEASED, TOGGLED } = profiles;

const postDismiss = (/** @type {any} */ body, /** @type {Record<string, string|null>} */ h = {}) => request("POST", "/api/dismiss", JSON.stringify(body), h);

test("POST /api/dismiss: guards and validation never reach the socket", async () => {
  assert.equal((await postDismiss({ profile: "dismissed", ref: "1" }, { cookie: null })).status, 401);
  assert.equal((await postDismiss({ profile: "dismissed", ref: "1" }, { origin: "http://evil.example" })).status, 403);
  assert.equal((await postDismiss({ profile: "dismissed", ref: "1" }, { "x-ah-ui": null })).status, 403);
  assert.equal((await postDismiss({ profile: "dismissed" })).status, 400);
  assert.equal((await postDismiss({ profile: "dismissed", ref: "" })).status, 400);
  assert.equal((await postDismiss({ profile: "dismissed", ref: 5 })).status, 400);
  assert.equal((await postDismiss({ profile: "nope", ref: "1" })).status, 404);
  assert.equal(calls.dismiss.length, 0);
});

test("POST /api/dismiss: sends {cmd:'dismiss', args:{ref, actor:'ui'}} and returns the result; down → 503", async () => {
  const res = await postDismiss({ profile: "dismissed", ref: "42" });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ref: "42", dismissed: true });
  assert.equal(calls.dismiss[0].cmd, "dismiss");
  assert.deepEqual(calls.dismiss[0].args, { ref: "42", actor: "ui" });
  assert.equal((await postDismiss({ profile: "down", ref: "42" })).status, 503);
  assert.equal((await request("GET", "/api/dismiss", undefined, {})).status, 405);
});

const postRetry = (/** @type {any} */ body, /** @type {Record<string, string|null>} */ h = {}) => request("POST", "/api/retry", JSON.stringify(body), h);
const uiAuditLines = (/** @type {string} */ dir) =>
  fs.existsSync(path.join(dir, "ui-audit.jsonl")) ? fs.readFileSync(path.join(dir, "ui-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

test("POST /api/retry: guards and validation never reach the socket", async () => {
  const ok = { profile: "retried", ref: "1" };
  assert.equal((await postRetry(ok, { cookie: null })).status, 401);
  assert.equal((await postRetry(ok, { origin: "http://evil.example" })).status, 403);
  assert.equal((await postRetry(ok, { "x-ah-ui": null })).status, 403);
  assert.equal((await postRetry({ profile: "retried" })).status, 400);
  assert.equal((await postRetry({ profile: "retried", ref: "" })).status, 400);
  assert.equal((await postRetry({ profile: "retried", ref: 5 })).status, 400);
  assert.equal((await postRetry({ profile: "nope", ref: "1" })).status, 404);
  assert.equal(calls.retry.length, 0);
});

test("POST /api/retry: sends {cmd:'retry', args:{ref, actor:'ui'}}, audits it; refusal → 502; slow tracker waits; down → 503", async () => {
  const res = await postRetry({ profile: "retried", ref: "42" });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ref: "42", step: "code", stage: "agent:code" });
  assert.equal(calls.retry[0].cmd, "retry");
  assert.deepEqual(calls.retry[0].args, { ref: "42", actor: "ui" });
  const line = uiAuditLines(RETRIED.dir).at(-1);
  assert.deepEqual({ action: line.action, profile: line.profile, ref: line.ref, status: line.status }, { action: "retry", profile: "retried", ref: "42", status: 200 });
  assert.equal((await postRetry({ profile: "release-refused", ref: "9" })).status, 502);
  assert.equal((await postRetry({ profile: "release-slow", ref: "9" })).status, 200, "retry uses the long timeout");
  assert.equal((await postRetry({ profile: "down", ref: "42" })).status, 503);
  assert.equal((await request("GET", "/api/retry", undefined, {})).status, 405);
});

const postRecheck = (/** @type {any} */ body, /** @type {Record<string, string|null>} */ h = {}) => request("POST", "/api/recheck", JSON.stringify(body), h);
const postCloseOnBoard = (/** @type {any} */ body, /** @type {Record<string, string|null>} */ h = {}) => request("POST", "/api/close-on-board", JSON.stringify(body), h);

test("POST /api/recheck + /api/close-on-board: guards and validation never reach the socket", async () => {
  const ok = { profile: "rechecked", ref: "1" };
  for (const post of [postRecheck, postCloseOnBoard]) {
    assert.equal((await post(ok, { cookie: null })).status, 401);
    assert.equal((await post(ok, { origin: "http://evil.example" })).status, 403);
    assert.equal((await post(ok, { "x-ah-ui": null })).status, 403);
    assert.equal((await post({ profile: "rechecked" })).status, 400);
    assert.equal((await post({ profile: "rechecked", ref: "" })).status, 400);
    assert.equal((await post({ profile: "rechecked", ref: 5 })).status, 400);
    assert.equal((await post({ profile: "nope", ref: "1" })).status, 404);
  }
  assert.equal((await postRecheck({ profile: "rechecked", all: "yes" })).status, 400);
  assert.equal((await postRecheck({ profile: "rechecked", all: true, ref: "1" })).status, 400, "one ref or all, never both");
  assert.equal((await postCloseOnBoard({ profile: "rechecked", all: true })).status, 400, "close-on-board is one ref only");
  assert.equal(calls.recheck.length, 0);
});

test("POST /api/recheck {ref}|{all} and /api/close-on-board {ref}: forwarded with actor ui, audited; down → 503; GET → 405", async () => {
  const one = await postRecheck({ profile: "rechecked", ref: "42" });
  assert.equal(one.status, 200);
  assert.deepEqual(JSON.parse(one.body), { ref: "42", changed: [], unchanged: true });
  const all = await postRecheck({ profile: "rechecked", all: true });
  assert.deepEqual(JSON.parse(all.body), { rechecked: [] });
  const closed = await postCloseOnBoard({ profile: "rechecked", ref: "42" });
  assert.deepEqual(JSON.parse(closed.body), { ref: "42", completed: true });
  assert.deepEqual(calls.recheck.map((c) => [c.cmd, c.args]), [
    ["recheck", { ref: "42", actor: "ui" }],
    ["recheck", { all: true, actor: "ui" }],
    ["close_on_board", { ref: "42", actor: "ui" }],
  ]);
  const lines = uiAuditLines(RECHECKED.dir).map((l) => ({ action: l.action, ref: l.ref, all: l.all, status: l.status }));
  assert.deepEqual(lines, [
    { action: "recheck", ref: "42", all: undefined, status: 200 },
    { action: "recheck", ref: undefined, all: true, status: 200 },
    { action: "close-on-board", ref: "42", all: undefined, status: 200 },
  ]);
  assert.equal((await postRecheck({ profile: "down", ref: "42" })).status, 503);
  assert.equal((await postCloseOnBoard({ profile: "down", ref: "42" })).status, 503);
  assert.equal((await request("GET", "/api/recheck", undefined, {})).status, 405);
  assert.equal((await request("GET", "/api/close-on-board", undefined, {})).status, 405);
});

const postRelease = (/** @type {any} */ body, /** @type {Record<string, string|null>} */ h = {}) => request("POST", "/api/release", JSON.stringify(body), h);

test("POST /api/release: guards and validation never reach the socket", async () => {
  const ok = { profile: "released", ref: "1" };
  assert.equal((await postRelease(ok, { cookie: null })).status, 401);
  assert.equal((await postRelease(ok, { origin: "http://evil.example" })).status, 403);
  assert.equal((await postRelease(ok, { "x-ah-ui": null })).status, 403);
  assert.equal((await postRelease({ profile: "released" })).status, 400);
  assert.equal((await postRelease({ profile: "released", ref: "" })).status, 400);
  assert.equal((await postRelease({ profile: "released", ref: 5 })).status, 400);
  assert.equal((await postRelease({ ...ok, comment: 5 })).status, 400);
  assert.equal((await postRelease({ ...ok, comment: { a: 1 } })).status, 400);
  assert.equal((await postRelease({ profile: 7, ref: "1" })).status, 400);
  assert.equal((await postRelease({ profile: "nope", ref: "1" })).status, 404);
  assert.equal(calls.release.length, 0);
});

test("POST /api/release: sends {cmd:'release', args:{ref, actor:'ui', comment?}}; a blank comment is omitted; GET → 405", async () => {
  const res = await postRelease({ profile: "released", ref: "42", comment: "use Postgres" });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ref: "42", step: "triage", queued: true });
  assert.equal(calls.release[0].cmd, "release");
  assert.deepEqual(calls.release[0].args, { ref: "42", actor: "ui", comment: "use Postgres" });
  await postRelease({ profile: "released", ref: "43", comment: "" });
  assert.deepEqual(calls.release[1].args, { ref: "43", actor: "ui" });
  assert.equal((await postRelease({ profile: "down", ref: "42" })).status, 503);
  assert.equal((await request("GET", "/api/release", undefined, {})).status, 405);
});

test("POST /api/release: a refusal is 502 with the receiver's message; the long action waits past the short timeout", async () => {
  const refused = await postRelease({ profile: "release-refused", ref: "9" });
  assert.equal(refused.status, 502);
  assert.match(JSON.parse(refused.body).error, /cannot be released: not held/);
  const slow = await postRelease({ profile: "release-slow", ref: "9" });
  assert.equal(slow.status, 200, "release uses releaseTimeoutMs, not restartTimeoutMs");
  assert.equal((await postRelease({ profile: "timeout", ref: "9" })).status, 504);
});

test("POST /api/release: audits the outcome without the comment text", async () => {
  await postRelease({ profile: "released", ref: "77", comment: "SECRET-ANSWER" });
  const lines = uiAuditLines(RELEASED.dir);
  const line = lines.find((l) => l.ref === "77");
  assert.ok(line, "an audit line for ref 77");
  assert.deepEqual({ action: line.action, profile: line.profile, status: line.status, commented: line.commented }, { action: "release", profile: "released", status: 200, commented: true });
  assert.ok(!JSON.stringify(lines).includes("SECRET-ANSWER"));
});

for (const cmd of ["pause", "resume"]) {
  const url = `/api/${cmd}`;
  const post = (/** @type {any} */ body, /** @type {Record<string, string|null>} */ h = {}) => request("POST", url, JSON.stringify(body), h);
  const auditLines = (/** @type {string} */ dir) => (fs.existsSync(path.join(dir, "ui-audit.jsonl")) ? fs.readFileSync(path.join(dir, "ui-audit.jsonl"), "utf8").trim().split("\n").length : 0);
  const auditTail = (/** @type {string} */ dir) => {
    const lines = fs.readFileSync(path.join(dir, "ui-audit.jsonl"), "utf8").trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  };

  test(`POST ${url} guards, in order: no cookie 401 → bad Origin 403 → missing X-AH-UI 403 → non-JSON 415 → >256 KB 413 → bad JSON 400 — no audit`, async () => {
    const before = calls.toggle.length;
    const audited = auditLines(TOGGLED.dir);
    const body = { profile: "toggled" };
    assert.equal((await post(body, { cookie: null })).status, 401);
    assert.equal((await post(body, { origin: "http://evil.com" })).status, 403);
    assert.equal((await post(body, { "x-ah-ui": null })).status, 403);
    assert.equal((await post(body, { "content-type": "text/plain" })).status, 415);
    assert.equal((await request("POST", url, JSON.stringify({ profile: "toggled", pad: "x".repeat(256 * 1024) }))).status, 413);
    assert.equal((await request("POST", url, "{not json")).status, 400);
    assert.equal(calls.toggle.length, before);
    assert.equal(auditLines(TOGGLED.dir), audited);
  });

  test(`POST ${url}: non-string profile → 400; unknown profile → 404, socket never contacted`, async () => {
    const before = calls.toggle.length;
    assert.equal((await post({ profile: 7 })).status, 400);
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ profile: "nope" })).status, 404);
    assert.equal(calls.toggle.length, before);
  });

  test(`POST ${url}: receiver down → 503, timeout → 504, ok:false → 502 — each audited`, async () => {
    assert.equal((await post({ profile: "down" })).status, 503);
    assert.equal((await post({ profile: "timeout" })).status, 504);
    const fail = await post({ profile: "fail" });
    assert.equal(fail.status, 502);
    assert.deepEqual(JSON.parse(fail.body), { error: "unknown command" });
    for (const [prof, name, status] of /** @type {const} */ ([[DOWN, "down", 503], [TIMEOUT, "timeout", 504], [FAIL, "fail", 502]])) {
      const last = auditTail(prof.dir);
      assert.equal(last.action, cmd);
      assert.equal(last.profile, name);
      assert.equal(last.status, status);
      assert.ok(typeof last.ts === "string");
    }
  });

  test(`POST ${url}: sends exactly {cmd:'${cmd}', args:{}} and returns the receiver's result as is on 200`, async () => {
    const res = await post({ profile: "toggled" });
    assert.equal(res.status, 200);
    const req = calls.toggle.at(-1);
    assert.equal(req.cmd, cmd);
    assert.deepEqual(req.args, {});
    const result = JSON.parse(res.body);
    if (cmd === "pause") assert.deepEqual(result, { paused: true, active: 0, queued: 0 });
    // A locked resume is a 200 whose result carries the note — the UI must surface it.
    else assert.equal(result.note, "a restart/decommission/shutdown holds the queue; not resumed");
    assert.deepEqual(Object.keys(auditTail(TOGGLED.dir)).sort(), ["action", "profile", "status", "ts"]);
    assert.equal(auditTail(TOGGLED.dir).action, cmd);
    assert.equal(auditTail(TOGGLED.dir).status, 200);
  });

  test(`${url}: non-POST methods → 405 Allow: POST`, async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await request(method, url, null);
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, "POST");
    }
  });
}
