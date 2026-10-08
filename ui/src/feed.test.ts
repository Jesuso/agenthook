import { describe, it, expect } from "vitest";
import { appendFeed, formatEventDetail, FEED_MAX } from "./feed";
import type { FeedEntry } from "./feed";

function entry(ref: string): FeedEntry {
  return { type: "event", profile: "a", event: { ref, ts: ref } };
}

describe("appendFeed", () => {
  it("prepends newest first", () => {
    const feed = appendFeed([entry("1")], entry("2"));
    expect(feed.map((e) => e.event.ref)).toEqual(["2", "1"]);
  });

  it("caps at FEED_MAX", () => {
    const full = Array.from({ length: FEED_MAX }, (_, i) => entry(String(i)));
    const feed = appendFeed(full, entry("new"));
    expect(feed.length).toBe(FEED_MAX);
    expect(feed[0].event.ref).toBe("new");
  });

  it("does not mutate the input array", () => {
    const base = [entry("1")];
    const copy = [...base];
    appendFeed(base, entry("2"));
    expect(base).toEqual(copy);
  });
});

describe("formatEventDetail", () => {
  it("includes only present fields", () => {
    expect(formatEventDetail({ outcome: "advance" })).toBe("outcome=advance");
    expect(formatEventDetail({ reason: "blocked" })).toBe("reason=blocked");
    expect(formatEventDetail({ costUsd: 0.5 })).toBe("cost=$0.50");
    expect(formatEventDetail({})).toBe("");
  });

  it("joins multiple fields", () => {
    expect(formatEventDetail({ outcome: "fail", reason: "x", costUsd: 1 })).toBe("outcome=fail reason=x cost=$1.00");
  });
});
