import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `ah ui` view model — buildRows / readProfileState / buildSnapshot over fixture state
// dirs in a temp registry (never ~/.agenthook), plus the heartbeat `repository` derivation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveIdentity } from "../src/identity.js";
import { buildRows, buildSnapshot, profileView, readEventsTail, readProfileState, recentRuns, RECENT_COSTS_MS } from "../src/ui/rows.js";
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

test("buildRows: epic from refmeta.epic — name falls back to ref, non-http url dropped, malformed → null", () => {
  const rows = buildRows(
    "p",
    state({
      refmeta: {
        a: { epic: { ref: "E1", name: "Epics", url: "https://app.asana.com/0/1/E1" } },
        b: { epic: { ref: "E2", url: "javascript:alert(1)" } },
        c: { title: "no epic" },
        d: { epic: { ref: "", name: "empty ref" } },
        e: { epic: "E3" },
        f: { epic: { ref: 7, name: "numeric ref" } },
        g: { epic: { ref: "E4", name: 9, url: 9 } },
      },
    }),
  );
  assert.deepEqual(row(rows, "a").epic, { ref: "E1", name: "Epics", url: "https://app.asana.com/0/1/E1" });
  assert.deepEqual(row(rows, "b").epic, { ref: "E2", name: "E2", url: null });
  for (const ref of ["c", "d", "e", "f"]) assert.equal(row(rows, ref).epic, null, ref);
  assert.deepEqual(row(rows, "g").epic, { ref: "E4", name: "E4", url: null });
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
  assert.deepEqual(readProfileState(dir), { running: {}, queue: [], held: {}, refmeta: {}, quota: null, events: [] });
  writeState(dir, { "running.json": "{oops", "queue.json": { not: "array" }, "held.json": [1], "refmeta.json": "null", "quota.json": [1], "events.jsonl": "\0\0\0" });
  assert.deepEqual(readProfileState(dir), { running: {}, queue: [], held: {}, refmeta: {}, quota: null, events: [] });
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
    forge: null,
    recentRuns: [],
    recentCosts: [],
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

test("buildRows: an operator cancel reads cancelled, not failed; dismissed clears failed/cancelled; a re-run supersedes it", () => {
  const rows = buildRows(
    "p",
    state({
      events: [
        { ts: "1", event: "failed", ref: "c", step: "triage", reason: "cancelled by operator" },
        { ts: "2", event: "failed", ref: "f", step: "code", reason: "exit 1" },
        { ts: "3", event: "failed", ref: "fd", step: "code", reason: "exit 1" },
        { ts: "4", event: "dismissed", ref: "fd", step: "", by: "operator" },
        { ts: "5", event: "failed", ref: "cd", step: "code", reason: "cancelled by operator" },
        { ts: "6", event: "dismissed", ref: "cd", step: "", by: "operator" },
        { ts: "7", event: "dismissed", ref: "dn", step: "" },
        { ts: "8", event: "pipeline_done", ref: "dn", step: "done" },
        { ts: "9", event: "failed", ref: "again", step: "code", reason: "exit 1" },
        { ts: "10", event: "dismissed", ref: "again", step: "" },
        { ts: "11", event: "failed", ref: "again", step: "code", reason: "exit 2" },
      ],
    }),
  );
  assert.equal(row(rows, "c").status, "cancelled");
  assert.equal(row(rows, "f").status, "failed");
  assert.equal(row(rows, "fd").status, "idle");
  assert.equal(row(rows, "cd").status, "idle");
  assert.equal(row(rows, "dn").status, "done", "dismiss never touches a done ticket");
  assert.equal(row(rows, "again").status, "failed", "a failure after a dismiss counts again");
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

test("buildRows: prState / finishedAt follow pipeline_done → merged, and a re-run clears them", () => {
  const rows = buildRows(
    "p",
    state({
      events: [
        { ts: "2026-10-08T09:00:00.000Z", event: "pipeline_done", ref: "ready", step: "done" },
        { ts: "2026-10-08T08:00:00.000Z", event: "pipeline_done", ref: "merged", step: "done" },
        { ts: "2026-10-08T10:00:00.000Z", event: "merged", ref: "merged", step: "" },
        { ts: "2026-10-08T07:00:00.000Z", event: "merged", ref: "merge-only", step: "" },
        { ts: "2026-10-08T06:00:00.000Z", event: "pipeline_done", ref: "rerun", step: "done" },
        { ts: "2026-10-08T07:00:00.000Z", event: "run_start", ref: "rerun", step: "code" },
        { ts: "2026-10-08T07:30:00.000Z", event: "failed", ref: "bad", step: "code", reason: "tests red" },
      ],
    }),
  );
  assert.deepEqual([row(rows, "ready").prState, row(rows, "ready").finishedAt], ["ready", "2026-10-08T09:00:00.000Z"]);
  // the finish stays the pipeline_done ts; the later merge only flips prState
  assert.deepEqual([row(rows, "merged").prState, row(rows, "merged").finishedAt], ["merged", "2026-10-08T08:00:00.000Z"]);
  assert.deepEqual([row(rows, "merge-only").prState, row(rows, "merge-only").finishedAt], ["merged", "2026-10-08T07:00:00.000Z"]);
  const rerun = row(rows, "rerun");
  assert.deepEqual([rerun.status, rerun.prState, rerun.finishedAt], ["idle", null, null]);
  assert.deepEqual([row(rows, "bad").prState, row(rows, "bad").finishedAt], [null, null]);
});

test("buildRows: refmeta.prState merged/closed overrides an event-derived ready; absent → still ready", () => {
  const done = (/** @type {string} */ ref) => ({ ts: "2026-10-08T09:00:00.000Z", event: "pipeline_done", ref, step: "done" });
  const rows = buildRows(
    "p",
    state({
      refmeta: { m: { pr: 1, prState: "merged" }, c: { pr: 2, prState: "closed" }, r: { pr: 3 }, odd: { pr: 4, prState: "weird" }, idle: { pr: 5, prState: "merged" } },
      events: [done("m"), done("c"), done("r"), done("odd")],
    }),
  );
  assert.deepEqual(["m", "c", "r", "odd"].map((ref) => row(rows, ref).prState), ["merged", "closed", "ready", "ready"]);
  assert.equal(row(rows, "m").status, "done");
  assert.equal(row(rows, "idle").prState, null, "no finish → no PR state, whatever refmeta says");
});

test("buildRows: failReason only while failed/cancelled; queuePos is the place in queue.json", () => {
  const rows = buildRows(
    "p",
    state({
      queue: [
        { kind: "pipeline", ref: "q0", stepId: "code", dedupKey: "a" },
        { kind: "pipeline", ref: "q1", stepId: "code", dedupKey: "b" },
      ],
      events: [
        { ts: "1", event: "failed", ref: "f", step: "code", reason: "tests red" },
        { ts: "2", event: "failed", ref: "c", step: "code", reason: "cancelled by operator" },
        { ts: "3", event: "failed", ref: "d", step: "code", reason: "x" },
        { ts: "4", event: "dismissed", ref: "d", step: "" },
      ],
    }),
  );
  assert.equal(row(rows, "f").failReason, "tests red");
  assert.equal(row(rows, "c").failReason, "cancelled by operator");
  assert.equal(row(rows, "d").failReason, null); // dismissed → idle
  assert.equal(row(buildRows("p", state({ held: { h: { stepId: "triage", reason: "?", heldAt: "2026-10-08T07:00:00Z" } } })), "h").heldAt, "2026-10-08T07:00:00Z");
  assert.deepEqual([row(rows, "q0").queuePos, row(rows, "q1").queuePos, row(rows, "f").queuePos], [0, 1, null]);
});

test("recentRuns: run_end within 48 h with its outcome, oldest first; garbage ts or other events are skipped", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const events = [
    { ts: "2026-10-05T12:00:00Z", event: "run_end", outcome: "advance" }, // too old
    { ts: "2026-10-07T13:00:00Z", event: "run_end", outcome: "changes" },
    { ts: "garbage", event: "run_end", outcome: "advance" },
    { ts: "2026-10-08T11:00:00Z", event: "run_start" },
    { ts: "2026-10-08T11:30:00Z", event: "run_end" },
  ];
  assert.deepEqual(recentRuns(events, now), [
    { at: "2026-10-07T13:00:00.000Z", outcome: "changes" },
    { at: "2026-10-08T11:30:00.000Z", outcome: null },
  ]);
});

test("profileView: forge is the heartbeat's forge type, else null", () => {
  assert.equal(profileView({ name: "k", pid: 1, up: true, heartbeat: { forge: "github" } }).forge, "github");
  assert.equal(profileView({ name: "k", pid: 1, up: true, heartbeat: {} }).forge, null);
});

test("buildRows: summary comes from refmeta, is bounded, and is null for non-strings/absent", () => {
  const rows = buildRows(
    "p",
    state({ refmeta: { a: { summary: "What it is about." }, b: { summary: "x".repeat(900) }, c: { summary: 7 }, d: { title: "T" } } }),
  );
  const by = Object.fromEntries(rows.map((r) => [r.ref, r.summary]));
  assert.equal(by.a, "What it is about.");
  assert.equal(by.b?.length, 300);
  assert.equal(by.c, null);
  assert.equal(by.d, null);
});

test("buildRows: plain is the newest run_end's sentence only while its outcome matches the status (#563)", () => {
  const end = (/** @type {string} */ ref, /** @type {string} */ outcome, /** @type {string} */ ts, plain = `${ref} ${outcome}`) => ({ ts, event: "run_end", ref, step: "code", outcome, plain });
  const rows = buildRows(
    "p",
    state({
      running: { run: { stepId: "review", startedAt: "t" } },
      queue: [{ kind: "pipeline", ref: "q", stepId: "review", dedupKey: "k" }],
      held: { h: { stepId: "code", reason: "which db?" }, hx: { stepId: "code", reason: "cap" }, none: { stepId: "code" } },
      events: [
        end("run", "advance", "a"),
        end("q", "changes", "a"),
        end("h", "advance", "a", "older"),
        end("h", "hold", "b"),
        end("hx", "changes", "a"), // the changes cap turned it into a hold
        end("f", "fail", "a"),
        { ts: "b", event: "failed", ref: "f", step: "code", reason: "tests red" },
        end("fc", "fail", "a"),
        { ts: "b", event: "failed", ref: "fc", step: "code", reason: "cancelled by operator" },
        end("d", "advance", "a"),
        { ts: "b", event: "pipeline_done", ref: "d", step: "code" },
        end("dx", "advance", "a"),
        { ts: "b", event: "failed", ref: "dx", step: "code", reason: "move refused" },
        end("i", "advance", "a"),
        { ts: "a", event: "run_end", ref: "none", step: "code", outcome: "hold" },
      ],
    }),
  );
  assert.equal(row(rows, "run").plain, "run advance", "running: the previous step's sentence");
  assert.equal(row(rows, "q").plain, "q changes", "queued: any outcome");
  assert.equal(row(rows, "h").plain, "h hold", "the newest run_end wins");
  assert.equal(row(rows, "hx").plain, null, "held, but the run said changes");
  assert.equal(row(rows, "f").plain, "f fail");
  assert.equal(row(rows, "fc").status, "cancelled");
  assert.equal(row(rows, "fc").plain, null, "cancelled shows none");
  assert.equal(row(rows, "d").plain, "d advance");
  assert.equal(row(rows, "dx").plain, null, "failed, but the run said advance");
  assert.equal(row(rows, "i").status, "idle");
  assert.equal(row(rows, "i").plain, null, "idle shows none");
  assert.equal(row(rows, "none").status, "held");
  assert.equal(row(rows, "none").plain, null, "a matching run_end with no plain");
});

test("buildRows: options is the newest run_end's options only while held with a hold outcome; re-validated defensively (#565)", () => {
  const end = (/** @type {string} */ ref, /** @type {string} */ outcome, /** @type {any} */ options) => ({ ts: "a", event: "run_end", ref, step: "code", outcome, options });
  const rows = buildRows(
    "p",
    state({
      held: {
        h: { stepId: "code", reason: "which db?" },
        hx: { stepId: "code", reason: "cap" },
        hbad: { stepId: "code", reason: "x" },
        hnone: { stepId: "code", reason: "x" },
      },
      events: [
        end("h", "hold", ["Postgres", "SQLite"]),
        end("hx", "changes", ["Postgres", "SQLite"]), // the changes cap turned it into a hold without a matching run_end
        end("d", "advance", ["Postgres", "SQLite"]),
        end("hbad", "hold", ["only one"]),
        end("hbad2", "hold", "not an array"),
        end("hlong", "hold", ["x".repeat(90), "y".repeat(90)]),
      ],
    }),
  );
  assert.deepEqual(row(rows, "h").options, ["Postgres", "SQLite"], "held + hold outcome → kept");
  assert.equal(row(rows, "hx").status, "held");
  assert.equal(row(rows, "hx").options, null, "held, but the newest run_end outcome is \"changes\", not \"hold\" → null");
  assert.equal(row(rows, "d").status, "idle");
  assert.equal(row(rows, "d").options, null, "not held → null even with a hold-shaped run_end elsewhere");
  assert.equal(row(rows, "hnone").options, null, "held, no run_end options → null");
  assert.equal(row(rows, "hbad").options, null, "held, but options is 1 entry → null (re-validated)");
  assert.equal(row(rows, "hbad2").status, "idle", "no held record for this ref");
  assert.equal(row(rows, "hbad2").options, null, "not held → null regardless of the malformed run_end options");

  const longRows = buildRows("p", state({ held: { hlong: { stepId: "code", reason: "x" } }, events: [end("hlong", "hold", ["x".repeat(90), "y".repeat(90)])] }));
  assert.deepEqual(row(longRows, "hlong").options, ["x".repeat(80), "y".repeat(80)], "each entry sliced to 80 chars");
});
