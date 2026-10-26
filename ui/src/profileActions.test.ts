import { describe, it, expect } from "vitest";
import type { ProfileView } from "./contract";
import { RESTART_IDLE } from "./config";
import type { RestartState } from "./config";
import { queueToggleText, restartsReducer, rowActions } from "./profileActions";
import type { Restarts } from "./profileActions";

const prof = (over: Partial<ProfileView> = {}): ProfileView => ({
  name: "p",
  label: "P",
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

describe("rowActions", () => {
  it("everything is enabled on an idle, up, unpaused profile; the toggle offers pause", () => {
    expect(rowActions(prof(), RESTART_IDLE, false)).toEqual({ restartDisabled: false, toggle: "pause", toggleDisabled: false });
  });

  it("a down receiver disables every action", () => {
    const a = rowActions(prof({ up: false, pid: null, paused: null, restartPending: null }), RESTART_IDLE, false);
    expect(a.restartDisabled).toBe(true);
    expect(a.toggleDisabled).toBe(true);
    expect(a.toggle).toBe("pause");
  });

  it("paused → the toggle offers resume", () => {
    expect(rowActions(prof({ paused: true }), RESTART_IDLE, false).toggle).toBe("resume");
  });

  it("restart is disabled while one is in flight here, pending on the heartbeat, or a removal is pending", () => {
    const busy: RestartState[] = [
      { kind: "requesting", pid: 100 },
      { kind: "pending", pid: 100, active: 1 },
      { kind: "restarting", pid: 100 },
    ];
    for (const s of busy) expect(rowActions(prof(), s, false).restartDisabled).toBe(true);
    expect(rowActions(prof(), { kind: "error", message: "x" }, false).restartDisabled).toBe(false);
    expect(rowActions(prof({ restartPending: true }), RESTART_IDLE, false).restartDisabled).toBe(true);
    expect(rowActions(prof(), RESTART_IDLE, true).restartDisabled).toBe(true);
    // Pause/resume stays available through all of that.
    expect(rowActions(prof({ restartPending: true }), RESTART_IDLE, true).toggleDisabled).toBe(false);
  });
});

describe("restartsReducer", () => {
  const one = (m: Restarts, profile: string, action: any) => restartsReducer(m, { type: "one", profile, action });

  it("tracks per-profile restart state; events for an idle profile are no-ops", () => {
    const m = one({}, "a", { type: "request", pid: 100 });
    expect(m).toEqual({ a: { kind: "requesting", pid: 100 } });
    expect(one(m, "b", { type: "event", event: { event: "restarting" } })).toBe(m);
    const pending = one(m, "a", { type: "response", status: 200, body: { active: 2 } });
    expect(pending.a).toEqual({ kind: "pending", pid: 100, active: 2 });
    expect(one(pending, "a", { type: "event", event: { event: "restarting" } }).a).toEqual({ kind: "restarting", pid: 100 });
  });

  it("an error response lands as error; reset drops the entry", () => {
    const m = one(one({}, "a", { type: "request", pid: 100 }), "a", { type: "response", status: 503, body: null });
    expect(m.a.kind).toBe("error");
    expect(one(m, "a", { type: "reset" })).toEqual({});
  });

  it("profiles: a new pid → up; a vanished profile is dropped; untracked profiles add nothing", () => {
    const m = one(one({}, "p", { type: "request", pid: 100 }), "gone", { type: "request", pid: 5 });
    const next = restartsReducer(m, { type: "profiles", profiles: [prof({ pid: 200 }), prof({ name: "other" })] });
    expect(next).toEqual({ p: { kind: "up" } });
    const same = restartsReducer({}, { type: "profiles", profiles: [prof()] });
    expect(same).toEqual({});
  });
});

describe("queueToggleText", () => {
  it("success", () => {
    expect(queueToggleText("pause", "P", 200, { paused: true })).toBe("Paused new runs on P");
    expect(queueToggleText("resume", "P", 200, { paused: false })).toBe("Resumed P");
  });

  it("a 200 with a note (locked resume) reads as refused, not success", () => {
    const t = queueToggleText("resume", "P", 200, { paused: true, note: "a restart/decommission/shutdown holds the queue; not resumed" });
    expect(t).toBe("Resume refused for P: a restart/decommission/shutdown holds the queue; not resumed");
  });

  it("errors: 503 / 504 / 502 / network / other", () => {
    expect(queueToggleText("pause", "P", 503, { error: "receiver not running" })).toMatch(/Pause failed: .*not running/);
    expect(queueToggleText("pause", "P", 504, null)).toMatch(/didn't answer in time/);
    expect(queueToggleText("resume", "P", 502, { error: "nope" })).toBe("Resume refused by the receiver: nope");
    expect(queueToggleText("resume", "P", 502, {})).toBe("Resume refused by the receiver: unknown error");
    expect(queueToggleText("pause", "P", 0, null)).toBe("Pause failed (network error)");
    expect(queueToggleText("pause", "P", 403, null)).toBe("Pause failed (status 403)");
  });
});

describe("queueToggleText in Spanish", () => {
  it("reads in Spanish with the receiver's detail as written", () => {
    expect(queueToggleText("pause", "P", 200, { paused: true }, "es")).toBe("Se pausaron las ejecuciones nuevas en P");
    expect(queueToggleText("resume", "P", 502, { error: "nope" }, "es")).toBe("El receptor rechazó reanudar: nope");
    expect(queueToggleText("pause", "P", 403, null, "es")).toBe("No se pudo pausar (estado 403)");
  });
});
