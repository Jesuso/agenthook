import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HomePage } from "./HomePage";
import type { ProfileView, Snapshot, TicketRow } from "./contract";

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();

const profile = (name: string, over: Partial<ProfileView> = {}): ProfileView => ({
  name, label: name, up: true, pid: 1, port: null, tracker: "github", ticketSteps: null, ingress: null, fullAuto: null, color: "teal", emoji: "🚀", forge: null, maxConcurrent: 2,
  startedAt: null, updatedAt: null, active: 1, queued: 0, paused: false, restartPending: false, lastEvent: null, configPath: null, createdAt: null,
  lastSeenAt: null, ghost: false, configMissing: false, died: false, recentCosts: [], recentRuns: [], quotaPaused: null, quota: null, ...over,
});
const held = (p: string, ref: string): TicketRow => ({
  profile: p, ref, displayId: ref, title: null, step: null, status: "held", model: null, startedAt: null, costUsd: 0, estUsd: 0, trackerUrl: null, prUrl: null,
  summary: null, plain: null, options: null, heldReason: null, heldAt: null, failReason: null, prState: null, prNeeds: null, finishedAt: null, queuePos: null, queuedAt: null, epic: null,
});

const render = (snapshot: Snapshot) => renderToStaticMarkup(createElement(HomePage, { snapshot, now: NOW, menuItems: () => [], note: () => "" }));

describe("HomePage", () => {
  it("points the empty state at `agenthook init`", () => {
    expect(render({ profiles: [], tickets: [] })).toContain("agenthook init");
  });

  it("links each card to its profile and leads with the Needs-you number", () => {
    const html = render({ profiles: [profile("dev")], tickets: [held("dev", "1"), held("dev", "2")] });
    expect(html).toContain('href="#/p/dev"');
    expect(html).toContain('data-needs-you="2"');
    expect(html).toContain("--profile-accent:var(--color-profile-teal)");
  });

  it("says 'all clear' at zero, and hides cost and last event when there is nothing to show", () => {
    const html = render({ profiles: [profile("dev")], tickets: [] });
    expect(html).toContain("all clear");
    expect(html).not.toContain("cost today");
    expect(html).not.toMatch(/<p class="mt-3 truncate/);
  });

  it("folds a down profile into the Inactive strip, but keeps a full card when it still needs you", () => {
    const html = render({ profiles: [profile("up"), profile("idle", { up: false, pid: null }), profile("sad", { up: false, pid: null })], tickets: [held("sad", "9")] });
    expect(html).toContain('data-inactive-row="idle"');
    expect(html).not.toContain('data-inactive-row="sad"');
    expect(html).toContain('data-profile-card="sad"');
    expect(html).toContain("Inactive (1)");
  });

  it("orders cards by Needs you", () => {
    const html = render({ profiles: [profile("a"), profile("b")], tickets: [held("b", "1")] });
    expect(html.indexOf('data-profile-card="b"')).toBeLessThan(html.indexOf('data-profile-card="a"'));
  });

  it("renders an up profile's count red/amber, live", () => {
    const html = render({ profiles: [profile("dev")], tickets: [held("dev", "1")] });
    expect(html).toMatch(/tabular-nums text-status-held/);
    expect(html).not.toContain('data-stale="true"');
  });

  it("mutes a stopped profile's count and shows its as-of age, instead of a live red/amber alert", () => {
    const html = render({ profiles: [profile("dev", { up: false, pid: null, died: false, lastSeenAt: "2026-10-08T11:00:00.000Z" })], tickets: [held("dev", "1")] });
    expect(html).toContain('data-stale="true"');
    expect(html).toContain("as of");
    expect(html).not.toMatch(/tabular-nums text-status-(held|failed)/);
  });

  it("shows the 'stopped unexpectedly' pill on a died profile", () => {
    const html = render({ profiles: [profile("dev", { up: false, pid: 1234, died: true })], tickets: [held("dev", "1")] });
    expect(html).toContain('data-died="true"');
    expect(html).toContain("stopped unexpectedly");
  });

  it("shows no died pill on a stopped-but-not-died profile", () => {
    const html = render({ profiles: [profile("dev", { up: false, pid: null, died: false })], tickets: [held("dev", "1")] });
    expect(html).not.toContain('data-died="true"');
    expect(html).not.toContain("stopped unexpectedly");
  });
});
