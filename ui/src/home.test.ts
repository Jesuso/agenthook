import { describe, it, expect } from "vitest";
import { buildHome } from "./home";
import type { ProfileView, TicketRow } from "./contract";

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();

function profile(name: string, over: Partial<ProfileView> = {}): ProfileView {
  return {
    name, label: name, up: true, pid: 1, port: null, tracker: null, ingress: null, fullAuto: null, color: "sky", emoji: "💻", maxConcurrent: 2, startedAt: null,
    updatedAt: null, active: 0, queued: 0, paused: false, restartPending: false, lastEvent: null, configPath: null, createdAt: null,
    lastSeenAt: null, ghost: false, configMissing: false, recentCosts: [], forge: null, recentRuns: [], quotaPaused: null, quota: null, ...over,
  };
}
const ticket = (profileName: string, ref: string, status: TicketRow["status"]): TicketRow => ({
  profile: profileName, ref, displayId: ref, title: null, step: null, status, model: null, startedAt: null, costUsd: 0, estUsd: 0, trackerUrl: null, prUrl: null, summary: null, heldReason: null, heldAt: null, failReason: null, prState: null, finishedAt: null, queuePos: null, epic: null,
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
    expect(home.active.map((c) => c.profile.name)).toEqual(["sad", "up"]);
    expect(home.inactive.map((c) => c.profile.name)).toEqual(["down", "ghost"]);
  });
});
