import { describe, it, expect } from "vitest";
import { buildHome } from "./home";
import type { ProfileView, TicketRow } from "./contract";

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();

function profile(name: string, over: Partial<ProfileView> = {}): ProfileView {
  return {
    name, label: name, up: true, pid: 1, port: null, tracker: null, ingress: null, fullAuto: null, color: "sky", emoji: "💻", maxConcurrent: 2, startedAt: null,
    updatedAt: null, active: 0, queued: 0, paused: false, restartPending: false, lastEvent: null, configPath: null, createdAt: null,
    lastSeenAt: null, ghost: false, configMissing: false, died: false, recentCosts: [], forge: null, recentRuns: [], quotaPaused: null, quota: null, ...over,
  };
}
const ticket = (profileName: string, ref: string, status: TicketRow["status"]): TicketRow => ({
  profile: profileName, ref, displayId: ref, title: null, step: null, status, model: null, startedAt: null, costUsd: 0, estUsd: 0, trackerUrl: null, prUrl: null, summary: null, plain: null, options: null, heldReason: null, heldAt: null, failReason: null, prState: null, prNeeds: null, finishedAt: null, queuePos: null, queuedAt: null, epic: null,
});

describe("buildHome", () => {
  it("orders active cards by needs-you, then running agents, then name", () => {
    const home = buildHome(
      {
        profiles: [profile("c", { active: 1 }), profile("a", { active: 0 }), profile("b", { active: 2 }), profile("d")],
        tickets: [ticket("d", "1", "held"), ticket("d", "2", "failed"), ticket("a", "3", "held")],
      },
      NOW,
    );
    expect(home.active.map((c) => c.profile.name)).toEqual(["d", "a", "b", "c"]);
    expect(home.inactive).toEqual([]);
  });

  it("scopes numbers to the profile and flags failed", () => {
    const home = buildHome({ profiles: [profile("a"), profile("b")], tickets: [ticket("a", "1", "held"), ticket("b", "2", "failed")] }, NOW);
    const byName = Object.fromEntries(home.active.map((c) => [c.profile.name, c]));
    expect(byName.a).toMatchObject({ hasFailed: false, summary: { needsYou: 1 } });
    expect(byName.b).toMatchObject({ hasFailed: true, summary: { needsYou: 1 } });
  });

  it("puts down profiles in the inactive strip unless something needs a human", () => {
    const home = buildHome(
      { profiles: [profile("up"), profile("down", { up: false, pid: null }), profile("ghost", { up: false, ghost: true }), profile("sad", { up: false })], tickets: [ticket("sad", "1", "failed")] },
      NOW,
    );
    // Up profiles outrank a stopped one with items, whatever the counts (decided below).
    expect(home.active.map((c) => c.profile.name)).toEqual(["up", "sad"]);
    expect(home.inactive.map((c) => c.profile.name)).toEqual(["down", "ghost"]);
  });

  it("an up profile always sorts before a not-up one, whatever the needs-you counts", () => {
    const tickets = Array.from({ length: 44 }, (_, i) => ticket("busy", String(i), "held"));
    const home = buildHome({ profiles: [profile("quiet", { up: true }), profile("busy", { up: false, pid: 1234 })], tickets }, NOW);
    expect(home.active.map((c) => c.profile.name)).toEqual(["quiet", "busy"]);
  });

  it("orders stopped-with-items profiles among themselves by needs-you desc", () => {
    const home = buildHome(
      {
        profiles: [profile("up"), profile("low", { up: false, pid: 1 }), profile("high", { up: false, pid: 2 })],
        tickets: [ticket("low", "1", "held"), ticket("high", "1", "held"), ticket("high", "2", "held")],
      },
      NOW,
    );
    expect(home.active.map((c) => c.profile.name)).toEqual(["up", "high", "low"]);
  });

  it("puts a died profile first, even with 0 needs-you, above an up profile with items", () => {
    const home = buildHome(
      { profiles: [profile("up", { died: false }), profile("crashed", { up: false, pid: 999, died: true })], tickets: [ticket("up", "1", "held")] },
      NOW,
    );
    expect(home.active.map((c) => c.profile.name)).toEqual(["crashed", "up"]);
    expect(home.active[0]).toMatchObject({ died: true });
  });

  it("never marks a config-missing stopped profile as died, and never ranks it above an up profile", () => {
    const home = buildHome(
      {
        profiles: [profile("up"), profile("missing", { up: false, pid: 1234, configMissing: true, died: false })],
        tickets: [ticket("missing", "1", "held")],
      },
      NOW,
    );
    expect(home.active.map((c) => c.profile.name)).toEqual(["up", "missing"]);
    expect(home.active.find((c) => c.profile.name === "missing")).toMatchObject({ died: false });
  });

  it("keeps a stopped profile with 0 items in the inactive strip", () => {
    const home = buildHome({ profiles: [profile("quiet", { up: false, pid: null })], tickets: [] }, NOW);
    expect(home.active).toEqual([]);
    expect(home.inactive.map((c) => c.profile.name)).toEqual(["quiet"]);
  });
});
