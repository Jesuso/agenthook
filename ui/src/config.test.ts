import { describe, it, expect } from "vitest";
import type { ProfileView } from "./contract";
import {
  RESTART_IDLE,
  bannerStatus,
  configEventAsFile,
  configSaveRequest,
  configUrl,
  moveTarget,
  parseCheck,
  queueToggleRequest,
  releaseOutcome,
  releaseRequest,
  restartErrorText,
  restartReducer,
  restartRequest,
  restartText,
  retryOutcome,
  retryRequest,
  sensitiveDiff,
} from "./config";
import type { ConfigEvent, RestartAction, RestartState } from "./config";
import { classifySaveResponse, freshSave, saveReducer, saveStatus } from "./save";

const cfg = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "p",
    fullAuto: false,
    tracker: { type: "github", token: "${GH_TOKEN}", userGid: "me" },
    sinks: [{ url: "${HOOK_URL}" }, { botToken: "${BOT}" }],
    ...over,
  });

describe("release", () => {
  it("posts {profile, ref} and adds a comment only when it has text", () => {
    const body = (c: string) => JSON.parse(String(releaseRequest("p", "42", c).init.body));
    expect(releaseRequest("p", "42", "").url).toBe("/api/release");
    expect(body("")).toEqual({ profile: "p", ref: "42" });
    expect(body("  \n ")).toEqual({ profile: "p", ref: "42" });
    expect(body("use Postgres")).toEqual({ profile: "p", ref: "42", comment: "use Postgres" });
    expect(releaseRequest("p", "42", "x").init.method).toBe("POST");
  });

  it("maps every status to an outcome", () => {
    expect(releaseOutcome("#42", 200, { step: "triage" })).toEqual({ ok: true, text: "Released #42 → re-running triage" });
    expect(releaseOutcome("#42", 200, {})).toEqual({ ok: true, text: "Released #42" });
    expect(releaseOutcome("#42", 502, { error: "42 cannot be released: not held" })).toEqual({ ok: false, error: "42 cannot be released: not held" });
    expect(releaseOutcome("#42", 502, null)).toEqual({ ok: false, error: "the receiver refused" });
    expect(releaseOutcome("#42", 503, null)).toMatchObject({ ok: false, error: expect.stringContaining("not running") });
    expect(releaseOutcome("#42", 504, null)).toMatchObject({ ok: false, error: expect.stringContaining("in time") });
    expect(releaseOutcome("#42", 0, null)).toEqual({ ok: false, error: "network error" });
    expect(releaseOutcome("#42", 418, null)).toEqual({ ok: false, error: "release failed (status 418)" });
  });
});

describe("retry", () => {
  it("POST /api/retry with the guard headers and {profile, ref}", () => {
    const { url, init } = retryRequest("p", "42");
    expect(url).toBe("/api/retry");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ profile: "p", ref: "42" });
  });

  it("maps every status to an outcome", () => {
    expect(retryOutcome("#42", 200, { step: "code" })).toEqual({ ok: true, text: "Re-running #42 · code" });
    expect(retryOutcome("#42", 502, { error: "42 is not assigned to us" })).toEqual({ ok: false, error: "42 is not assigned to us" });
    expect(retryOutcome("#42", 503, null)).toMatchObject({ ok: false, error: expect.stringContaining("not running") });
    expect(retryOutcome("#42", 418, null)).toEqual({ ok: false, error: "re-run failed (status 418)" });
  });
});

describe("requests", () => {
  it("configUrl encodes the profile", () => {
    expect(configUrl("a b")).toBe("/api/config?profile=a+b");
  });

  it("PUT /api/config with the guard headers and {profile, baseHash, text}", () => {
    const { url, init } = configSaveRequest("p", "h1", "{}");
    expect(url).toBe("/api/config");
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-AH-UI": "1" });
    expect(JSON.parse(String(init.body))).toEqual({ profile: "p", baseHash: "h1", text: "{}" });
  });

  it("POST /api/restart with {profile}", () => {
    const { url, init } = restartRequest("p");
    expect(url).toBe("/api/restart");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-AH-UI": "1" });
    expect(JSON.parse(String(init.body))).toEqual({ profile: "p" });
  });

  it("POST /api/restart with {profile, moveTo} for a state-dir move", () => {
    const { init } = restartRequest("old", "new");
    expect(JSON.parse(String(init.body))).toEqual({ profile: "old", moveTo: "new" });
  });

  it("POST /api/pause and /api/resume with {profile}, guarded", () => {
    for (const cmd of ["pause", "resume"] as const) {
      const { url, init } = queueToggleRequest(cmd, "p");
      expect(url).toBe(`/api/${cmd}`);
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({ "Content-Type": "application/json", "X-AH-UI": "1" });
      expect(JSON.parse(String(init.body))).toEqual({ profile: "p" });
    }
  });
});

describe("moveTarget", () => {
  it("is the label when it differs from the state key", () => {
    expect(moveTarget({ name: "new", stateId: "old" }, "old")).toBe("new");
  });

  it("is null when the label already is the state key, or there's no usable label", () => {
    expect(moveTarget({ name: "same" }, "same")).toBeNull();
    expect(moveTarget({ name: 5 }, "k")).toBeNull();
    expect(moveTarget({ name: "" }, "k")).toBeNull();
    expect(moveTarget(null, "k")).toBeNull();
    expect(moveTarget("x", "k")).toBeNull();
  });
});

describe("parseCheck", () => {
  it("ok with the parsed value, or the parse error", () => {
    expect(parseCheck('{"a":1}')).toEqual({ ok: true, raw: { a: 1 } });
    const bad = parseCheck("{");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^invalid JSON: /);
  });
});

describe("bannerStatus", () => {
  it("no problems → ok", () => {
    expect(bannerStatus(null, [], [])).toEqual({ ok: true });
  });

  it("a parse error wins the row, but still counts checks and server errors (the overlay renders all three)", () => {
    expect(bannerStatus("invalid JSON: x", ["a check"], ["a server error"])).toEqual({
      ok: false,
      first: "invalid JSON: x",
      fullFirst: "invalid JSON: x",
      moreCount: 2,
      amber: false,
      summary: false,
    });
  });

  it("checks and server errors combine, first + remaining count", () => {
    expect(bannerStatus(null, ["check one", "check two"], ["server one"])).toEqual({
      ok: false,
      first: "check one",
      fullFirst: "check one",
      moreCount: 2,
      amber: false,
      summary: false,
    });
  });

  it("truncates a long first problem but keeps the full text for the title", () => {
    const long = "x".repeat(150);
    const r = bannerStatus(null, [long], []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.first.length).toBe(100);
      expect(r.first.endsWith("…")).toBe(true);
      expect(r.fullFirst).toBe(long);
    }
  });

  it("a single short check: no more problems, but fullFirst still equals first (no truncation)", () => {
    const r = bannerStatus(null, ["one check"], []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.moreCount).toBe(0);
      expect(r.fullFirst).toBe(r.first);
    }
  });
});

describe("bannerStatus with the open pane's cards", () => {
  const sink = 'config: sinks[0] (slack) requires "url".';
  const digest = "config: digest.access must be one of …";
  const ctx = (onCard: string[], incomplete: string[] = []) => ({ onCard: (e: string) => onCard.includes(e), incomplete: (e: string) => incomplete.includes(e) });

  it("every problem on a visible card → a count, not the text", () => {
    expect(bannerStatus(null, [sink], [], ctx([sink]))).toEqual({
      ok: false,
      first: "1 problem — see the highlighted cards",
      fullFirst: "1 problem — see the highlighted cards",
      moreCount: 0,
      amber: false,
      summary: true,
    });
    const two = bannerStatus(null, [sink, "b"], [], ctx([sink, "b"]));
    expect(!two.ok && two.first).toBe("2 problems — see the highlighted cards");
  });

  it("amber only when every problem is a pristine card's", () => {
    expect(bannerStatus(null, [sink], [], ctx([sink], [sink]))).toMatchObject({ amber: true, summary: true });
    expect(bannerStatus(null, [sink, digest], [], ctx([sink], [sink]))).toMatchObject({ amber: false, first: digest });
  });

  it("an unattributed problem leads the row; the count still covers the overlay's whole list", () => {
    expect(bannerStatus(null, [sink, digest], [], ctx([sink]))).toMatchObject({ first: digest, moreCount: 1, summary: false });
  });

  it("off the card's pane (Raw, another tab), the card error is listed as before, amber if pristine", () => {
    expect(bannerStatus(null, [sink], [], ctx([], [sink]))).toMatchObject({ first: sink, amber: true, summary: false });
  });

  it("a parse error still wins the row", () => {
    expect(bannerStatus("invalid JSON: x", [sink], [], ctx([sink], [sink]))).toMatchObject({ first: "invalid JSON: x", amber: false, summary: false });
  });
});

describe("sensitiveDiff", () => {
  it("no sensitive change → []", () => {
    expect(sensitiveDiff(cfg(), cfg({ maxConcurrent: 3 }))).toEqual([]);
  });

  it("a renamed profile is shown in clear (the server blocks the save outright)", () => {
    expect(sensitiveDiff(cfg(), cfg({ name: "q" }))).toEqual([{ path: "name", from: '"p"', to: '"q"' }]);
  });

  it("a non-secret scalar is shown in clear", () => {
    expect(sensitiveDiff(cfg(), cfg({ fullAuto: true }))).toEqual([{ path: "fullAuto", from: "false", to: "true" }]);
  });

  it("expands sinks[*] to concrete indices; ${VAR} refs are shown", () => {
    const next = cfg({ sinks: [{ url: "${HOOK_URL}" }, { botToken: "${OTHER}" }] });
    expect(sensitiveDiff(cfg(), next)).toEqual([{ path: "sinks[1].botToken", from: '"${BOT}"', to: '"${OTHER}"' }]);
  });

  it("never renders a literal secret value", () => {
    const next = cfg({ tracker: { type: "github", token: "ghp_SECRET", userGid: "me" }, sinks: [{ url: "https://hooks.example/abc" }, { botToken: "${BOT}" }] });
    const d = sensitiveDiff(cfg(), next);
    expect(d).toEqual([
      { path: "tracker.token", from: '"${GH_TOKEN}"', to: "(changed)" },
      { path: "sinks[0].url", from: '"${HOOK_URL}"', to: "(changed)" },
    ]);
    expect(JSON.stringify(d)).not.toMatch(/ghp_SECRET|hooks\.example/);
    // literal → literal, and literal → removed
    const lit = cfg({ tracker: { type: "github", token: "old-secret", userGid: "me" } });
    expect(sensitiveDiff(lit, next)[0]).toEqual({ path: "tracker.token", from: "(set)", to: "(changed)" });
    expect(sensitiveDiff(lit, cfg({ tracker: { type: "github", userGid: "me" } }))).toEqual([{ path: "tracker.token", from: "(set)", to: "(unset)" }]);
  });

  it("reports additions and removals", () => {
    const added = cfg({ sinks: [{ url: "${HOOK_URL}" }, { botToken: "${BOT}" }, { botToken: "lit" }] });
    expect(sensitiveDiff(cfg(), added)).toEqual([{ path: "sinks[2].botToken", from: "(unset)", to: "(set)" }]);
    expect(sensitiveDiff(cfg(), cfg({ sinks: [] }))).toEqual([
      { path: "sinks[0].url", from: '"${HOOK_URL}"', to: "(unset)" },
      { path: "sinks[1].botToken", from: '"${BOT}"', to: "(unset)" },
    ]);
    expect(sensitiveDiff(cfg(), cfg({ claudeBin: "/bin/claude" }))).toEqual([{ path: "claudeBin", from: "(unset)", to: '"/bin/claude"' }]);
  });

  it("a step's bin is shown in clear; its env names variables, never values", () => {
    const tracker = (step: Record<string, unknown>) => ({ type: "github", token: "${GH_TOKEN}", userGid: "me", pipeline: [{ id: "triage" }, { id: "code", ...step }] });
    expect(sensitiveDiff(cfg({ tracker: tracker({}) }), cfg({ tracker: tracker({ bin: "claude-local" }) }))).toEqual([
      { path: "tracker.pipeline[1].bin", from: "(unset)", to: '"claude-local"' },
    ]);
    const a = cfg({ tracker: tracker({ env: { API_KEY: "sk-LITERAL" } }) });
    const b = cfg({ tracker: tracker({ env: { API_KEY: "sk-OTHER", CLAUDE_CONFIG_DIR: "/x" } }) });
    const added = sensitiveDiff(cfg({ tracker: tracker({}) }), a);
    expect(added).toEqual([{ path: "tracker.pipeline[1].env", from: "(unset)", to: "{API_KEY}" }]);
    expect(sensitiveDiff(a, b)).toEqual([{ path: "tracker.pipeline[1].env", from: "{API_KEY}", to: "{API_KEY, CLAUDE_CONFIG_DIR}" }]);
    const valueOnly = sensitiveDiff(a, cfg({ tracker: tracker({ env: { API_KEY: "sk-OTHER" } }) }));
    expect(valueOnly).toEqual([{ path: "tracker.pipeline[1].env", from: "{API_KEY}", to: "(changed)" }]);
    expect(JSON.stringify([added, valueOnly, sensitiveDiff(a, b)])).not.toMatch(/sk-|\/x/);
  });

  it("a service's env names variables, never values; its image is a secret-style change", () => {
    const sandbox = (db: Record<string, unknown>) => ({ type: "podman", services: { db: { image: "postgres:16.4", ...db } } });
    const a = cfg({ sandbox: sandbox({ env: { POSTGRES_PASSWORD: "hunter2" } }) });
    const b = cfg({ sandbox: sandbox({ image: "postgres:16.5", env: { POSTGRES_PASSWORD: "other" } }) });
    const diff = sensitiveDiff(a, b);
    expect(diff).toEqual([
      { path: "sandbox.services.db.image", from: "(set)", to: "(changed)" },
      { path: "sandbox.services.db.env", from: "{POSTGRES_PASSWORD}", to: "(changed)" },
    ]);
    expect(JSON.stringify(diff)).not.toMatch(/hunter2|other/);
  });

  it("an unparseable old text reports every sensitive path present in the new one", () => {
    expect(sensitiveDiff("{", cfg()).map((c) => c.path)).toEqual(["name", "fullAuto", "tracker.userGid", "tracker.token", "sinks[0].url", "sinks[1].botToken"]);
  });

  it("an unparseable new text reports nothing", () => {
    expect(sensitiveDiff(cfg(), "{")).toEqual([]);
  });
});

describe("configEventAsFile", () => {
  it("adapts a config event to the instructions shape the save flow keys on", () => {
    const ev: ConfigEvent = { type: "config", profile: "p", hash: "h2", source: "disk" };
    expect(configEventAsFile(ev, "/c/agenthook.config.json")).toEqual({ type: "instructions", profile: "p", path: "/c/agenthook.config.json", hash: "h2", source: "disk" });
  });
});

describe("save flow through the config adapter", () => {
  const open = { profile: "p", path: "/c/agenthook.config.json", content: cfg(), baseHash: "h1" };
  const saving = [{ type: "edit", buffer: cfg({ name: "q" }) }, { type: "save" }, { type: "confirm" }] as const;
  const run = (...actions: Parameters<typeof saveReducer>[1][]) => actions.reduce(saveReducer, freshSave(open));

  it("422 → invalid → failed: back to editing, buffer kept, nothing based on a new hash", () => {
    expect(classifySaveResponse(422)).toBe("invalid");
    const s = run(...saving, { type: "failed" });
    expect(s.phase).toEqual({ kind: "editing" });
    expect(saveStatus(s)).toBe("dirty");
    expect(s.buffer).toBe(cfg({ name: "q" }));
    expect(s.open).toEqual(open);
  });

  it("own save echo (source ui, the saved hash) raises no banner", () => {
    const echo = configEventAsFile({ type: "config", profile: "p", hash: "h2", source: "ui" }, open.path);
    const s = run(...saving, { type: "external", ev: echo }, { type: "saved", hash: "h2" });
    expect(saveStatus(s)).toBe("clean");
  });

  it("an external edit reloads a clean buffer silently and banners a dirty one", () => {
    const ext = configEventAsFile({ type: "config", profile: "p", hash: "h3", source: "disk" }, open.path);
    expect(run({ type: "external", ev: ext }).phase).toEqual({ kind: "stale", hash: "h3" });
    expect(run({ type: "edit", buffer: "{}" }, { type: "external", ev: ext }).phase).toEqual({ kind: "conflict", hash: "h3", content: null });
  });
});

const prof = (over: Partial<ProfileView>): ProfileView => ({
  name: "p",
  label: "p",
  up: true,
  pid: 100,
  port: null,
  tracker: null,
  ingress: null,
  fullAuto: null,
  color: "sky",
  emoji: "💻",
  maxConcurrent: null,
  startedAt: null,
  updatedAt: null,
  active: 0,
  queued: 0,
  paused: false,
  restartPending: false,
  lastEvent: null,
  configPath: null,
  createdAt: null,
  lastSeenAt: null,
  ghost: false,
  configMissing: false,
  recentCosts: [],
  forge: null,
  recentRuns: [], quotaPaused: null, quota: null,
  ...over,
});
const runR = (s: RestartState, ...a: RestartAction[]) => a.reduce(restartReducer, s);
const requesting = runR(RESTART_IDLE, { type: "request", pid: 100 });

describe("restartReducer", () => {
  it("idle → requesting (captures the pid)", () => {
    expect(requesting).toEqual({ kind: "requesting", pid: 100 });
    // A second click while in flight is ignored.
    expect(restartReducer(requesting, { type: "request", pid: 5 })).toBe(requesting);
  });

  it("200 → pending{active}, alreadyPending too", () => {
    expect(restartReducer(requesting, { type: "response", status: 200, body: { accepted: true, active: 2, queued: 1 } })).toEqual({ kind: "pending", pid: 100, active: 2 });
    expect(restartReducer(requesting, { type: "response", status: 200, body: { accepted: true, alreadyPending: true, active: 1, queued: 0 } })).toEqual({
      kind: "pending",
      pid: 100,
      active: 1,
    });
  });

  it("502/503/504/other → error with a readable message (502 carries the receiver's text)", () => {
    const err = (status: number, body: any = null) => restartReducer(requesting, { type: "response", status, body });
    expect(err(502, { error: "config: tracker.pipeline is required" })).toEqual({ kind: "error", message: "Restart refused by the receiver: config: tracker.pipeline is required" });
    expect(err(503)).toEqual({ kind: "error", message: restartErrorText(503, null) });
    expect(restartErrorText(503, null)).toMatch(/not running/);
    expect(restartErrorText(504, null)).toMatch(/didn't answer/);
    expect(restartErrorText(0, null)).toMatch(/network/);
    expect(restartErrorText(403, null)).toBe("Restart failed (status 403)");
    expect(restartErrorText(502, {})).toMatch(/unknown error/);
  });

  it("pending: profile updates refresh active; restart_requested sets it", () => {
    const pending = restartReducer(requesting, { type: "response", status: 200, body: { active: 2 } });
    expect(restartReducer(pending, { type: "profile", profile: prof({ active: 1 }) })).toEqual({ kind: "pending", pid: 100, active: 1 });
    expect(restartReducer(requesting, { type: "event", event: { event: "restart_requested", active: 3, queued: 0 } })).toEqual({ kind: "pending", pid: 100, active: 3 });
    expect(restartReducer(pending, { type: "event", event: { event: "run_end" } })).toBe(pending);
  });

  it("restarting on the restarting event or the profile going down", () => {
    const pending = restartReducer(requesting, { type: "response", status: 200, body: { active: 0 } });
    expect(restartReducer(pending, { type: "event", event: { event: "restarting", queued: 0 } })).toEqual({ kind: "restarting", pid: 100 });
    expect(restartReducer(pending, { type: "profile", profile: prof({ up: false, pid: null }) })).toEqual({ kind: "restarting", pid: 100 });
  });

  it("SSE beating the POST reply: a late 200 doesn't step back", () => {
    const r = runR(requesting, { type: "event", event: { event: "restarting" } }, { type: "response", status: 200, body: { active: 0 } });
    expect(r).toEqual({ kind: "restarting", pid: 100 });
  });

  it("up only on a live, different pid", () => {
    const restarting = runR(requesting, { type: "event", event: { event: "restarting" } });
    expect(restartReducer(restarting, { type: "profile", profile: prof({ pid: 100 }) })).toBe(restarting);
    expect(restartReducer(restarting, { type: "profile", profile: prof({ up: false, pid: 200 }) })).toBe(restarting);
    expect(restartReducer(restarting, { type: "profile", profile: prof({ pid: 200 }) })).toEqual({ kind: "up" });
    // Straight from pending when the down update was missed.
    const pending = restartReducer(requesting, { type: "response", status: 200, body: { active: 0 } });
    expect(restartReducer(pending, { type: "profile", profile: prof({ pid: 201 }) })).toEqual({ kind: "up" });
  });

  it("ignores SSE and profile updates when nothing is in flight; reset → idle", () => {
    expect(restartReducer(RESTART_IDLE, { type: "event", event: { event: "restarting" } })).toBe(RESTART_IDLE);
    expect(restartReducer(RESTART_IDLE, { type: "profile", profile: prof({ up: false }) })).toBe(RESTART_IDLE);
    expect(restartReducer(requesting, { type: "reset" })).toEqual({ kind: "idle" });
    const up: RestartState = { kind: "up" };
    expect(restartReducer(up, { type: "request", pid: 200 })).toEqual({ kind: "requesting", pid: 200 });
  });

  it("restartText", () => {
    expect(restartText(RESTART_IDLE)).toBeNull();
    expect(restartText({ kind: "pending", pid: 1, active: 1 })).toBe("restart pending (1 agent running)");
    expect(restartText({ kind: "pending", pid: 1, active: 2 })).toBe("restart pending (2 agents running)");
    expect(restartText({ kind: "restarting", pid: 1 })).toBe("restarting…");
    expect(restartText({ kind: "error", message: "x" })).toBe("x");
    expect(restartText({ kind: "up" })).toBe("up — the new config is live");
    expect(restartText({ kind: "up" }, "restarted")).toBe("restarted");
  });
});
