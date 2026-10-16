import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Overview } from "./Overview";
import type { OverviewProps } from "./Overview";
import type { ReleaseOutcome } from "./config";
import type { ProfileView, TicketRow } from "./contract";

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();
const local = (h: number, day = 8) => new Date(2026, 9, day, h).toISOString();

const profile = (over: Partial<ProfileView> = {}): ProfileView => ({
  name: "dev", label: "dev", up: true, pid: 1, port: null, tracker: "github", ingress: null, fullAuto: null, color: "teal", emoji: "🚀", forge: null, maxConcurrent: 3,
  startedAt: null, updatedAt: null, active: 1, queued: 0, paused: false, restartPending: false, lastEvent: null, configPath: null, createdAt: null,
  lastSeenAt: null, ghost: false, configMissing: false, recentCosts: [], recentRuns: [], ...over,
});
const ticket = (ref: string, over: Partial<TicketRow> = {}): TicketRow => ({
  profile: "dev", ref, displayId: `#${ref}`, title: `Title ${ref}`, step: "code", status: "idle", model: "claude-opus-5-5", startedAt: local(9), costUsd: 1.5, trackerUrl: null,
  prUrl: null, heldReason: null, heldAt: null, failReason: null, prState: null, finishedAt: null, queuePos: null, ...over,
});

const render = (p: ProfileView, tickets: TicketRow[], over: Partial<OverviewProps> = {}) =>
  renderToStaticMarkup(
    createElement(Overview, {
      profile: p, snapshot: { profiles: [p], tickets }, now: NOW, feed: [], statusFilter: "", setStatusFilter: () => {}, showAll: false, setShowAll: () => {},
      open: null, onOpen: () => {}, displayIdFor: () => null, menuItems: [], note: "", onDismiss: () => {}, onRelease: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }), ...over,
    }),
  );

describe("Overview", () => {
  it("hides the Needs-you zone when nothing needs the human", () => {
    expect(render(profile(), [ticket("1", { status: "running" })])).not.toContain("data-needs-you-zone");
  });

  it("lists failed before held, with the reason and a Dismiss action only on failed", () => {
    const html = render(profile(), [
      ticket("h", { status: "held", heldReason: "which db?", heldAt: local(8) }),
      ticket("f", { status: "failed", failReason: "tests red" }),
    ]);
    expect(html.indexOf('data-needs-row="f"')).toBeLessThan(html.indexOf('data-needs-row="h"'));
    expect(html).toContain("tests red");
    expect(html).toContain("which db?");
    expect(html.match(/>Dismiss</g)).toHaveLength(1);
  });

  it("offers Release… on held rows only, with the answer panel closed until clicked", () => {
    const html = render(profile(), [ticket("h", { status: "held", heldReason: "?" }), ticket("f", { status: "failed", failReason: "x" })]);
    expect(html.match(/data-release-open/g)).toHaveLength(1);
    expect(html).not.toContain("data-release-panel");
  });

  it("counts a ready PR as Needs you only on a forge profile", () => {
    const pr = ticket("p", { status: "done", prState: "ready", finishedAt: local(10), prUrl: "https://github.com/o/r/pull/7" });
    expect(render(profile({ forge: "github" }), [pr])).toContain('data-kind="pr"');
    expect(render(profile({ forge: null }), [pr])).not.toContain("data-needs-you-zone");
  });

  it("shows running agents, free slots and the queue in order", () => {
    const html = render(profile({ active: 1, maxConcurrent: 3, queued: 2 }), [
      ticket("r", { status: "running" }),
      ticket("q2", { status: "queued", queuePos: 1 }),
      ticket("q1", { status: "queued", queuePos: 0 }),
    ]);
    expect(html).toContain('data-now-row="r"');
    expect(html.match(/data-free-slot/g)).toHaveLength(2);
    expect(html.indexOf('data-now-row="q1"')).toBeLessThan(html.indexOf('data-now-row="q2"'));
    expect(html.match(/data-slot="busy"/g)).toHaveLength(1);
  });

  it("says a down receiver runs nothing and shows no free slots", () => {
    const html = render(profile({ up: false, pid: null, active: null }), []);
    expect(html).toContain("receiver is down");
    expect(html).not.toContain("data-free-slot");
  });

  it("hides the rework rate until there are enough runs, then shows it", () => {
    const runs = (n: number) => Array.from({ length: n }, (_, i) => ({ at: local(9), outcome: i < 2 ? "changes" : "advance" }));
    expect(render(profile({ recentRuns: runs(9) }), [])).toContain("needs 10+ runs (9 so far)");
    expect(render(profile({ recentRuns: runs(10) }), [])).toContain("20%");
  });

  it("opens the All tickets drill-down only while a status filter is active", () => {
    expect(render(profile(), [])).not.toMatch(/<details[^>]*data-all-tickets[^>]*open/);
    expect(render(profile(), [], { statusFilter: "failed" })).toMatch(/<details[^>]*data-all-tickets[^>]*open/);
  });
});
