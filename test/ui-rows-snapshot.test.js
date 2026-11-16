import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` view model — buildSnapshot (the registry-wide scan over per-profile state dirs)
// and profileView (the per-profile shaping it and `ah ui` share), plus the small helpers
// (repositoryOf, uiPort, checkBundle) they lean on.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveIdentity } from "../src/identity.js";
import { buildSnapshot, profileView, RECENT_COSTS_MS } from "../src/ui/rows.js";
import { profileDir } from "../src/ui/logs.js";
import { repositoryOf } from "../src/heartbeat.js";
import { uiPort, checkBundle, DEFAULT_PORT } from "../src/commands/ui.js";
import { tmp, writeState, row } from "./_ui-rows-helpers.js";

/** @param {any[]} events */
const jsonl = (events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

/** @param {any[]} profiles @param {string} name */
function profileNamed(profiles, name) {
  const p = profiles.find((x) => x.name === name);
  assert.ok(p, `profile ${name}`);
  return p;
}

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
      quotaPaused: { window: "sevenDay", utilization: 0.95, threshold: 0.9, resetsAt: "2026-10-20T00:00:00.000Z", extra: "/home/u/secret" },
    },
    "server.pid": String(process.pid),
    "secrets.json": { "/github": "hunter2" },
    "refmeta.json": { 9: { displayId: "#9", title: "Nine", pr: 42 } },
  });
  writeState(path.join(reg, "down"), {
    "held.json": { x: { stepId: "triage", reason: "?", heldAt: "t" } },
    "quota.json": { sevenDay: { utilization: 0.66, resetsAt: "2026-10-20T00:00:00.000Z", path: "/home/u/secret" }, fiveHour: { utilization: "x", resetsAt: "y" }, asOf: "2026-10-18T10:00:00.000Z" },
  });

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
    color: deriveIdentity("live").color,
    emoji: deriveIdentity("live").emoji,
    maxConcurrent: null,
    startedAt: "s",
    updatedAt: "u",
    active: 2,
    queued: 1,
    paused: false,
    quotaPaused: { window: "sevenDay", utilization: 0.95, threshold: 0.9, resetsAt: "2026-10-20T00:00:00.000Z" },
    quota: null,
    restartPending: false,
    lastEvent: { at: "t", kind: "pipeline", ref: "9", step: "code" },
    configPath: null,
    createdAt: live.createdAt,
    lastSeenAt: null, // heartbeat.updatedAt "u" isn't a timestamp
    ghost: false,
    configMissing: false,
    died: false,
    forge: null,
    recentRuns: [],
    recentCosts: [],
    ticketSteps: null,
  });
  const down = snap.profiles[0];
  assert.equal(down.up, false);
  assert.equal(down.port, null);
  assert.equal(down.tracker, null);
  // quota.json outlives the heartbeat: shown while down, validated numbers only.
  assert.deepEqual(down.quota, { sevenDay: { utilization: 0.66, resetsAt: "2026-10-20T00:00:00.000Z" }, asOf: "2026-10-18T10:00:00.000Z" });
  assert.equal(down.quotaPaused, null);

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

test("profileView: paused/restartPending are booleans when up (restartPending = restart/decommission/drain), null when down", () => {
  const view = (/** @type {boolean} */ up, /** @type {any} */ heartbeat) => {
    const v = profileView({ name: "p", pid: 1, up, heartbeat });
    return [v.paused, v.restartPending];
  };
  assert.deepEqual(view(true, {}), [false, false]);
  assert.deepEqual(view(true, null), [false, false]);
  assert.deepEqual(view(true, { paused: true }), [true, false]);
  assert.deepEqual(view(true, { paused: "yes" }), [false, false]); // booleans only
  for (const flag of ["restartPending", "decommissionPending", "draining"]) assert.deepEqual(view(true, { [flag]: true }), [false, true], flag);
  // A dead heartbeat keeps its last flags: never read as live state.
  assert.deepEqual(view(false, { paused: true, restartPending: true, draining: true }), [null, null]);
});

test("profileView: died — down with a dead pid in the pidfile, unless config-missing or a ghost", () => {
  assert.equal(profileView({ name: "p", pid: 1234, up: false, heartbeat: null }).died, true);
  assert.equal(profileView({ name: "p", pid: 1, up: true, heartbeat: null }).died, false); // up
  assert.equal(profileView({ name: "p", pid: 0, up: false, heartbeat: null }).died, false); // no pidfile pid
  assert.equal(profileView({ name: "p", pid: 1234, up: false, heartbeat: null, configMissing: true }).died, false);
  assert.equal(profileView({ name: "p", pid: 1234, up: false, heartbeat: null, ghost: true }).died, false);
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

test("profileView: recentCosts = run_end with a finite costUsd and a parseable ts within 48 h, oldest first", () => {
  const now = Date.parse("2026-10-08T12:00:00.000Z");
  const ago = (/** @type {number} */ ms) => new Date(now - ms).toISOString();
  const events = [
    { ts: ago(RECENT_COSTS_MS + 1), event: "run_end", ref: "a", costUsd: 9 }, // too old
    { ts: ago(RECENT_COSTS_MS), event: "run_end", ref: "a", costUsd: 0.5 },
    { ts: ago(60_000), event: "run_start", ref: "b", costUsd: 7 }, // not a run_end
    { ts: ago(50_000), event: "run_end", ref: "b" }, // no cost
    { ts: ago(40_000), event: "run_end", ref: "b", costUsd: "1" },
    { ts: ago(30_000), event: "run_end", ref: "b", costUsd: null },
    { ts: "garbage", event: "run_end", ref: "b", costUsd: 3 },
    { event: "run_end", ref: "b", costUsd: 3 },
    { ts: ago(1000), event: "run_end", ref: "c", costUsd: 1.25 },
  ];
  const base = { name: "p", pid: 0, up: false, heartbeat: null };
  assert.deepEqual(profileView({ ...base, events, now }).recentCosts, [
    { at: ago(RECENT_COSTS_MS), costUsd: 0.5, estUsd: 0 },
    { at: ago(1000), costUsd: 1.25, estUsd: 0 },
  ]);
  assert.deepEqual(profileView(base).recentCosts, []);
});

test("buildSnapshot: recentCosts comes from the profile's events tail (down profiles too)", () => {
  const reg = tmp();
  const ts = new Date(Date.now() - 60_000).toISOString();
  writeState(path.join(reg, "p"), {
    "events.jsonl": jsonl([
      { ts, event: "run_start", ref: "1", step: "code" },
      { ts, event: "run_end", ref: "1", step: "code", outcome: "advance", costUsd: 0.42 },
    ]),
  });
  writeState(path.join(reg, "q"), {});
  const snap = buildSnapshot(reg);
  assert.deepEqual(profileNamed(snap.profiles, "p").recentCosts, [{ at: ts, costUsd: 0.42, estUsd: 0 }]);
  assert.deepEqual(profileNamed(snap.profiles, "q").recentCosts, []);
});

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

test("buildSnapshot: a stopped profile's tracker falls back to the marker's provider; up falls back too, absent either", () => {
  const reg = tmp();
  writeState(path.join(reg, "stopped-local"), { "profile.json": { name: "stopped-local", stateKey: "stopped-local", provider: "local" } });
  writeState(path.join(reg, "stopped-bare"), { "profile.json": { name: "stopped-bare", stateKey: "stopped-bare" } });
  const snap = buildSnapshot(reg);
  assert.equal(profileNamed(snap.profiles, "stopped-local").tracker, "local");
  assert.equal(profileNamed(snap.profiles, "stopped-bare").tracker, null);
});

test("profileView: colour / emoji come from the heartbeat's ui when valid, else derive from the state key", () => {
  const view = (/** @type {any} */ heartbeat) => profileView({ name: "k", pid: 1, up: true, heartbeat });
  const d = deriveIdentity("k");
  assert.deepEqual([view(null).color, view(null).emoji], [d.color, d.emoji]);
  assert.deepEqual([view({ ui: { color: "pink", emoji: "🦊" } }).color, view({ ui: { color: "pink", emoji: "🦊" } }).emoji], ["pink", "🦊"]);
  // invalid / foreign values never reach the browser; null fields fall back per field
  const odd = view({ ui: { color: "#ff0000", emoji: "<script>" } });
  assert.deepEqual([odd.color, odd.emoji], [d.color, d.emoji]);
  assert.equal(view({ ui: { color: null, emoji: "🦊" } }).color, d.color);
  assert.equal(view({ ui: "nope" }).color, d.color);
});
