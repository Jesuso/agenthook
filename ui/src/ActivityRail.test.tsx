import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityRail, ActivityLine } from "./ActivityRail";
import type { FeedEntry } from "./feed";

function entry(ref: string, event: Record<string, any> = {}, profile = "agenthook"): FeedEntry {
  return { type: "event", profile, event: { ref, ts: "2026-10-08T00:05:00.000Z", ...event } };
}

describe("ActivityRail", () => {
  it("shows the live-only empty state when the feed is empty", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityRail, { feed: [], displayIdFor: () => null, open: true, onToggle: () => {}, onOpen: () => {}, variant: "rail" }),
    );
    expect(html).toContain("No activity since this page opened");
  });

  it("renders grouped entries with a minute header when open", () => {
    const feed = [entry("1", { event: "run_start", step: "code" })];
    const html = renderToStaticMarkup(
      createElement(ActivityRail, { feed, displayIdFor: () => null, open: true, onToggle: () => {}, onOpen: () => {}, variant: "rail" }),
    );
    expect(html).toContain("started code");
    expect(html).toContain("data-activity-line");
  });

  it("hides the body and shows only the header + toggle when collapsed", () => {
    const feed = [entry("1", { event: "run_start", step: "code" })];
    const html = renderToStaticMarkup(
      createElement(ActivityRail, { feed, displayIdFor: () => null, open: false, onToggle: () => {}, onOpen: () => {}, variant: "rail" }),
    );
    expect(html).not.toContain("started code");
    expect(html).toContain("data-activity-toggle");
  });

  it("marks a profile-level line (empty ref) as not clickable", () => {
    const el = ActivityLine({ entry: entry("", { event: "restarting" }), displayId: null, onOpen: () => {} });
    expect(el.type).toBe("div");
  });

  it("renders a ticket line as a button that calls onOpen with {profile, ref} on click", () => {
    const onOpen = vi.fn();
    const el = ActivityLine({ entry: entry("42", { event: "run_start", step: "code" }, "agenthook"), displayId: null, onOpen });
    expect(el.type).toBe("button");
    el.props.onClick();
    expect(onOpen).toHaveBeenCalledWith({ profile: "agenthook", ref: "42" });
  });
});
