import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` view model — buildRows / readProfileState / buildSnapshot over fixture state
// dirs in a temp registry (never ~/.agenthook), plus the heartbeat `repository` derivation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRows, buildSnapshot, readEventsTail, readProfileState } from "../src/ui/rows.js";
import { profileDir } from "../src/ui/logs.js";
import { repositoryOf } from "../src/heartbeat.js";
import { uiPort, checkBundle, DEFAULT_PORT } from "../src/commands/ui.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ah-ui-rows-"));

/** @param {string} dir @param {Record<string, any>} files */
function writeState(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, v] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof v === "string" ? v : JSON.stringify(v));
  }
}

/** @param {any[]} events */
const jsonl = (events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

/** @param {Partial<import('../src/ui/rows.js').ProfileState>} s */
const state = (s) => ({ running: {}, queue: [], held: {}, refmeta: {}, events: [], ...s });

/** @param {import('../src/ui/contract.js').TicketRow[]} rows @param {string} ref */
const row = (rows, ref) => {
  const r = rows.find((x) => x.ref === ref);
  assert.ok(r, `row for ${ref}`);
  return r;
};

test("buildRows: one status per source, with precedence running > queued > held > terminal > idle", () => {
  const rows = buildRows(
    "p",
    state({
      running: { r1: { stepId: "code", startedAt: "2026-10-01T00:00:00Z", model: "opus" }, r6: { stepId: "review", startedAt: "t" } },
      queue: [{ kind: "pipeline", ref: "r2", stepId: "review", dedupKey: "k" }],
      held: { r3: { stepId: "triage", reason: "which db?", heldAt: "t" }, r6: { stepId: "code", heldAt: "t" } },
      refmeta: { r7: { displayId: "#7", title: "Seven" } },
      events: [
        { ts: "a", event: "run_start", ref: "r4", step: "code", model: "sonnet" },
        { ts: "b", event: "run_end", ref: "r4", step: "code", outcome: "fail" },
        { ts: "c", event: "failed", ref: "r4", step: "code", reason: "x", name: "Four" },
        { ts: "d", event: "pipeline_done", ref: "r5", step: "done", name: "Five" },
        { ts: "e", event: "merged", ref: "r8", step: "", name: "Eight" },
      ],
    }),
  );
  assert.equal(row(rows, "r1").status, "running");
  assert.equal(row(rows, "r1").step, "code");
  assert.equal(row(rows, "r1").model, "opus");
  assert.equal(row(rows, "r1").startedAt, "2026-10-01T00:00:00Z");
  assert.equal(row(rows, "r2").status, "queued");
  assert.equal(row(rows, "r2").step, "review");
  assert.equal(row(rows, "r3").status, "held");
  assert.equal(row(rows, "r3").heldReason, "which db?");
  assert.equal(row(rows, "r3").step, "triage");
  assert.equal(row(rows, "r4").status, "failed");
  assert.equal(row(rows, "r4").model, "sonnet");
  assert.equal(row(rows, "r4").startedAt, "a");
  assert.equal(row(rows, "r4").title, "Four");
  assert.equal(row(rows, "r5").status, "done");
  assert.equal(row(rows, "r5").step, "done");
  assert.equal(row(rows, "r8").status, "done");
  assert.equal(row(rows, "r6").status, "running"); // running beats held
  assert.equal(row(rows, "r6").step, "review");
  assert.equal(row(rows, "r7").status, "idle");
  assert.equal(row(rows, "r7").step, null);
  assert.equal(rows.length, 8);
});

test("buildRows: up:false reads running as interrupted and queued as stalled; held/terminal/idle unchanged", () => {
  const s = state({
    running: { r1: { stepId: "code", startedAt: "t" } },
    queue: [{ kind: "pipeline", ref: "r2", stepId: "review", dedupKey: "k" }],
    held: { r3: { stepId: "triage", reason: "?", heldAt: "t" } },
    events: [{ ts: "a", event: "pipeline_done", ref: "r5", step: "done", name: "Five" }],
  });
  const down = buildRows("p", s, { up: false });
  assert.equal(row(down, "r1").status, "interrupted");
  assert.equal(row(down, "r2").status, "stalled");
  assert.equal(row(down, "r3").status, "held");
  assert.equal(row(down, "r5").status, "done");

  const explicitUp = buildRows("p", s, { up: true });
  assert.equal(row(explicitUp, "r1").status, "running");
  assert.equal(row(explicitUp, "r2").status, "queued");

  const defaulted = buildRows("p", s);
  assert.equal(row(defaulted, "r1").status, "running");
  assert.equal(row(defaulted, "r2").status, "queued");
});

test("buildRows: a terminal event followed by a re-run no longer counts", () => {
  const rows = buildRows(
    "p",
    state({
      events: [
        { ts: "a", event: "failed", ref: "r", step: "code" },
        { ts: "b", event: "run_start", ref: "r", step: "code" },
        { ts: "c", event: "run_end", ref: "r", step: "code", outcome: "advance" },
      ],
    }),
  );
  assert.equal(row(rows, "r").status, "idle");
});

test("buildRows: displayId falls back to ref; costUsd sums run_end; trackerUrl only from refmeta.url", () => {
  const rows = buildRows(
    "p",
    state({
      refmeta: { a: { displayId: "#94", title: "T" }, b: { url: "https://app.asana.com/0/1/2" }, c: { url: "javascript:alert(1)" } },
      events: [
        { ts: "1", event: "run_end", ref: "a", step: "code", costUsd: 1.25 },
        { ts: "2", event: "run_end", ref: "a", step: "review", costUsd: 0.5 },
        { ts: "3", event: "run_end", ref: "a", step: "review" },
        { ts: "4", event: "run_start", ref: "b", step: "code" },
      ],
    }),
  );
  assert.equal(row(rows, "a").displayId, "#94");
  assert.equal(row(rows, "a").title, "T");
  assert.equal(row(rows, "a").costUsd, 1.75);
  assert.equal(row(rows, "a").trackerUrl, null);
  assert.equal(row(rows, "b").displayId, "b");
  assert.equal(row(rows, "b").costUsd, 0);
  assert.equal(row(rows, "b").trackerUrl, "https://app.asana.com/0/1/2");
  assert.equal(row(rows, "c").trackerUrl, null); // non-http(s) is never a link
});

test("buildRows: prUrl needs both a well-formed repository and refmeta.pr", () => {
  const s = state({ refmeta: { a: { pr: 12 }, b: {} } });
  assert.equal(row(buildRows("p", s, { repository: "Jesuso/agenthook" }), "a").prUrl, "https://github.com/Jesuso/agenthook/pull/12");
  assert.equal(row(buildRows("p", s, { repository: "Jesuso/agenthook" }), "b").prUrl, null);
  assert.equal(row(buildRows("p", s), "a").prUrl, null);
  assert.equal(row(buildRows("p", s, { repository: "evil.com/x/y" }), "a").prUrl, null);
  assert.equal(row(buildRows("p", s, { repository: "a/b?x" }), "a").prUrl, null);
});

test("buildRows: prototype-named refs don't resolve through Object.prototype", () => {
  const rows = buildRows("p", state({ events: [{ ts: "1", event: "run_end", ref: "constructor", step: "code" }] }));
  assert.equal(row(rows, "constructor").status, "idle");
});

test("readEventsTail parses only the tail and drops the partial first line", () => {
  const dir = tmp();
  const file = path.join(dir, "events.jsonl");
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(JSON.stringify({ ts: String(i), event: "enqueued", ref: `r${i}`, step: "code" }));
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const lineLen = lines[150].length + 1;
  // A byte budget that lands mid-line: the 50 last full lines plus a fragment of the one before.
  const tail = readEventsTail(file, lineLen * 50 + 5);
  assert.equal(tail.length, 50);
  assert.equal(tail[0].ref, "r150");
  assert.equal(tail.at(-1)?.ref, "r199");
  // Exactly on a line boundary the first line is complete and kept.
  const exact = readEventsTail(file, lines.slice(150).join("\n").length + 1);
  assert.equal(exact[0].ref, "r150");
  assert.equal(exact.length, 50);
});

test("readEventsTail skips garbage lines; missing file → []", () => {
  const dir = tmp();
  const file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, `not json\n${JSON.stringify({ ts: "1", event: "run_start", ref: "a" })}\n[1,2]\n{"ts":"2"}\n{"ref":`);
  const ev = readEventsTail(file);
  assert.deepEqual(ev.map((e) => e.ref), ["a"]);
  assert.deepEqual(readEventsTail(path.join(dir, "nope.jsonl")), []);
});

test("readProfileState: missing or garbage state files read as empty without throwing", () => {
  const dir = tmp();
  assert.deepEqual(readProfileState(dir), { running: {}, queue: [], held: {}, refmeta: {}, events: [] });
  writeState(dir, { "running.json": "{oops", "queue.json": { not: "array" }, "held.json": [1], "refmeta.json": "null", "events.jsonl": "\0\0\0" });
  assert.deepEqual(readProfileState(dir), { running: {}, queue: [], held: {}, refmeta: {}, events: [] });
  writeState(dir, { "queue.json": [null, 3, { ref: "q", stepId: "code" }] });
  assert.deepEqual(readProfileState(dir).queue, [{ ref: "q", stepId: "code" }]);
});

test("buildSnapshot: profiles expose only ProfileView fields; tickets carry PR links from the heartbeat", () => {
  const reg = tmp();
  writeState(path.join(reg, "live"), {
    "heartbeat.json": {
      name: "live",
      pid: 1,
      port: 8787,
      url: "https://secret-tunnel.ngrok.app",
      tracker: "github",
      ingress: "ngrok",
      fullAuto: true,
      repoPath: "/home/u/secret/repo",
      repos: [{ id: "default", path: "/home/u/secret/repo" }],
      repository: "Jesuso/agenthook",
      startedAt: "s",
      updatedAt: "u",
      queue: { active: 2, queued: 1 },
      lastEvent: { at: "t", kind: "pipeline", ref: "9", step: "code", extra: "/home/u/secret" },
    },
    "server.pid": String(process.pid),
    "secrets.json": { "/github": "hunter2" },
    "refmeta.json": { 9: { displayId: "#9", title: "Nine", pr: 42 } },
  });
  writeState(path.join(reg, "down"), { "held.json": { x: { stepId: "triage", reason: "?", heldAt: "t" } } });

  const snap = buildSnapshot(reg);
  assert.deepEqual(snap.profiles.map((p) => p.name), ["down", "live"]);
  const live = snap.profiles[1];
  assert.match(String(live.createdAt), /^\d{4}-\d\d-\d\dT/); // the dir's birth time (no profile.json)
  assert.deepEqual(live, {
    name: "live",
    label: "live",
    up: true,
    pid: process.pid,
    port: 8787,
    tracker: "github",
    ingress: "ngrok",
    fullAuto: true,
    maxConcurrent: null,
    startedAt: "s",
    updatedAt: "u",
    active: 2,
    queued: 1,
    lastEvent: { at: "t", kind: "pipeline", ref: "9", step: "code" },
    configPath: null,
    createdAt: live.createdAt,
    lastSeenAt: null, // heartbeat.updatedAt "u" isn't a timestamp
    ghost: false,
    configMissing: false,
  });
  const down = snap.profiles[0];
  assert.equal(down.up, false);
  assert.equal(down.port, null);
  assert.equal(down.tracker, null);

  const json = JSON.stringify(snap);
  for (const leak of ["ngrok.app", "/home/u", "hunter2", "repoPath", "secrets"]) assert.ok(!json.includes(leak), `snapshot leaks ${leak}`);

  assert.equal(row(snap.tickets, "9").prUrl, "https://github.com/Jesuso/agenthook/pull/42");
  assert.equal(row(snap.tickets, "9").profile, "live");
  assert.equal(row(snap.tickets, "x").status, "held");
  assert.equal(row(snap.tickets, "x").profile, "down");
  assert.deepEqual(buildSnapshot(path.join(reg, "missing")), { profiles: [], tickets: [] });
});

test("buildSnapshot: a down profile's running/queued refs read interrupted/stalled; an up profile's read running/queued", () => {
  const reg = tmp();
  writeState(path.join(reg, "up"), {
    "heartbeat.json": { name: "up" },
    "server.pid": String(process.pid),
    "running.json": { r1: { stepId: "code", startedAt: "t" } },
    "queue.json": [{ kind: "pipeline", ref: "r2", stepId: "review", dedupKey: "k" }],
  });
  writeState(path.join(reg, "down"), {
    "heartbeat.json": { name: "down" },
    "server.pid": "999999999",
    "running.json": { r3: { stepId: "code", startedAt: "t" } },
    "queue.json": [{ kind: "pipeline", ref: "r4", stepId: "review", dedupKey: "k" }],
  });

  const snap = buildSnapshot(reg);
  assert.equal(row(snap.tickets, "r1").status, "running");
  assert.equal(row(snap.tickets, "r2").status, "queued");
  assert.equal(row(snap.tickets, "r3").status, "interrupted");
  assert.equal(row(snap.tickets, "r4").status, "stalled");
});

test("buildSnapshot/profileView: a down profile blanks active/queued even with a stale heartbeat.queue", () => {
  const reg = tmp();
  writeState(path.join(reg, "stale"), {
    "heartbeat.json": {
      name: "stale",
      pid: 999999999,
      port: 8787,
      tracker: "github",
      ingress: "ngrok",
      fullAuto: false,
      maxConcurrent: 3,
      startedAt: "s",
      updatedAt: "u",
      queue: { active: 2, queued: 1 },
      lastEvent: null,
    },
  });
  const snap = buildSnapshot(reg);
  const p = profileNamed(snap.profiles, "stale");
  assert.equal(p.up, false);
  assert.equal(p.active, null);
  assert.equal(p.queued, null);
  assert.equal(p.maxConcurrent, 3);
});

test("buildSnapshot: name = state key, label = heartbeat name, else profile.json name; API resolves by key only", () => {
  const reg = tmp();
  writeState(path.join(reg, "Old"), { "heartbeat.json": { name: "New", pid: 999999999 }, "refmeta.json": { 7: { title: "Seven" } } });
  writeState(path.join(reg, "parked"), { "profile.json": { name: "Parked Label", stateKey: "parked" } });
  writeState(path.join(reg, "bare"), { "held.json": {} });
  const snap = buildSnapshot(reg);
  assert.deepEqual(
    snap.profiles.map((p) => [p.name, p.label]),
    [["Old", "New"], ["bare", "bare"], ["parked", "Parked Label"]],
  );
  assert.equal(row(snap.tickets, "7").profile, "Old");
  assert.equal(profileDir(reg, "Old"), path.join(reg, "Old"));
  assert.equal(profileDir(reg, "New"), null);
});

/** @param {any[]} profiles @param {string} name */
function profileNamed(profiles, name) {
  const p = profiles.find((x) => x.name === name);
  assert.ok(p, `profile ${name}`);
  return p;
}

test("repositoryOf: forge first, else a github/github-projects tracker, else null", () => {
  /** @param {any} c */
  const r = (c) => repositoryOf(c);
  assert.equal(r({ forge: { type: "github", repository: "a/b" }, provider: "github", providerConfig: { repository: "c/d" } }), "a/b");
  assert.equal(r({ forge: { type: "github", owner: "a", repo: "b" }, provider: "asana", providerConfig: {} }), "a/b");
  assert.equal(r({ provider: "github", providerConfig: { repository: "c/d" } }), "c/d");
  assert.equal(r({ provider: "github-projects", providerConfig: { owner: "c", repo: "d" } }), "c/d");
  assert.equal(r({ provider: "jira", providerConfig: { repository: "c/d" } }), null);
  assert.equal(r({ provider: "asana", providerConfig: {} }), null);
});

test("uiPort: default 4180, --port honored, junk rejected", () => {
  assert.equal(uiPort({ _: [] }), DEFAULT_PORT);
  assert.equal(uiPort({ _: [], port: "5000" }), 5000);
  for (const bad of ["abc", "0", "65536", "1.5", "-1", undefined, true]) {
    assert.throws(() => uiPort({ _: [], port: bad }), /invalid --port/);
  }
});

test("checkBundle: missing index.html names the build command", () => {
  const dir = tmp();
  assert.throws(() => checkBundle(dir), { message: "UI bundle not built — run `npm run build:ui`" });
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html>");
  assert.doesNotThrow(() => checkBundle(dir));
});

test("buildSnapshot: provenance — tildified configPath, created/last-seen from profile.json, ghost and config-missing", () => {
  const reg = tmp();
  const cfgFile = path.join(os.homedir(), `.ah-ui-rows-${process.pid}-absent.json`); // never created
  const real = path.join(tmp(), "agenthook.config.json");
  fs.writeFileSync(real, "{}");
  writeState(path.join(reg, "stopped"), {
    "profile.json": { name: "Stopped", stateKey: "stopped", configPath: real, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-03-04T00:00:00.000Z" },
  });
  writeState(path.join(reg, "moved"), { "profile.json": { name: "moved", configPath: cfgFile, createdAt: "2026-01-02T00:00:00.000Z" } });
  fs.mkdirSync(path.join(reg, "ghost", "logs"), { recursive: true });
  const snap = buildSnapshot(reg);
  const stopped = profileNamed(snap.profiles, "stopped");
  assert.equal(stopped.configPath, real);
  assert.equal(stopped.createdAt, "2026-01-02T00:00:00.000Z");
  assert.equal(stopped.lastSeenAt, "2026-03-04T00:00:00.000Z");
  assert.equal(stopped.ghost, false);
  assert.equal(stopped.configMissing, false);
  const moved = profileNamed(snap.profiles, "moved");
  assert.equal(moved.configPath, "~" + cfgFile.slice(os.homedir().length));
  assert.equal(moved.configMissing, true);
  const ghost = profileNamed(snap.profiles, "ghost");
  assert.equal(ghost.ghost, true);
  assert.equal(ghost.configPath, null);
  assert.match(String(ghost.createdAt), /^\d{4}-/);
  assert.ok(!JSON.stringify(snap).includes(os.homedir() + path.sep + ".ah-ui-rows"), "configPath is tildified");
});
