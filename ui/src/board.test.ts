import { describe, expect, it } from "vitest";
import { boardSections, localMidnight, readBoardTab, writeBoardTab } from "./board";
import type { TicketRow } from "./contract";

const base: TicketRow = {
  profile: "p",
  ref: "r1",
  displayId: "T-1",
  title: "a",
  summary: null,
  plain: null,
  options: null,
  step: "code",
  status: "running",
  model: null,
  startedAt: null,
  costUsd: 0,
  estUsd: 0,
  trackerUrl: null,
  prUrl: null,
  heldReason: null,
  heldAt: null,
  failReason: null,
  prState: null,
  prNeeds: null,
  finishedAt: null,
  queuePos: null,
  queuedAt: null,
  epic: null,
};

const row = (over: Partial<TicketRow>): TicketRow => ({ ...base, ...over });

describe("boardSections", () => {
  it("one section per pipeline step, in order", () => {
    const { steps } = boardSections([], ["triage", "code", "review"], Date.now());
    expect(steps.map((s) => s.id)).toEqual(["triage", "code", "review"]);
  });

  it("buckets a running ticket into its step's section, longest-running first", () => {
    const now = Date.now();
    const older = row({ ref: "a", status: "running", startedAt: new Date(now - 60_000).toISOString() });
    const newer = row({ ref: "b", status: "running", startedAt: new Date(now - 1_000).toISOString() });
    const { steps } = boardSections([newer, older], ["code"], now);
    expect(steps[0].entries.map((e) => e.ticket.ref)).toEqual(["a", "b"]);
    expect(steps[0].entries.every((e) => e.clock === "running")).toBe(true);
  });

  it("queued tickets follow running ones, in queue order, with a muted clock", () => {
    const running = row({ ref: "r", status: "running" });
    const q1 = row({ ref: "q1", status: "queued", queuePos: 1 });
    const q0 = row({ ref: "q0", status: "queued", queuePos: 0 });
    const { steps } = boardSections([q1, running, q0], ["code"], Date.now());
    expect(steps[0].entries.map((e) => e.ticket.ref)).toEqual(["r", "q0", "q1"]);
    expect(steps[0].entries.map((e) => e.clock)).toEqual(["running", "queued", "queued"]);
  });

  it("held and failed tickets never appear in a step section", () => {
    const held = row({ ref: "h", status: "held" });
    const failed = row({ ref: "f", status: "failed" });
    const { steps, other } = boardSections([held, failed], ["code"], Date.now());
    expect(steps[0].entries).toEqual([]);
    expect(other).toBeNull();
  });

  it("caps at 6 entries with the remainder in moreCount", () => {
    const rows = Array.from({ length: 8 }, (_, i) => row({ ref: `r${i}`, status: "running", startedAt: new Date(Date.now() - i * 1000).toISOString() }));
    const { steps } = boardSections(rows, ["code"], Date.now());
    expect(steps[0].entries).toHaveLength(6);
    expect(steps[0].moreCount).toBe(2);
  });

  it("buckets a row whose step matches no pipeline step into Other, only when non-empty", () => {
    const stray = row({ ref: "s", status: "running", step: "ghost-step" });
    const { other } = boardSections([stray], ["code"], Date.now());
    expect(other?.entries.map((e) => e.ticket.ref)).toEqual(["s"]);

    const { other: empty } = boardSections([], ["code"], Date.now());
    expect(empty).toBeNull();
  });

  it("done today: only rows finished since local midnight, newest first, with a total count", () => {
    const now = Date.now();
    const midnight = localMidnight(now);
    const today = row({ ref: "today", status: "done", finishedAt: new Date(midnight + 1000).toISOString() });
    const todayLater = row({ ref: "today2", status: "done", finishedAt: new Date(midnight + 5000).toISOString() });
    const yesterday = row({ ref: "yesterday", status: "done", finishedAt: new Date(midnight - 1000).toISOString() });
    const { doneToday } = boardSections([today, todayLater, yesterday], ["code"], now);
    expect(doneToday.section.entries.map((e) => e.ticket.ref)).toEqual(["today2", "today"]);
    expect(doneToday.total).toBe(2);
    expect(doneToday.section.entries.every((e) => e.clock === "done")).toBe(true);
  });
});

describe("board tab preference", () => {
  it("defaults to table and persists board", () => {
    const store = new Map<string, string>();
    const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
    expect(readBoardTab(fake)).toBe("table");
    writeBoardTab("board", fake);
    expect(readBoardTab(fake)).toBe("board");
  });
});
