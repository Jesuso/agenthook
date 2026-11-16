import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` control ops — digest/summary/stats/harness-stats/ticket. Fixture: setupUiControl()
// (_ui-control-helpers.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupUiControl } from "./_ui-control-helpers.js";

const { profiles, calls, request } = setupUiControl();
const { DIGESTED, ADDED } = profiles;
const uiAuditLines = (/** @type {string} */ dir) =>
  fs.existsSync(path.join(dir, "ui-audit.jsonl")) ? fs.readFileSync(path.join(dir, "ui-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

test("POST /api/digest: guards, validation, then {cmd:'digest', args:{actor:'ui'}}; audited; GET reads the cached digest", async () => {
  const post = (/** @type {any} */ body, /** @type {Record<string, string|null>} */ h = {}) => request("POST", "/api/digest", JSON.stringify(body), h);
  assert.equal((await post({ profile: "digested" }, { cookie: null })).status, 401);
  assert.equal((await post({ profile: "digested" }, { origin: "http://evil.example" })).status, 403);
  assert.equal((await post({ profile: "digested" }, { "x-ah-ui": null })).status, 403);
  assert.equal((await post({ profile: 7 })).status, 400);
  assert.equal((await post({ profile: "nope" })).status, 404);
  assert.equal(calls.digest.length, 0);
  const res = await post({ profile: "digested" });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).text, "All quiet.");
  assert.equal(calls.digest[0].cmd, "digest");
  assert.deepEqual(calls.digest[0].args, { actor: "ui" });
  assert.ok(uiAuditLines(DIGESTED.dir).some((l) => l.action === "digest" && l.status === 200));
  assert.equal((await post({ profile: "down" })).status, 503);

  assert.deepEqual(JSON.parse((await request("GET", "/api/digest?profile=digested", undefined, {})).body), { digest: null });
  fs.writeFileSync(path.join(DIGESTED.dir, "digest.json"), JSON.stringify({ text: "Hi", generatedAt: "2026-10-15T12:00:00Z", basedOnEvents: 1, needsYou: 0 }));
  assert.equal(JSON.parse((await request("GET", "/api/digest?profile=digested", undefined, {})).body).digest.text, "Hi");
  assert.equal((await request("GET", "/api/digest?profile=nope", undefined, {})).status, 404);
});

test("POST /api/digest {lang}: forwarded canonical; a bad lang is 400; GET ?lang= reads that language's entry, legacy flat = en", async () => {
  const post = (/** @type {any} */ body) => request("POST", "/api/digest", JSON.stringify(body), {});
  const n = calls.digest.length;
  assert.equal((await post({ profile: "digested", lang: "not a tag!" })).status, 400);
  assert.equal((await post({ profile: "digested", lang: 7 })).status, 400);
  assert.equal(calls.digest.length, n);
  assert.equal((await post({ profile: "digested", lang: "ES" })).status, 200);
  assert.deepEqual(calls.digest.at(-1).args, { actor: "ui", lang: "es" });

  const get = async (/** @type {string} */ q) => request("GET", `/api/digest?profile=digested${q}`, undefined, {});
  fs.writeFileSync(path.join(DIGESTED.dir, "digest.json"), JSON.stringify({ text: "Hi", generatedAt: "2026-10-15T12:00:00Z", basedOnEvents: 1, needsYou: 0 }));
  assert.equal(JSON.parse((await get("&lang=en")).body).digest.text, "Hi", "a legacy flat digest reads as en");
  assert.equal(JSON.parse((await get("&lang=es")).body).digest, null);
  const view = { generatedAt: "2026-10-15T12:00:00Z", basedOnEvents: 1, needsYou: 0 };
  fs.writeFileSync(path.join(DIGESTED.dir, "digest.json"), JSON.stringify({ byLang: { en: { ...view, text: "Hi", lang: "en" }, es: { ...view, text: "Hola", lang: "es" } } }));
  assert.equal(JSON.parse((await get("&lang=es")).body).digest.text, "Hola");
  assert.equal(JSON.parse((await get("")).body).digest.text, "Hi", "no lang = en");
  assert.equal((await get("&lang=%3Cx%3E")).status, 400);
});

test("POST /api/summary: guards, validation, then {cmd:'summary', args:{ref, lang, actor:'ui'}}; POST only", async () => {
  const post = (/** @type {any} */ body, /** @type {Record<string, string|null>} */ h = {}) => request("POST", "/api/summary", JSON.stringify(body), h);
  const ok = { profile: "digested", ref: "42", lang: "es" };
  const n = calls.digest.length;
  assert.equal((await post(ok, { cookie: null })).status, 401);
  assert.equal((await post(ok, { origin: "http://evil.example" })).status, 403);
  assert.equal((await post(ok, { "x-ah-ui": null })).status, 403);
  assert.equal((await post({ ...ok, profile: 7 })).status, 400);
  assert.equal((await post({ ...ok, ref: "" })).status, 400);
  assert.equal((await post({ ...ok, lang: undefined })).status, 400);
  assert.equal((await post({ ...ok, lang: "español!" })).status, 400);
  assert.equal((await post({ ...ok, profile: "nope" })).status, 404);
  assert.equal(calls.digest.length, n, "nothing reached the receiver");
  const res = await post({ ...ok, lang: "ES" });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).text, "Resumen corto.");
  assert.equal(calls.digest.at(-1).cmd, "summary");
  assert.deepEqual(calls.digest.at(-1).args, { ref: "42", lang: "es", actor: "ui" });
  assert.equal((await post({ ...ok, profile: "down" })).status, 503);
  assert.equal((await request("GET", "/api/summary?profile=digested", undefined, {})).status, 405);
});

test("GET /api/stats: cookie-only, validates days/tz, buckets the whole events history", async () => {
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(DIGESTED.dir, "events.jsonl"),
    [
      { ts: new Date().toISOString(), event: "run_end", ref: "A", outcome: "advance", costUsd: 1.5 },
      { ts: new Date().toISOString(), event: "pipeline_done", ref: "A" },
      { ts: new Date().toISOString(), event: "pipeline_done", ref: "A" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  assert.equal((await request("GET", "/api/stats?profile=digested", undefined, { cookie: null })).status, 401);
  assert.equal((await request("GET", "/api/stats?profile=nope", undefined, {})).status, 404);
  assert.equal((await request("GET", "/api/stats?profile=digested&days=abc", undefined, {})).status, 400);
  assert.equal((await request("GET", "/api/stats?profile=digested&tz=99999", undefined, {})).status, 400);
  const res = await request("GET", "/api/stats?profile=digested&days=3&tz=0", undefined, {});
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.days.length, 3);
  const today = body.days.at(-1);
  assert.deepEqual({ date: today.date, finished: today.finished, runs: today.runs, costUsd: today.costUsd }, { date: day, finished: 1, runs: 1, costUsd: 1.5 });
  assert.deepEqual(today.ticketCost, { n: 1, p10: 1.5, p50: 1.5, p90: 1.5 }, "the ticket's spend, counted once despite the duplicate pipeline_done");
  assert.ok(body.since);
});

test("GET /api/harness-stats: cookie-only, by:harness over the last 7 days", async () => {
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(DIGESTED.dir, "usage.jsonl"),
    JSON.stringify({ ref: "H", stepId: "code", harness: "fast", startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: now, input: 10, output: 20, cacheRead: 0, cacheCreate: 0 }) + "\n",
  );
  fs.appendFileSync(path.join(DIGESTED.dir, "events.jsonl"), JSON.stringify({ ts: now, event: "run_end", ref: "H", step: "code", outcome: "advance", harness: "fast" }) + "\n");
  assert.equal((await request("GET", "/api/harness-stats?profile=digested", undefined, { cookie: null })).status, 401);
  assert.equal((await request("GET", "/api/harness-stats?profile=nope", undefined, {})).status, 404);
  const res = await request("GET", "/api/harness-stats?profile=digested", undefined, {});
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.by, "harness");
  assert.ok(body.groups.some((g) => g.key === "fast" && g.runs === 1));
});

test("GET /api/harness-stats: reads the whole events.jsonl, not just the live-tail routes' 256 KB default", async () => {
  // A run_end buried under > 256 KB of unrelated events used to fall outside readEventsTail's
  // default window, so its usage row counted as `unknown` instead of `advance` (#646).
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(DIGESTED.dir, "usage.jsonl"),
    JSON.stringify({ ref: "T", stepId: "code", harness: "slow", startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: now, input: 10, output: 20, cacheRead: 0, cacheCreate: 0 }) + "\n",
  );
  const lines = [JSON.stringify({ ts: now, event: "run_end", ref: "T", step: "code", outcome: "advance", harness: "slow" })];
  const pad = JSON.stringify({ ts: now, event: "noop", pad: "x".repeat(500) });
  while (Buffer.byteLength(lines.join("\n")) < 400 * 1024) lines.push(pad);
  fs.writeFileSync(path.join(DIGESTED.dir, "events.jsonl"), lines.join("\n") + "\n");
  const res = await request("GET", "/api/harness-stats?profile=digested", undefined, {});
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  const g = body.groups.find((g) => g.key === "slow");
  assert.equal(g?.outcomes.advance, 1);
  assert.equal(g?.outcomes.unknown, 0);
});

test("POST /api/ticket: creates on a local board, sends {cmd:'ticket_add'}, audits it; down → 503 with the start hint", async () => {
  const res = await request("POST", "/api/ticket", JSON.stringify({ profile: "ticket-added", title: "Fix the flaky test", body: "it fails on CI", step: "code", blockedBy: "3, 7" }));
  assert.equal(res.status, 200);
  const out = JSON.parse(res.body);
  assert.equal(out.ref, "42");
  assert.equal(out.step, "code");
  assert.deepEqual(out.blockedBy, ["3", "7"]);
  assert.equal(calls.ticket.length, 1);
  assert.equal(calls.ticket[0].cmd, "ticket_add");
  assert.deepEqual(calls.ticket[0].args, { title: "Fix the flaky test", body: "it fails on CI", step: "code", blockedBy: ["3", "7"] });
  const lines = fs.readFileSync(path.join(ADDED.dir, "ui-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.at(-1), { ts: lines.at(-1).ts, action: "ticket-add", profile: "ticket-added", status: 200, ref: "42" });
  assert.ok(!JSON.stringify(lines.at(-1)).includes("Fix the flaky test")); // title/body never logged
  const down = await request("POST", "/api/ticket", JSON.stringify({ profile: "ticket-down", title: "x" }));
  assert.equal(down.status, 503);
  assert.deepEqual(JSON.parse(down.body), { error: "start the receiver to add tickets" });
});

test("POST /api/ticket: no cookie → 401, socket never contacted", async () => {
  const n = calls.ticket.length;
  const res = await request("POST", "/api/ticket", JSON.stringify({ profile: "ticket-added", title: "x" }), { cookie: null });
  assert.equal(res.status, 401);
  assert.equal(calls.ticket.length, n);
});

test("POST /api/ticket: validation → 400; unknown profile → 404; non-local tracker → 409; refusal → 502 with the local: prefix stripped", async () => {
  assert.equal((await request("POST", "/api/ticket", JSON.stringify({ profile: "ticket-added", title: "  " }))).status, 400);
  assert.equal((await request("POST", "/api/ticket", JSON.stringify({ profile: "ticket-added" }))).status, 400);
  assert.equal((await request("POST", "/api/ticket", JSON.stringify({ profile: "ticket-added", title: "x", step: 7 }))).status, 400);
  assert.equal((await request("POST", "/api/ticket", JSON.stringify({ profile: "ticket-added", title: "x", blockedBy: " " }))).status, 400);
  assert.equal((await request("POST", "/api/ticket", JSON.stringify({ profile: "ticket-added", title: "x", body: "x".repeat(50 * 1024) }))).status, 400);
  assert.equal((await request("POST", "/api/ticket", JSON.stringify({ profile: "nope", title: "x" }))).status, 404);
  assert.equal((await request("POST", "/api/ticket", JSON.stringify({ profile: "ticket-notlocal", title: "x" }))).status, 409);
  const refused = await request("POST", "/api/ticket", JSON.stringify({ profile: "ticket-fail", title: "x", step: "nope" }));
  assert.equal(refused.status, 502);
  assert.equal(JSON.parse(refused.body).error, `no step "nope" in the pipeline`);
});
