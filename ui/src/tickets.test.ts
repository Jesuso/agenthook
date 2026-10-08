import { describe, it, expect } from "vitest";
import { sortTickets, filterTickets, isStale, prNumber, STATUS_ORDER } from "./tickets";
import type { TicketRow } from "./contract";

function ticket(overrides: Partial<TicketRow> & { profile: string; ref: string; status: TicketRow["status"] }): TicketRow {
  return {
    displayId: overrides.ref,
    title: null,
    step: null,
    model: null,
    startedAt: null,
    costUsd: 0,
    trackerUrl: null,
    prUrl: null,
    heldReason: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-10-08T12:00:00Z");

describe("isStale", () => {
  it("is never stale for running/queued/held/failed", () => {
    for (const status of ["running", "queued", "held", "failed"] as const) {
      expect(isStale(ticket({ profile: "a", ref: "1", status, startedAt: null }), NOW)).toBe(false);
    }
  });

  it("is stale for done/idle with null startedAt", () => {
    expect(isStale(ticket({ profile: "a", ref: "1", status: "done", startedAt: null }), NOW)).toBe(true);
    expect(isStale(ticket({ profile: "a", ref: "1", status: "idle", startedAt: null }), NOW)).toBe(true);
  });

  it("is stale for done/idle older than 24h, not stale just under", () => {
    const justOver = new Date(NOW - 24 * 60 * 60 * 1000 - 1000).toISOString();
    const justUnder = new Date(NOW - 23 * 60 * 60 * 1000).toISOString();
    expect(isStale(ticket({ profile: "a", ref: "1", status: "done", startedAt: justOver }), NOW)).toBe(true);
    expect(isStale(ticket({ profile: "a", ref: "1", status: "done", startedAt: justUnder }), NOW)).toBe(false);
  });

  it("treats an unparsable startedAt as stale", () => {
    expect(isStale(ticket({ profile: "a", ref: "1", status: "done", startedAt: "not-a-date" }), NOW)).toBe(true);
  });

  it("is never stale for interrupted/stalled", () => {
    for (const status of ["interrupted", "stalled"] as const) {
      expect(isStale(ticket({ profile: "a", ref: "1", status, startedAt: null }), NOW)).toBe(false);
    }
  });
});

describe("sortTickets", () => {
  it("orders by status rank", () => {
    const rows = [
      ticket({ profile: "a", ref: "1", status: "idle" }),
      ticket({ profile: "a", ref: "2", status: "running" }),
      ticket({ profile: "a", ref: "3", status: "failed" }),
      ticket({ profile: "a", ref: "4", status: "held" }),
      ticket({ profile: "a", ref: "5", status: "done" }),
      ticket({ profile: "a", ref: "6", status: "queued" }),
      ticket({ profile: "a", ref: "7", status: "interrupted" }),
      ticket({ profile: "a", ref: "8", status: "stalled" }),
    ];
    const sorted = sortTickets(rows).map((r) => r.status);
    expect(sorted).toEqual(STATUS_ORDER);
  });

  it("within a status, sorts startedAt descending with nulls last", () => {
    const rows = [
      ticket({ profile: "a", ref: "1", status: "done", startedAt: "2026-10-01T00:00:00Z" }),
      ticket({ profile: "a", ref: "2", status: "done", startedAt: null }),
      ticket({ profile: "a", ref: "3", status: "done", startedAt: "2026-10-05T00:00:00Z" }),
    ];
    expect(sortTickets(rows).map((r) => r.ref)).toEqual(["3", "1", "2"]);
  });

  it("falls back to profile then ref", () => {
    const rows = [
      ticket({ profile: "b", ref: "2", status: "idle" }),
      ticket({ profile: "a", ref: "2", status: "idle" }),
      ticket({ profile: "a", ref: "1", status: "idle" }),
    ];
    expect(sortTickets(rows).map((r) => `${r.profile}${r.ref}`)).toEqual(["a1", "a2", "b2"]);
  });

  it("does not mutate the input array", () => {
    const rows = [ticket({ profile: "a", ref: "2", status: "idle" }), ticket({ profile: "a", ref: "1", status: "running" })];
    const copy = [...rows];
    sortTickets(rows);
    expect(rows).toEqual(copy);
  });
});

describe("filterTickets", () => {
  const rows = [
    ticket({ profile: "a", ref: "1", status: "running" }),
    ticket({ profile: "a", ref: "2", status: "done", startedAt: null }),
    ticket({ profile: "b", ref: "3", status: "failed" }),
  ];

  it("filters by profile", () => {
    expect(filterTickets(rows, { profile: "a", status: null, showAll: true, now: NOW }).map((r) => r.ref)).toEqual(["1", "2"]);
  });

  it("filters by status", () => {
    expect(filterTickets(rows, { profile: null, status: "failed", showAll: true, now: NOW }).map((r) => r.ref)).toEqual(["3"]);
  });

  it("needs-you matches held + failed only", () => {
    const more = [...rows, ticket({ profile: "b", ref: "4", status: "held" }), ticket({ profile: "b", ref: "5", status: "queued" })];
    expect(filterTickets(more, { profile: null, status: "needs-you", showAll: false, now: NOW }).map((r) => r.ref)).toEqual(["3", "4"]);
    expect(filterTickets(more, { profile: "b", status: "needs-you", showAll: true, now: NOW }).map((r) => r.ref)).toEqual(["3", "4"]);
    expect(filterTickets(more, { profile: "a", status: "needs-you", showAll: true, now: NOW })).toEqual([]);
  });

  it("hides stale rows by default, shows them with showAll", () => {
    expect(filterTickets(rows, { profile: null, status: null, showAll: false, now: NOW }).map((r) => r.ref)).toEqual(["1", "3"]);
    expect(filterTickets(rows, { profile: null, status: null, showAll: true, now: NOW }).map((r) => r.ref)).toEqual(["1", "2", "3"]);
  });
});

describe("prNumber", () => {
  it("takes the number off a /pull/<n> URL", () => {
    expect(prNumber("https://github.com/Jesuso/agenthook/pull/230")).toBe("230");
    expect(prNumber("https://github.com/Jesuso/agenthook/pull/230/")).toBe("230");
  });
  it("null for no URL or a non-PR URL", () => {
    expect(prNumber(null)).toBeNull();
    expect(prNumber("")).toBeNull();
    expect(prNumber("https://github.com/Jesuso/agenthook/issues/230")).toBeNull();
    expect(prNumber("https://github.com/Jesuso/agenthook/pull/230/files")).toBeNull();
  });
});
