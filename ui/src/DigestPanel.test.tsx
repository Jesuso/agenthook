import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DigestPanel } from "./DigestPanel";

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
});
