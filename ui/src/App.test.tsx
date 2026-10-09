import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProfileView } from "./contract";
import { ProfileNameCell } from "./App";

const base: ProfileView = {
  name: "k",
  label: "K",
  up: true,
  pid: 1,
  port: 4180,
  tracker: "asana",
  ingress: "ngrok",
  fullAuto: false,
  maxConcurrent: 2,
  startedAt: null,
  updatedAt: null,
  active: 0,
  queued: 0,
  lastEvent: null,
  configPath: "~/p/agenthook.config.json",
  createdAt: "2026-04-05T12:00:00.000Z",
  lastSeenAt: null,
  ghost: false,
  configMissing: false,
  recentCosts: [],
};

describe("ProfileNameCell", () => {
  it("shows the config path visibly, not just in a tooltip", () => {
    const html = renderToStaticMarkup(createElement(ProfileNameCell, { p: base }));
    expect(html).toContain("~/p/agenthook.config.json");
    // visible text, not only the name's title attribute
    expect(html).toContain(
      '<div class="block max-w-[40ch] truncate font-mono text-label text-muted max-lg:max-w-[24ch]" title="~/p/agenthook.config.json">~/p/agenthook.config.json</div>',
    );
  });

  it("shows the never-ran badge with its created date for a ghost profile", () => {
    const html = renderToStaticMarkup(createElement(ProfileNameCell, { p: { ...base, ghost: true, configPath: null } }));
    expect(html).toContain("never ran");
    expect(html).toContain("created 2026-04-05");
  });

  it("shows the config-missing badge for a profile whose config file is gone", () => {
    const html = renderToStaticMarkup(createElement(ProfileNameCell, { p: { ...base, configMissing: true } }));
    expect(html).toContain("config missing");
  });
});
