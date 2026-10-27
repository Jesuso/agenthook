import { describe, it, expect } from "vitest";
import { summarize, scopeToProfile, NEEDS_YOU, isNeedsYou } from "./summary";
import { isNeedsYou as serverIsNeedsYou } from "../../src/epics.js";
import type { ProfileView, TicketRow } from "./contract";

function profile(overrides: Partial<ProfileView> & { name: string; up: boolean }): ProfileView {
  return {
    label: overrides.name,
    pid: null,
    port: null,
    tracker: null,
    ingress: null,
    fullAuto: null,
    color: "sky",
    emoji: "💻",
    maxConcurrent: null,
    startedAt: null,
    updatedAt: null,
    active: null,
    queued: null,
    paused: null,
    restartPending: null,
    lastEvent: null,
    configPath: null,
    createdAt: null,
    lastSeenAt: null,
    ghost: false,
    configMissing: false,
    recentCosts: [],
    forge: null,
    recentRuns: [], quotaPaused: null, quota: null,
    ...overrides,
  };
}

function ticket(ref: string, status: TicketRow["status"]): TicketRow {
  return { profile: "a", ref, displayId: ref, title: null, step: null, status, model: null, startedAt: null, costUsd: 0, estUsd: 0, trackerUrl: null, prUrl: null, summary: null, plain: null, options: null, heldReason: null, heldAt: null, failReason: null, prState: null, prNeeds: null, finishedAt: null, queuePos: null, epic: null };
}

// Local time on purpose: "today" is the browser's local day.
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();
const local = (h: number, m = 0, day = 8) => new Date(2026, 9, day, h, m).toISOString();

describe("summarize", () => {
  it("counts capacity / active / queued only from up profiles, nulls as 0", () => {
    const s = summarize(
      {
        profiles: [
          profile({ name: "a", up: true, active: 2, maxConcurrent: 3, queued: 4 }),
          profile({ name: "b", up: true, active: null, maxConcurrent: 2, queued: null }),
          profile({ name: "c", up: true }),
          profile({ name: "d", up: false, active: 5, maxConcurrent: 5, queued: 5 }),
        ],
        tickets: [],
      },
      NOW,
    );
    expect(s).toMatchObject({ active: 2, capacity: 5, queued: 4, up: 3, down: 1 });
  });

  it("needsYou = held + failed tickets", () => {
    expect(NEEDS_YOU).toEqual(["held", "failed"]);
    const statuses: TicketRow["status"][] = ["running", "queued", "held", "interrupted", "stalled", "failed", "cancelled", "done", "idle", "held"];
    const s = summarize({ profiles: [], tickets: statuses.map((st, i) => ticket(String(i), st)) }, NOW);
    expect(s.needsYou).toBe(3);
  });

  it("needsYou counts a PR reason (prNeeds) only on a forge profile", () => {
    const pr = (ref: string, status: TicketRow["status"], over: Partial<TicketRow>): TicketRow => ({ ...ticket(ref, status), prUrl: "https://github.com/o/r/pull/1", prState: "ready", ...over });
    const tickets = [
      pr("a", "done", { prNeeds: "openOnDone" }),
      pr("b", "idle", { prNeeds: "awaitingMerge" }),
      pr("c", "idle", { prState: "merged", prNeeds: "mergedOpen" }),
      pr("d", "idle", { prState: "closed", prNeeds: "closedUnmerged" }),
      pr("e", "done", { prState: "merged", prNeeds: null }),
      pr("f", "idle", { prNeeds: null }), // the board is unknown: no reason
    ];
    expect(summarize({ profiles: [profile({ name: "a", up: true, forge: "github" })], tickets }, NOW).needsYou).toBe(4);
    expect(summarize({ profiles: [profile({ name: "a", up: true, forge: null })], tickets }, NOW).needsYou).toBe(0);
  });

  it("isNeedsYou agrees with the server's (src/epics.js) on every status × prNeeds × forge", () => {
    const statuses: TicketRow["status"][] = ["running", "queued", "held", "failed", "cancelled", "done", "idle", "interrupted", "stalled"];
    const reasons: TicketRow["prNeeds"][] = [null, "awaitingMerge", "mergedOpen", "closedUnmerged", "openOnDone"];
    for (const status of statuses)
      for (const prNeeds of reasons)
        for (const forge of [true, false]) {
          const t = { ...ticket("x", status), prNeeds };
          expect(isNeedsYou(t, forge), `${status} ${prNeeds} ${forge}`).toBe(serverIsNeedsYou(t, forge));
        }
  });

  it("costToday sums every profile's costs since local midnight, down profiles included", () => {
    const s = summarize(
      {
        profiles: [
          profile({
            name: "a",
            up: true,
            recentCosts: [
              { at: local(23, 59, 7), costUsd: 100, estUsd: 0 }, // yesterday
              { at: local(0, 0), costUsd: 0.5, estUsd: 0 },
              { at: local(11, 30), costUsd: 1.25, estUsd: 0 },
              { at: local(11, 40), costUsd: 0, estUsd: 0.4 }, // an estimate: beside costToday, never in it
            ],
          }),
          profile({ name: "b", up: false, recentCosts: [{ at: local(9), costUsd: 2, estUsd: 0 }, { at: "garbage", costUsd: 7, estUsd: 0 }] }),
        ],
        tickets: [],
      },
      NOW,
    );
    expect(s.costToday).toBeCloseTo(3.75);
    expect(s.estToday).toBeCloseTo(0.4);
  });

  it("is all zeros for an empty snapshot", () => {
    expect(summarize({ profiles: [], tickets: [] }, NOW)).toEqual({ active: 0, capacity: 0, needsYou: 0, queued: 0, costToday: 0, estToday: 0, up: 0, down: 0 });
  });
});

describe("scopeToProfile", () => {
  it("keeps only one profile's row and tickets, so summarize reads that profile alone", () => {
    const snap = {
      profiles: [profile({ name: "a", up: true, active: 1, maxConcurrent: 2 }), profile({ name: "b", up: true, active: 3, maxConcurrent: 4 })],
      tickets: [ticket("1", "held"), { ...ticket("2", "failed"), profile: "b" }],
    };
    const s = summarize(scopeToProfile(snap, "a"), NOW);
    expect(s).toMatchObject({ active: 1, capacity: 2, needsYou: 1, up: 1, down: 0 });
  });
});
