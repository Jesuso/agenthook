import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DigestPanel, digestStale } from "./DigestPanel";

const render = (up: boolean) => renderToStaticMarkup(createElement(DigestPanel, { profile: "dev", up, feed: [], now: 0 }));

describe("DigestPanel", () => {
  it("offers the on-demand button under its own heading", () => {
    const html = render(true);
    expect(html).toContain("data-digest");
    expect(html).toContain("Catch me up");
    expect(html).not.toContain('disabled=""');
  });
  it("says in words why there is no digest button while the receiver is down (it spawns the agent)", () => {
    const html = render(false);
    expect(html).toMatch(/data-digest-down[^>]*>Start the receiver to write a digest</);
    expect(html).not.toMatch(/<button[^>]*>(Write a digest|Refresh digest)/);
  });
  it("treats a digest older than a day as stale (collapsed by default)", () => {
    const at = Date.parse("2026-10-20T12:00:00Z");
    const d = { text: "x", generatedAt: new Date(at).toISOString() } as Parameters<typeof digestStale>[0];
    expect(digestStale(d, at + 23 * 3600e3)).toBe(false);
    expect(digestStale(d, at + 25 * 3600e3)).toBe(true);
    expect(digestStale(null, at)).toBe(false);
  });
});
