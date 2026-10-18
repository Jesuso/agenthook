import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AppBar } from "./AppBar";
import type { ProfileNav } from "./AppBar";
import type { ProfileView } from "./contract";

const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("AppBar", () => {
  it("shows the brand and the root package.json version", () => {
    const html = renderToStaticMarkup(createElement(AppBar, { connection: "connected" }));
    expect(html).toContain("agenthook");
    expect(html).toContain(`v${version}`);
  });

  const profiles = [
    { name: "dev", label: "dev", color: "teal", emoji: "🚀" },
    { name: "ops", label: "Ops", color: "pink", emoji: "🦊" },
  ] as ProfileView[];
  const nav = (view: "overview" | "instructions" | "config"): ProfileNav => ({
    profile: "dev",
    profiles,
    view,
    onView: () => {},
    onProfile: () => {},
    onHome: () => {},
  });

  it("marks only the active view tab", () => {
    const html = renderToStaticMarkup(createElement(AppBar, { connection: "connected", nav: nav("config") }));
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*aria-current="page"[^>]*>config<\/button>/);
    expect(html).toContain(">overview</button>");
    expect(html).toContain(">instructions</button>");
  });

  it("shows Home, the switcher and the tabs only inside a profile", () => {
    const home = renderToStaticMarkup(createElement(AppBar, { connection: "connected" }));
    expect(home).not.toContain("<nav");
    expect(home).not.toContain("data-profile-switcher");
    const inside = renderToStaticMarkup(createElement(AppBar, { connection: "connected", nav: nav("overview") }));
    expect(inside).toContain("data-home");
    expect(inside).toContain("data-profile-switcher");
    expect(inside).toMatch(/<option value="dev" selected="">🚀 dev<\/option>/);
  });

  it("shows the current profile's emoji mark and prefixes switcher options with theirs", () => {
    const html = renderToStaticMarkup(createElement(AppBar, { connection: "connected", nav: nav("overview") }));
    expect(html).toContain("--profile-accent:var(--color-profile-teal)");
    expect(html).toMatch(/<option value="ops">🦊 Ops \(ops\)<\/option>/);
  });

  it("keeps a switcher entry for a profile that is not in the list (removed / loading)", () => {
    const html = renderToStaticMarkup(createElement(AppBar, { connection: "connected", nav: { ...nav("overview"), profile: "gone" } }));
    expect(html).toContain('<option value="gone"');
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

  it("keeps DOM reading order brand → profile → tabs → quota → connection at every width", () => {
    const quota = { sevenDay: { utilization: 0.66, resetsAt: "2026-10-18T21:00:00.000Z" }, asOf: "2026-10-16T16:42:00.000Z" };
    const withQuota = [{ ...profiles[0], quota }, profiles[1]] as ProfileView[];
    const html = renderToStaticMarkup(createElement(AppBar, { connection: "connected", nav: { ...nav("overview"), profiles: withQuota } }));
    expect(html).not.toMatch(/\border-\d/); // no order-* utility reorders anything
    const brand = html.indexOf("agenthook");
    const home = html.indexOf("data-home");
    const breakSpacer = html.indexOf("basis-full");
    const tabs = html.indexOf("<nav");
    const quotaIdx = html.indexOf("data-appbar-quota");
    const connection = html.indexOf("data-connection");
    expect(brand).toBeLessThan(home);
    expect(home).toBeLessThan(breakSpacer);
    expect(breakSpacer).toBeLessThan(tabs); // the below-lg break comes before the tabs
    expect(tabs).toBeLessThan(quotaIdx);
    expect(quotaIdx).toBeLessThan(connection);
  });

  it("shows the current profile's Claude quota inside a profile, nothing without one", () => {
    const now = Date.parse("2026-10-16T16:45:00.000Z");
    const quota = { sevenDay: { utilization: 0.66, resetsAt: "2026-10-18T21:00:00.000Z" }, asOf: "2026-10-16T16:42:00.000Z" };
    const withQuota = [{ ...profiles[0], quota }, profiles[1]] as ProfileView[];
    const html = renderToStaticMarkup(createElement(AppBar, { connection: "connected", nav: { ...nav("overview"), profiles: withQuota, now } }));
    expect(html).toContain("weekly 66% · resets in 2d 4h (as of 3m ago)");
    expect(renderToStaticMarkup(createElement(AppBar, { connection: "connected", nav: nav("overview") }))).not.toContain("data-appbar-quota");
  });
});
