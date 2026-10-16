import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatsStrip } from "./StatsStrip";

describe("StatsStrip", () => {
  it("renders its frame and the 7/14/30 range control before data arrives (fetch runs in an effect)", () => {
    const html = renderToStaticMarkup(createElement(StatsStrip, { profile: "dev", feed: [] }));
    expect(html).toContain("data-stats");
    expect(html).toContain("History");
    for (const r of ["7d", "14d", "30d"]) expect(html).toContain(r);
    expect(html).toContain('aria-checked="true"'); // one range selected
    expect(html).toContain('data-bars="finished"');
    expect(html).toContain('data-bars="cost"');
  });
});
