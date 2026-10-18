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
  lastSeenAt: null, ghost: false, configMissing: false, recentCosts: [], recentRuns: [], quotaPaused: null, quota: null, ...over,
});
const ticket = (ref: string, over: Partial<TicketRow> = {}): TicketRow => ({
  profile: "dev", ref, displayId: `#${ref}`, title: `Title ${ref}`, step: "code", status: "idle", model: "claude-opus-5-5", startedAt: local(9), costUsd: 1.5, estUsd: 0, trackerUrl: null,
  prUrl: null, summary: null, heldReason: null, heldAt: null, failReason: null, prState: null, finishedAt: null, queuePos: null, epic: null, ...over,
});

const render = (p: ProfileView, tickets: TicketRow[], over: Partial<OverviewProps> = {}) =>
  renderToStaticMarkup(
    createElement(Overview, {
      profile: p, snapshot: { profiles: [p], tickets }, now: NOW, feed: [], statusFilter: "", setStatusFilter: () => {}, epicFilter: "", setEpicFilter: () => {}, showAll: false, setShowAll: () => {},
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

  it("links every ticket id to its tracker page, in Needs you and in Now", () => {
    const url = "https://app.asana.com/0/1/2";
    const html = render(profile(), [ticket("f", { status: "failed", failReason: "x", displayId: "ID-1", trackerUrl: url }), ticket("r", { status: "running", displayId: "ID-2", trackerUrl: url })]);
    // the All tickets table links them too, so look inside the two zone rows specifically
    const row = (attr: string) => html.slice(html.indexOf(attr), html.indexOf("</li>", html.indexOf(attr)));
    for (const [attr, id] of [['data-needs-row="f"', "ID-1"], ['data-now-row="r"', "ID-2"]]) {
      expect(row(attr), attr).toMatch(new RegExp(`<a[^>]*href="${url}"[^>]*rel="noopener noreferrer"[^>]*>${id}`));
    }
  });

  it("says what a ticket is about: Now rows show the summary, Needs you shows the reason first and the summary when there is none", () => {
    const html = render(profile({ forge: "github" }), [
      ticket("r", { status: "running", summary: "Cap triage runs so they cannot take every slot." }),
      ticket("h", { status: "held", heldReason: "which db?", heldAt: local(8), summary: "Held ticket summary." }),
      ticket("p", { status: "done", prState: "ready", finishedAt: local(9), prUrl: "https://github.com/o/r/pull/8", summary: "PR-ready summary." }),
    ]);
    const row = (attr: string) => html.slice(html.indexOf(attr), html.indexOf("</li>", html.indexOf(attr)));
    expect(row('data-now-row="r"')).toContain("Cap triage runs so they cannot take every slot.");
    expect(row('data-needs-row="h"')).toContain("which db?");
    expect(row('data-needs-row="h"')).toContain("Held ticket summary."); // tooltip only
    expect(row('data-needs-row="h"')).not.toMatch(/data-needs-sub[^>]*>Held ticket summary/);
    expect(row('data-needs-row="p"')).toMatch(/data-needs-sub[^>]*>PR-ready summary\./);
  });

  it("keeps each row's primary action visible in one fixed slot (PR link on PR ready, Release on held, Dismiss on failed)", () => {
    const html = render(profile({ forge: "github" }), [
      ticket("p", { status: "done", prState: "ready", finishedAt: local(9), prUrl: "https://github.com/o/r/pull/8114" }),
      ticket("n", { status: "done", prState: "ready", finishedAt: local(9), prUrl: null }),
      ticket("h", { status: "held", heldReason: "q?", heldAt: local(8) }),
      ticket("f", { status: "failed", failReason: "x" }),
    ]);
    const row = (ref: string) => html.slice(html.indexOf(`data-needs-row="${ref}"`), html.indexOf("</li>", html.indexOf(`data-needs-row="${ref}"`)));
    expect(row("p")).toMatch(/data-needs-primary[^>]*><a[^>]*href="https:\/\/github.com\/o\/r\/pull\/8114"[^>]*>PR #8114/);
    expect(row("h")).toMatch(/data-needs-primary[^>]*><button[^>]*data-release-open/);
    expect(row("f")).toMatch(/data-needs-primary[^>]*><button[^>]*>Dismiss/);
    expect(html).not.toContain('data-needs-row="n"'); // no PR known: Finished, not Needs you
    for (const r of ["p", "h", "f"]) expect(row(r), r).not.toContain("opacity-0"); // nothing hover-gated
  });

  it("shows no second line for a ticket without a summary", () => {
    const html = render(profile(), [ticket("r", { status: "running", summary: null })]);
    expect(html).not.toContain("data-now-sub");
  });

  it("shows a plain id when the ticket has no tracker URL", () => {
    const html = render(profile(), [ticket("f", { status: "failed", failReason: "x", displayId: "ID-9", trackerUrl: null })]);
    expect(html).toContain(">ID-9</span>");
    expect(html).not.toMatch(/<a[^>]*>ID-9/);
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
    expect(render(profile(), [], { epicFilter: "E1" })).toMatch(/<details[^>]*data-all-tickets[^>]*open/);
  });

  it("shows the Claude quota tile (with a passed reset as reset) and a distinct quota-paused badge", () => {
    const quota = { sevenDay: { utilization: 0.66, resetsAt: new Date(NOW + 2 * 86400e3 + 4 * 3600e3).toISOString() }, fiveHour: { utilization: 0.08, resetsAt: new Date(NOW - 1).toISOString() } };
    const html = render(profile({ quota, quotaPaused: { window: "sevenDay", utilization: 0.92, threshold: 0.9, resetsAt: quota.sevenDay.resetsAt } }), []);
    expect(html).toContain("weekly 66% · resets in 2d 4h · 5h reset");
    expect(html).toContain("quota paused");
    expect(render(profile(), [])).not.toContain("data-quota");
  });
});
