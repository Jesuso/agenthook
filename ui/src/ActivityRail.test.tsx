// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityRail, ActivityLine } from "./ActivityRail";
import type { FeedEntry } from "./feed";
import { I18nProvider } from "./i18n/react";
import { setLangSetting } from "./i18n";
import { mount } from "./domHarness";

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

describe("ActivityRail in Spanish", () => {
  afterEach(() => setLangSetting("en", []));

  it("renders its heading, badge, toggle and lines in Spanish", async () => {
    setLangSetting("es", []);
    const feed = [entry("1", { event: "run_start", step: "code" }), entry("2", { event: "enqueued", step: "review" })];
    const props = { feed, displayIdFor: () => null, open: true, onToggle: () => {}, onOpen: () => {}, variant: "rail" as const, unread: 2 };
    const m = await mount(createElement(I18nProvider, null, createElement(ActivityRail, props)));
    const html = m.root.innerHTML;
    const empty = await mount(createElement(I18nProvider, null, createElement(ActivityRail, { ...props, feed: [], unread: 0 })));
    const emptyText = empty.root.textContent;
    await m.unmount();
    await empty.unmount();
    expect(html).toContain("Actividad");
    expect(html).toContain("2 nuevos");
    expect(html).toContain('aria-label="Ocultar actividad"');
    expect(html).toContain("inició code");
    expect(html).toContain("en cola para review");
    expect(emptyText).toContain("No hay actividad desde que se abrió esta página");
  });
});
