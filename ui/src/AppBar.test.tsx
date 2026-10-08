import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AppBar } from "./AppBar";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("AppBar", () => {
  it("shows the brand and the root package.json version", () => {
    const html = renderToStaticMarkup(createElement(AppBar, { connection: "connected" }));
    expect(html).toContain("agenthook");
    expect(html).toContain(`v${version}`);
  });

  it("marks only the active tab", () => {
    const html = renderToStaticMarkup(createElement(AppBar, { connection: "connected", tab: "config", onTab: () => {} }));
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*aria-current="page"[^>]*>config<\/button>/);
    expect(html).toContain(">dashboard</button>");
  });

  it("omits the tabs without onTab (loading / error screens)", () => {
    expect(renderToStaticMarkup(createElement(AppBar, { connection: "reconnecting" }))).not.toContain("<nav");
  });

  it("colours and labels the connection dot by state", () => {
    const cases = [
      ["connected", "bg-success", "Live"],
      ["reconnecting", "bg-status-held", "Reconnecting…"],
      ["closed", "bg-status-failed", "Disconnected — reload"],
    ] as const;
    for (const [state, cls, label] of cases) {
      const html = renderToStaticMarkup(createElement(AppBar, { connection: state }));
      expect(html).toContain(`data-connection="${state}"`);
      expect(html).toContain(cls);
      expect(html).toContain(`aria-label="${label}"`);
    }
  });
});
