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
  it("disables the button while the receiver is down (the agent is spawned by the receiver)", () => {
    expect(render(false)).toContain('disabled=""');
  });
  it("treats a digest older than a day as stale (collapsed by default)", () => {
    const at = Date.parse("2026-10-20T12:00:00Z");
    const d = { text: "x", generatedAt: new Date(at).toISOString() } as Parameters<typeof digestStale>[0];
    expect(digestStale(d, at + 23 * 3600e3)).toBe(false);
    expect(digestStale(d, at + 25 * 3600e3)).toBe(true);
    expect(digestStale(null, at)).toBe(false);
  });
});
