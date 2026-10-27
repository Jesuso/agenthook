import { describe, it, expect } from "vitest";
import { epicChangedRefetches, epicsError, epicsUrl, etaLabel, fetchEpic, fetchEpics, groupTickets, perDayLabel, progressOf, safeUrl, splitCompleted, stageSegments } from "./epics";
import { epicStats, epicTicket } from "./epicsFixtures";

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("epicChangedRefetches", () => {
  const ev = { event: "epic_changed", ref: "12", step: "" };
  it("the profile's Epics list refetches on any epic_changed", () => {
    expect(epicChangedRefetches({ kind: "profile", profile: "dev", view: "epics" }, "dev", ev)).toBe(true);
    expect(epicChangedRefetches({ kind: "profile", profile: "dev", view: "epics" }, "dev", { ...ev, ref: "99" })).toBe(true);
  });
  it("one epic's page refetches only for that epic", () => {
    expect(epicChangedRefetches({ kind: "profile", profile: "dev", view: "epics", epic: "12" }, "dev", ev)).toBe(true);
    expect(epicChangedRefetches({ kind: "profile", profile: "dev", view: "epics", epic: "7" }, "dev", ev)).toBe(false);
  });
  it("another profile, another view, Home, or another event → no refetch", () => {
    expect(epicChangedRefetches({ kind: "profile", profile: "other", view: "epics" }, "dev", ev)).toBe(false);
    expect(epicChangedRefetches({ kind: "profile", profile: "dev", view: "overview" }, "dev", ev)).toBe(false);
    expect(epicChangedRefetches({ kind: "home" }, "dev", ev)).toBe(false);
    expect(epicChangedRefetches({ kind: "profile", profile: "dev", view: "epics" }, "dev", { ...ev, event: "run_end" })).toBe(false);
  });
});

describe("epicsUrl", () => {
  it("list and detail URLs with profile + the browser tz (as /api/stats)", () => {
    expect(epicsUrl("my app", null, 300)).toBe("/api/epics?profile=my%20app&tz=300");
    expect(epicsUrl("dev", "12/3", -120)).toBe("/api/epics/12%2F3?profile=dev&tz=-120");
    expect(epicsUrl("dev")).toBe(`/api/epics?profile=dev&tz=${new Date().getTimezoneOffset()}`);
  });
});

describe("fetchEpics / fetchEpic", () => {
  it("resolves the body on 200", async () => {
    const body = { at: "t", live: true, supported: true, epics: [] };
    expect(await fetchEpics("dev", reply(200, body))).toEqual({ kind: "ok", body });
    let url = "";
    const spy = (async (u: string) => ((url = u), new Response(JSON.stringify({ at: "t", live: true, supported: true, epic: null }), { status: 200 }))) as unknown as typeof fetch;
    expect((await fetchEpic("dev", "E1", spy)).kind).toBe("ok");
    expect(url).toMatch(/^\/api\/epics\/E1\?profile=dev&tz=/);
  });

  it("maps 404/502/503/504 and a network error to an inline message", async () => {
    expect(await fetchEpic("dev", "x", reply(404, null))).toMatchObject({ kind: "error", status: 404, message: "No such epic on this profile." });
    expect(await fetchEpics("dev", reply(404, null))).toMatchObject({ status: 404, message: "Unknown profile." });
    expect(await fetchEpics("dev", reply(502, { error: "no epic 9" }))).toMatchObject({ status: 502, message: "The receiver couldn't read the tracker: no epic 9." });
    expect(await fetchEpics("dev", reply(503, { error: "receiver not running" }))).toMatchObject({ status: 503, message: "The receiver isn't running." });
    expect(await fetchEpics("dev", reply(504, { error: "receiver timed out" }))).toMatchObject({ status: 504, message: "The tracker read timed out — try Refresh." });
    const down = (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await fetchEpics("dev", down)).toEqual({ kind: "error", status: 0, error: null, message: "Dashboard unreachable." });
    expect(epicsError(500, null, false)).toBe("Couldn't load epics (status 500).");
  });
});

describe("epic numbers", () => {
  const e = epicStats({ ref: "E", byStage: { done: 3, running: 1, needsYou: 1, backlog: 5 } });

  it("N/M counts the done bucket over every ticket", () => {
    expect(progressOf(e)).toEqual({ done: 3, total: 10 });
  });

  it("stage segments: non-empty buckets in bar order, as % of total; none for an empty epic", () => {
    expect(stageSegments(e).map((s) => [s.bucket, s.pct])).toEqual([["done", 30], ["running", 10], ["needsYou", 10], ["backlog", 50]]);
    expect(stageSegments(epicStats({ ref: "Z" }))).toEqual([]);
  });

  it("completed epics go last, order kept", () => {
    const list = [epicStats({ ref: "a", completed: true }), epicStats({ ref: "b" }), epicStats({ ref: "c" })];
    const { open, completed } = splitCompleted(list);
    expect(open.map((x) => x.ref)).toEqual(["b", "c"]);
    expect(completed.map((x) => x.ref)).toEqual(["a"]);
  });

  it("ready-to-close open epics sort first, server order kept otherwise", () => {
    const list = [epicStats({ ref: "a" }), epicStats({ ref: "b", readyToClose: true }), epicStats({ ref: "c" }), epicStats({ ref: "d", completed: true })];
    const { open, completed } = splitCompleted(list);
    expect(open.map((x) => x.ref)).toEqual(["b", "a", "c"]);
    expect(completed.map((x) => x.ref)).toEqual(["d"]);
  });

  it("labels ETA, per-day and keeps only http(s) URLs", () => {
    expect(etaLabel(null)).toBeNull();
    expect(etaLabel({ days: 4, date: "2026-10-20" })).toBe("~4 d · Oct 20");
    expect(perDayLabel(null)).toBe("—");
    expect(perDayLabel(0.4285)).toBe("0.4/day");
    expect(perDayLabel(12.6)).toBe("13/day");
    expect(perDayLabel(0.4285, "es")).toBe("0.4/día");
    expect(etaLabel({ days: 4, date: "2026-10-20" }, "es")).toMatch(/^~4 d · 20 oct/);
    expect(safeUrl("https://x.y/1")).toBe("https://x.y/1");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("")).toBeNull();
  });

  it("groups tickets by bucket, server order kept", () => {
    const g = groupTickets([epicTicket("1", "running"), epicTicket("2", "needsYou"), epicTicket("3", "running"), epicTicket("4", "untracked")]);
    expect(g.running.map((t) => t.ref)).toEqual(["1", "3"]);
    expect(g.needsYou.map((t) => t.ref)).toEqual(["2"]);
    expect(g.untracked.map((t) => t.ref)).toEqual(["4"]);
    expect(g.backlog).toEqual([]);
  });
});
