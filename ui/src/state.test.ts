import { describe, it, expect } from "vitest";
import { applyEvent } from "./state";
import type { ProfileView, Snapshot, UiEvent } from "./contract";

function profile(overrides: Partial<ProfileView> & { name: string }): ProfileView {
  return {
    label: overrides.name,
    up: true,
    pid: 1,
    port: 8787,
    tracker: "github",
    ingress: "ngrok",
    fullAuto: false,
    maxConcurrent: 1,
    startedAt: "s",
    updatedAt: "u",
    active: 0,
    queued: 0,
    lastEvent: null,
    configPath: null,
    createdAt: null,
    lastSeenAt: null,
    ghost: false,
    configMissing: false,
    recentCosts: [],
    ...overrides,
  };
}

describe("applyEvent", () => {
  it("upserts a new profile, inserted in name order", () => {
    const state: Snapshot = { profiles: [profile({ name: "a" }), profile({ name: "c" })], tickets: [] };
    const next = applyEvent(state, { type: "profile", profile: profile({ name: "b" }) });
    expect(next.profiles.map((p) => p.name)).toEqual(["a", "b", "c"]);
  });

  it("replaces an existing profile instead of duplicating it", () => {
    const state: Snapshot = { profiles: [profile({ name: "a", active: 1 })], tickets: [] };
    const next = applyEvent(state, { type: "profile", profile: profile({ name: "a", active: 5 }) });
    expect(next.profiles.length).toBe(1);
    expect(next.profiles[0].active).toBe(5);
  });

  it("profile_removed drops the profile and its tickets", () => {
    const state: Snapshot = {
      profiles: [profile({ name: "a" }), profile({ name: "b" })],
      tickets: [
        { profile: "a", ref: "1", displayId: "1", title: null, step: null, status: "idle", model: null, startedAt: null, costUsd: 0, trackerUrl: null, prUrl: null, heldReason: null },
        { profile: "b", ref: "2", displayId: "2", title: null, step: null, status: "idle", model: null, startedAt: null, costUsd: 0, trackerUrl: null, prUrl: null, heldReason: null },
      ],
    };
    const next = applyEvent(state, { type: "profile_removed", name: "a" });
    expect(next.profiles.map((p) => p.name)).toEqual(["b"]);
    expect(next.tickets.map((t) => t.profile)).toEqual(["b"]);
  });

  it("leaves state unchanged for an unrelated event type", () => {
    const state: Snapshot = { profiles: [profile({ name: "a" })], tickets: [] };
    const ev: UiEvent = { type: "event", profile: "a", event: { ts: "1" } };
    const next = applyEvent(state, ev);
    expect(next).toBe(state);
  });

  it("does not mutate its input", () => {
    const state: Snapshot = { profiles: [profile({ name: "a" })], tickets: [] };
    const frozenProfiles = [...state.profiles];
    applyEvent(state, { type: "profile", profile: profile({ name: "b" }) });
    expect(state.profiles).toEqual(frozenProfiles);
  });

  function ticket(overrides: Partial<Snapshot["tickets"][number]> & { profile: string; ref: string }): Snapshot["tickets"][number] {
    return {
      displayId: overrides.ref,
      title: null,
      step: null,
      status: "idle",
      model: null,
      startedAt: null,
      costUsd: 0,
      trackerUrl: null,
      prUrl: null,
      heldReason: null,
      ...overrides,
    };
  }

  it("ticket upserts by (profile, ref)", () => {
    const state: Snapshot = { profiles: [], tickets: [ticket({ profile: "a", ref: "1", status: "running" })] };
    const next = applyEvent(state, { type: "ticket", ticket: ticket({ profile: "a", ref: "1", status: "done" }) });
    expect(next.tickets.length).toBe(1);
    expect(next.tickets[0].status).toBe("done");
  });

  it("ticket appends a new (profile, ref)", () => {
    const state: Snapshot = { profiles: [], tickets: [ticket({ profile: "a", ref: "1" })] };
    const next = applyEvent(state, { type: "ticket", ticket: ticket({ profile: "a", ref: "2" }) });
    expect(next.tickets.map((t) => t.ref)).toEqual(["1", "2"]);
  });

  it("ticket_removed drops only the matching (profile, ref)", () => {
    const state: Snapshot = {
      profiles: [],
      tickets: [ticket({ profile: "a", ref: "1" }), ticket({ profile: "b", ref: "1" })],
    };
    const next = applyEvent(state, { type: "ticket_removed", profile: "a", ref: "1" });
    expect(next.tickets).toEqual([ticket({ profile: "b", ref: "1" })]);
  });
});
