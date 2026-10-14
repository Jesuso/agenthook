import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { etagOf, pickProfile, readStatus, readProfiles, readEventsSince, waitForEvents, compactEvent, eventsCursor, readRuns, readRunLogTail } from "../src/agent-api.js";
import { readProfile } from "../src/heartbeat.js";
import net from "node:net";
import { live } from "../src/agent-api.js";
import { controlSockPath } from "../src/paths.js";

function registry() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-agentapi-"));
}

/** A profile dir with a heartbeat whose pid is this (live) process. */
function profile(reg, key, { hb = {}, running = {}, queue = [], held = {}, refmeta = {}, up = true, name = key } = {}) {
  const dir = path.join(reg, key);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ name, maxConcurrent: 3, tracker: "github", queue: { active: Object.keys(running).length, queued: queue.length }, ...hb }));
  if (up) fs.writeFileSync(path.join(dir, "server.pid"), String(process.pid));
  fs.writeFileSync(path.join(dir, "running.json"), JSON.stringify(running));
  fs.writeFileSync(path.join(dir, "queue.json"), JSON.stringify(queue));
  fs.writeFileSync(path.join(dir, "held.json"), JSON.stringify(held));
  fs.writeFileSync(path.join(dir, "refmeta.json"), JSON.stringify(refmeta));
  return dir;
}

test("etagOf: stable, ignores volatile at/ageS/etag/outTok", () => {
  const a = etagOf({ x: 1, at: "t1", ageS: 5, etag: "z", outTok: 5 });
  const b = etagOf({ x: 1, at: "t2", ageS: 99, outTok: 9000 });
  assert.equal(a, b);
  assert.notEqual(a, etagOf({ x: 2 }));
});

test("pickProfile: explicit key, label, default, sole-up fallback, ambiguity", () => {
  const reg = registry();
  profile(reg, "a", { name: "Alpha" });
  profile(reg, "b", { name: "Beta", up: false });
  assert.equal(pickProfile("a", null, reg).entry?.stateKey, "a");
  assert.equal(pickProfile("Beta", null, reg).entry?.stateKey, "b");
  assert.equal(pickProfile("beta", null, reg).entry?.stateKey, "b", "case-insensitive fallback when unique");
  assert.equal(pickProfile(undefined, "b", reg).entry?.stateKey, "b", "default key wins");
  assert.equal(pickProfile(undefined, null, reg).entry?.stateKey, "a", "the only running profile");
  profile(reg, "c");
  assert.match(String(pickProfile(undefined, null, reg).error), /profile required; known: a, b, c/);
  assert.match(String(pickProfile("zzz", null, reg).error), /unknown profile "zzz"/);
  profile(reg, "BETA2", { name: "beta", up: false });
  assert.ok(pickProfile("BETA", null, reg).error, "ambiguous case-insensitive match -> no guess");
});

test("readStatus: slots, running age, queue, held, free subtracts queued", () => {
  const reg = registry();
  const now = Date.parse("2026-01-01T01:00:00Z");
  profile(reg, "p", {
    running: { 7: { stepId: "code", startedAt: "2026-01-01T00:50:00Z", model: "m", output: 12 } },
    queue: [{ kind: "pipeline", ref: "8", stepId: "triage", dedupKey: "k" }],
    held: { 9: { stepId: "code", reason: "x".repeat(500), heldAt: "h" } },
    refmeta: { 7: { displayId: "#7", title: "Seven" } },
  });
  const s = readStatus(readProfile("p", reg), { now });
  assert.deepEqual(s.slots, { max: 3, active: 1, queued: 1, free: 1 });
  assert.equal(s.running[0].id, "#7");
  assert.equal(s.running[0].ageS, 600);
  assert.equal(s.queue[0].ref, "8");
  assert.ok(s.held[0].why.length <= 200, "reason clipped");
  assert.equal(s.etag, readStatus(readProfile("p", reg), { now: now + 60000 }).etag, "age drift does not change the etag");
});

test("readStatus: live output-token drift does not change the etag, a real change does", () => {
  const reg = registry();
  const now = Date.parse("2026-01-01T01:00:00Z");
  profile(reg, "o", {
    running: { 7: { stepId: "code", startedAt: "2026-01-01T00:50:00Z", model: "m", output: 12 } },
  });
  const before = readStatus(readProfile("o", reg), { now });
  fs.writeFileSync(path.join(reg, "o", "running.json"), JSON.stringify({ 7: { stepId: "code", startedAt: "2026-01-01T00:50:00Z", model: "m", output: 9000 } }));
  const after = readStatus(readProfile("o", reg), { now: now + 60000 });
  assert.equal(before.etag, after.etag, "outTok drift does not change the etag");

  fs.writeFileSync(path.join(reg, "o", "queue.json"), JSON.stringify([{ kind: "pipeline", ref: "8", stepId: "triage", dedupKey: "k" }]));
  const changed = readStatus(readProfile("o", reg), { now: now + 60000 });
  assert.notEqual(after.etag, changed.etag, "a real state change (queue) still changes the etag");
});

test("readStatus: a down profile reports no active/queued and a note", () => {
  const reg = registry();
  profile(reg, "d", { up: false, running: { 1: { stepId: "code", startedAt: "2026-01-01T00:00:00Z" } } });
  const s = readStatus(readProfile("d", reg));
  assert.equal(s.up, false);
  assert.equal(s.slots.active, 0);
  assert.match(String(s.note), /receiver down/);
  assert.equal(readProfiles(reg)[0].active, null);
});

test("readEventsSince: incremental cursor, whole lines only, filters, limit, truncated file", () => {
  const dir = registry();
  const f = path.join(dir, "events.jsonl");
  const ev = (event, ref, extra = {}) => JSON.stringify({ ts: "t", event, ref, step: "code", ...extra }) + "\n";
  fs.writeFileSync(f, ev("enqueued", "1") + ev("run_end", "1", { outcome: "advance" }) + '{"ts":"t","event":"run_st'); // torn tail
  const r1 = readEventsSince(dir, 0);
  assert.deepEqual(r1.events.map((e) => e.event), ["enqueued", "run_end"]);
  assert.ok(r1.cursor < fs.statSync(f).size, "cursor stops before the torn line");
  fs.appendFileSync(f, 'art","ref":"2"}\n');
  const r2 = readEventsSince(dir, r1.cursor);
  assert.deepEqual(r2.events.map((e) => e.event), ["run_start"]);
  assert.equal(r2.cursor, fs.statSync(f).size);
  assert.deepEqual(readEventsSince(dir, 0, { types: new Set(["run_end"]) }).events.length, 1);
  assert.deepEqual(readEventsSince(dir, 0, { ref: "2" }).events.length, 1);
  const lim = readEventsSince(dir, 0, { limit: 1 });
  assert.equal(lim.events.length, 1);
  assert.equal(lim.truncated, true);
  assert.equal(readEventsSince(dir, lim.cursor).events[0].event, "run_end", "limit cursor resumes at the next event");
  assert.equal(readEventsSince(dir, 10 ** 9).events.length, 3, "cursor past EOF restarts at 0");
  assert.equal(eventsCursor(dir), fs.statSync(f).size);
});

test("waitForEvents: wakes on an append, ignores non-matching lines, times out empty", async () => {
  const dir = registry();
  const f = path.join(dir, "events.jsonl");
  fs.writeFileSync(f, "");
  const line = (event) => JSON.stringify({ ts: "t", event, ref: "1" }) + "\n";
  const p = waitForEvents(dir, 0, { types: new Set(["failed"]), timeoutMs: 5000 });
  setTimeout(() => fs.appendFileSync(f, line("enqueued")), 30);
  setTimeout(() => fs.appendFileSync(f, line("failed")), 80);
  const t0 = Date.now();
  const r = await p;
  assert.equal(r.timedOut, false);
  assert.deepEqual(r.events.map((e) => e.event), ["failed"]);
  assert.ok(Date.now() - t0 < 3000);

  const quiet = await waitForEvents(dir, fs.statSync(f).size, { timeoutMs: 80 });
  assert.equal(quiet.timedOut, true);
  assert.deepEqual(quiet.events, []);
});

test("waitForEvents: an abort signal ends the wait early", async () => {
  const dir = registry();
  fs.writeFileSync(path.join(dir, "events.jsonl"), "");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const t0 = Date.now();
  const r = await waitForEvents(dir, 0, { timeoutMs: 10000, signal: ac.signal });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 2000);
});

test("compactEvent: keeps the acting keys, clips long reasons", () => {
  const c = compactEvent({ ts: "t", event: "failed", ref: "1", step: "code", reason: "r".repeat(400), url: "drop", name: "drop" });
  assert.deepEqual(Object.keys(c).sort(), ["e", "reason", "ref", "step", "ts"]);
  assert.ok(c.reason.length <= 200);
});

test("readRuns / readRunLogTail: newest run log tail, step filter, unknown ref", () => {
  const reg = registry();
  const dir = profile(reg, "p");
  const logs = path.join(dir, "logs");
  fs.writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ ts: "2026-01-01T00:00:10.000Z", event: "run_end", ref: "7", step: "code", outcome: "advance", costUsd: 1.5 }) + "\n");
  fs.writeFileSync(path.join(logs, "2026-01-01T00-00-00-000Z-step-code-7.log"), "# hdr\n" + Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const runs = readRuns("p", "7", dir, reg);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcome, "advance");
  assert.equal(runs[0].costUsd, 1.5);
  const tail = readRunLogTail("p", "7", dir, { lines: 3 }, reg);
  assert.equal(tail.tail, "line 97\nline 98\nline 99");
  assert.match(String(readRunLogTail("p", "7", dir, { step: "nope" }, reg).error), /no run log/);
  assert.match(String(readRunLogTail("p", "404", dir, {}, reg).error), /no run log/);
});

test("readStatus: free is 0 while paused / restarting / draining (nothing can start); the flag is surfaced", () => {
  const reg = registry();
  for (const flag of ["paused", "restartPending", "decommissionPending", "draining"]) {
    profile(reg, flag, { hb: { [flag]: true } });
    const s = readStatus(readProfile(flag, reg));
    assert.equal(s.slots.free, 0, `${flag} -> free 0`);
    assert.equal(s.slots.max, 3);
    assert.equal(s[flag], true);
  }
  profile(reg, "ok");
  assert.equal(readStatus(readProfile("ok", reg)).slots.free, 3);
});

test("waitForEvents: an already-aborted signal returns at once (no watch, no 120s hold)", async () => {
  const dir = registry();
  fs.writeFileSync(path.join(dir, "events.jsonl"), "");
  const ac = new AbortController();
  ac.abort();
  const t0 = Date.now();
  const r = await waitForEvents(dir, 0, { timeoutMs: 60000, signal: ac.signal });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 500);
});

test("live(): distinguishes down / timed-out (may still be running) / closed-before-reply", async () => {
  const reg = registry();
  profile(reg, "p");
  const sock = controlSockPath(path.join(reg, "p"), "p");
  await assert.rejects(() => live("p", "board", {}, { registry: reg }), /receiver for "p" is down/);
  await assert.rejects(() => live("nope", "board", {}, { registry: reg }), /unknown profile "nope"/);

  // a server that accepts and never answers
  /** @type {net.Socket[]} */ const held = [];
  const slow = net.createServer((c) => void held.push(c));
  await new Promise((r) => slow.listen(sock, () => r(undefined)));
  try {
    await assert.rejects(() => live("p", "reconcile", {}, { registry: reg, timeoutMs: 80 }), /no reply within 0\.08s — it may still be running; check status before retrying/);
  } finally {
    for (const c of held) c.destroy();
    await new Promise((r) => slow.close(() => r(undefined)));
  }

  // a server that hangs up straight away
  const hangup = net.createServer((c) => {
    held.push(c);
    c.end();
  });
  await new Promise((r) => hangup.listen(sock, () => r(undefined)));
  try {
    await assert.rejects(() => live("p", "board", {}, { registry: reg }), /closed before replying \(receiver restarting\?\)/);
  } finally {
    for (const c of held) c.destroy();
    await new Promise((r) => hangup.close(() => r(undefined)));
  }
});

test("compactEvent keeps the ci_green payload (pr, sha, mergeable, mergeState) and drops null mergeable", async () => {
  const { compactEvent } = await import("../src/agent-api.js");
  const e = compactEvent({ ts: "t", event: "ci_green", ref: "1", step: "", pr: 7, sha: "abc", mergeable: false, mergeState: "dirty", runId: 9 });
  assert.deepEqual(e, { ts: "t", e: "ci_green", ref: "1", pr: 7, sha: "abc", mergeable: false, mergeState: "dirty" });
  assert.equal("mergeable" in compactEvent({ ts: "t", event: "ci_green", ref: "1", pr: 7, mergeable: null }), false);
});

test("readStatus lists real failures (not cancels, dismissed or re-run ones) as failed[] with why", async () => {
  const { readStatus } = await import("../src/agent-api.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-failed-"));
  const ev = [
    { ts: "2026-10-13T10:00:00Z", event: "failed", ref: "a", step: "code", reason: "exit 1" },
    { ts: "2026-10-13T11:00:00Z", event: "failed", ref: "b", step: "triage", reason: "cancelled by operator" },
    { ts: "2026-10-13T12:00:00Z", event: "failed", ref: "c", step: "code", reason: "boom" },
    { ts: "2026-10-13T12:01:00Z", event: "dismissed", ref: "c", step: "" },
    { ts: "2026-10-13T13:00:00Z", event: "failed", ref: "d", step: "code", reason: "later" },
    { ts: "2026-10-13T13:05:00Z", event: "run_start", ref: "d", step: "code" },
  ];
  fs.writeFileSync(path.join(dir, "events.jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const s = readStatus({ dir, stateKey: "p", up: true, heartbeat: {} });
  assert.deepEqual(s.failed?.map((f) => [f.ref, f.step, f.why]), [["a", "code", "exit 1"]]);
  fs.rmSync(dir, { recursive: true, force: true });
});
