import { describe, it, expect } from "vitest";
import { summarize, NEEDS_YOU } from "./summary";
import type { ProfileView, TicketRow } from "./contract";

function profile(overrides: Partial<ProfileView> & { name: string; up: boolean }): ProfileView {
  return {
    label: overrides.name,
    pid: null,
    port: null,
    tracker: null,
    ingress: null,
    fullAuto: null,
    maxConcurrent: null,
    startedAt: null,
    updatedAt: null,
    active: null,
    queued: null,
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

function ticket(ref: string, status: TicketRow["status"]): TicketRow {
  return { profile: "a", ref, displayId: ref, title: null, step: null, status, model: null, startedAt: null, costUsd: 0, trackerUrl: null, prUrl: null, heldReason: null };
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
    const statuses: TicketRow["status"][] = ["running", "queued", "held", "interrupted", "stalled", "failed", "done", "idle", "held"];
    const s = summarize({ profiles: [], tickets: statuses.map((st, i) => ticket(String(i), st)) }, NOW);
    expect(s.needsYou).toBe(3);
  });

  it("costToday sums every profile's costs since local midnight, down profiles included", () => {
    const s = summarize(
      {
        profiles: [
          profile({
            name: "a",
            up: true,
            recentCosts: [
              { at: local(23, 59, 7), costUsd: 100 }, // yesterday
              { at: local(0, 0), costUsd: 0.5 },
              { at: local(11, 30), costUsd: 1.25 },
            ],
          }),
          profile({ name: "b", up: false, recentCosts: [{ at: local(9), costUsd: 2 }, { at: "garbage", costUsd: 7 }] }),
        ],
        tickets: [],
      },
      NOW,
    );
    expect(s.costToday).toBeCloseTo(3.75);
  });

  it("is all zeros for an empty snapshot", () => {
    expect(summarize({ profiles: [], tickets: [] }, NOW)).toEqual({ active: 0, capacity: 0, needsYou: 0, queued: 0, costToday: 0, up: 0, down: 0 });
  });
});
