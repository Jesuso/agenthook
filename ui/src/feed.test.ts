import { describe, it, expect } from "vitest";
import { appendFeed, formatFeedEvent, ticketLabel, groupByMinute, readRailOpen, writeRailOpen, FEED_MAX } from "./feed";
import type { FeedEntry } from "./feed";

function entry(ref: string, event: Record<string, any> = {}): FeedEntry {
  return { type: "event", profile: "a", event: { ref, ts: `2026-10-08T00:0${ref}:00.000Z`, ...event } };
}

describe("appendFeed", () => {
  it("prepends newest first", () => {
    const feed = appendFeed([entry("1")], entry("2"));
    expect(feed.map((e) => e.event.ref)).toEqual(["2", "1"]);
  });

  it("caps at FEED_MAX", () => {
    const full = Array.from({ length: FEED_MAX }, (_, i) => entry(String(i % 9)));
    const feed = appendFeed(full, entry("5"));
    expect(feed.length).toBe(FEED_MAX);
    expect(feed[0].event.ref).toBe("5");
  });

  it("does not mutate the input array", () => {
    const base = [entry("1")];
    const copy = [...base];
    appendFeed(base, entry("2"));
    expect(base).toEqual(copy);
  });
});

describe("formatFeedEvent", () => {
  it("maps run_start", () => {
    const r = formatFeedEvent({ event: "run_start", ref: "1", step: "code" }, null);
    expect(r).toMatchObject({ text: "started code", tone: "running", ticket: true });
  });

  it("maps run_end by outcome, with cost suffix", () => {
    expect(formatFeedEvent({ event: "run_end", ref: "1", step: "code", outcome: "advance", costUsd: 0.5 }, null).text).toBe("code passed · $0.50");
    expect(formatFeedEvent({ event: "run_end", ref: "1", step: "code", outcome: "hold" }, null)).toMatchObject({ text: "code held", tone: "held" });
    expect(formatFeedEvent({ event: "run_end", ref: "1", step: "code", outcome: "changes" }, null)).toMatchObject({ text: "code → changes", tone: "queued" });
    expect(formatFeedEvent({ event: "run_end", ref: "1", step: "code", outcome: "fail" }, null)).toMatchObject({ text: "code failed", tone: "failed" });
  });

  it("maps enqueued / failed / blocked / merged / pipeline_done / ci_red / overlap events", () => {
    expect(formatFeedEvent({ event: "enqueued", ref: "1", step: "code" }, null)).toMatchObject({ text: "queued for code", tone: "queued" });
    expect(formatFeedEvent({ event: "failed", ref: "1", reason: "oops" }, null)).toMatchObject({ text: "failed: oops", tone: "failed" });
    expect(formatFeedEvent({ event: "blocked", ref: "1", reason: "wait" }, null)).toMatchObject({ text: "held: wait", tone: "held" });
    expect(formatFeedEvent({ event: "merged", ref: "1" }, null)).toMatchObject({ text: "merged", tone: "done" });
    expect(formatFeedEvent({ event: "pipeline_done", ref: "1" }, null)).toMatchObject({ text: "done", tone: "done" });
    expect(formatFeedEvent({ event: "ci_red", ref: "1", action: "rerun" }, null)).toMatchObject({ text: "CI red (rerun)", tone: "failed" });
    expect(formatFeedEvent({ event: "overlap_held", ref: "1" }, null)).toMatchObject({ text: "waiting on overlap", tone: "held" });
    expect(formatFeedEvent({ event: "overlap_released", ref: "1" }, null)).toMatchObject({ tone: "queued" });
    expect(formatFeedEvent({ event: "pulled", ref: "1" }, null)).toMatchObject({ text: "pulled", tone: "queued" });
  });

  it("maps profile-level restart/decommission events as non-ticket, plain words", () => {
    const r = formatFeedEvent({ event: "restarting", ref: "" }, null);
    expect(r).toEqual({ text: "restarting", tone: "idle", ticket: false });
    expect(formatFeedEvent({ event: "decommission_requested", ref: "" }, null).text).toBe("decommission requested");
  });

  it("falls back to the raw event name for unknown events", () => {
    expect(formatFeedEvent({ event: "something_new", ref: "1" }, null)).toMatchObject({ text: "something_new", tone: "idle" });
  });

  it("sets ticket:false for events with no ref", () => {
    expect(formatFeedEvent({ event: "run_start", ref: "", step: "code" }, null).ticket).toBe(false);
  });
});

describe("ticketLabel", () => {
  it("prefers displayId over ref when distinct", () => {
    expect(ticketLabel("1234567890123456", "ABC-1")).toEqual({ text: "ABC-1" });
  });

  it("falls back to shortRef when displayId matches ref or is absent", () => {
    expect(ticketLabel("short", null)).toEqual({ text: "short" });
    expect(ticketLabel("1234567890123456", "1234567890123456")).toEqual({ text: "…123456", title: "1234567890123456" });
  });
});

describe("groupByMinute", () => {
  it("preserves newest-first order and groups consecutive same-minute entries", () => {
    const a = entry("a", { ts: "2026-10-08T00:05:10.000Z" });
    const b = entry("b", { ts: "2026-10-08T00:05:40.000Z" });
    const c = entry("c", { ts: "2026-10-08T00:06:00.000Z" });
    const groups = groupByMinute([c, b, a]);
    expect(groups.length).toBe(2);
    expect(groups[0].entries.map((e) => e.event.ref)).toEqual(["c"]);
    expect(groups[1].entries.map((e) => e.event.ref)).toEqual(["b", "a"]);
  });

  it("puts missing/invalid ts in a '—' group without crashing", () => {
    const bad1 = entry("x", { ts: undefined });
    const bad2 = entry("y", { ts: "not-a-date" });
    const groups = groupByMinute([bad1, bad2]);
    expect(groups.length).toBe(1);
    expect(groups[0].key).toBe("—");
    expect(groups[0].minute).toBe("—");
  });
});

describe("readRailOpen / writeRailOpen", () => {
  it("defaults open and round-trips through storage", () => {
    const data: Record<string, string> = {};
    const store = {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
    expect(readRailOpen(store)).toBe(true);
    writeRailOpen(false, store);
    expect(readRailOpen(store)).toBe(false);
    writeRailOpen(true, store);
    expect(readRailOpen(store)).toBe(true);
  });

  it("defaults open and no-ops when storage throws", () => {
    const store = {
      getItem: () => {
        throw new Error("disabled");
      },
      setItem: () => {
        throw new Error("disabled");
      },
    };
    expect(readRailOpen(store)).toBe(true);
    expect(() => writeRailOpen(false, store)).not.toThrow();
  });
});
