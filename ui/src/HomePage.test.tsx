import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HomePage } from "./HomePage";
import type { ProfileView, Snapshot, TicketRow } from "./contract";

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();

const profile = (name: string, over: Partial<ProfileView> = {}): ProfileView => ({
  name, label: name, up: true, pid: 1, port: null, tracker: "github", ingress: null, fullAuto: null, color: "teal", emoji: "🚀", forge: null, maxConcurrent: 2,
  startedAt: null, updatedAt: null, active: 1, queued: 0, paused: false, restartPending: false, lastEvent: null, configPath: null, createdAt: null,
  lastSeenAt: null, ghost: false, configMissing: false, recentCosts: [], recentRuns: [], quotaPaused: null, quota: null, ...over,
});
const held = (p: string, ref: string): TicketRow => ({
  profile: p, ref, displayId: ref, title: null, step: null, status: "held", model: null, startedAt: null, costUsd: 0, estUsd: 0, trackerUrl: null, prUrl: null,
  summary: null, plain: null, options: null, heldReason: null, heldAt: null, failReason: null, prState: null, finishedAt: null, queuePos: null, epic: null,
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
});
