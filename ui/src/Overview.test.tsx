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
  prUrl: null, summary: null, plain: null, options: null, heldReason: null, heldAt: null, failReason: null, prState: null, finishedAt: null, queuePos: null, epic: null, ...over,
});

const render = (p: ProfileView, tickets: TicketRow[], over: Partial<OverviewProps> = {}) =>
  renderToStaticMarkup(
    createElement(Overview, {
      profile: p, snapshot: { profiles: [p], tickets }, now: NOW, feed: [], statusFilter: "", setStatusFilter: () => {}, epicFilter: "", setEpicFilter: () => {}, showAll: false, setShowAll: () => {},
      open: null, onOpen: () => {}, displayIdFor: () => null, menuItems: [], note: "", onDismiss: () => {}, onRelease: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }), onRetry: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }), ...over,
    }),
  );

describe("Overview", () => {
  it("says All clear instead of the Needs-you list when nothing needs the human", () => {
    const html = render(profile(), [ticket("1", { status: "running" })]);
    expect(html).not.toContain("data-needs-you-zone");
    expect(html).toMatch(/data-all-clear[\s\S]*text-success[\s\S]*text-stat font-semibold">All clear/);
    expect(render(profile({ up: false, pid: null, active: null }), [])).toContain("Nothing needs you");
  });

  it("leads with Needs you: its count is the headline, before Now and the digest", () => {
    const html = render(profile(), [ticket("f", { status: "failed", failReason: "x" }), ticket("h", { status: "held", heldReason: "?" })]);
    expect(html).toMatch(/text-stat[^>]*text-status-failed[^>]*>2<\/span> <span[^>]*>need you/);
    expect(html.indexOf("data-needs-you-zone")).toBeLessThan(html.indexOf("data-now-row") === -1 ? html.indexOf("data-free-slots") : html.indexOf("data-now-row"));
    expect(html.indexOf("data-needs-you-zone")).toBeLessThan(html.indexOf("data-digest"));
  });

  it("names every row action after its ticket and announces the headline politely", () => {
    const html = render(profile({ forge: "github" }), [ticket("f", { status: "failed", failReason: "x" }), ticket("h", { status: "held", heldReason: "?" })]);
    expect(html).toContain('aria-label="Dismiss #f"');
    expect(html).toContain('aria-label="Release #h…"');
    expect(html).toMatch(/aria-live="polite" data-needs-live[^>]*>2 tickets need you</);
    expect(render(profile(), [])).toMatch(/data-needs-live[^>]*>All clear, nothing needs you</);
  });

  it("narrow: Needs-you rows stack the title under the action line; Now rows drop model, cost and Follow log", () => {
    const html = render(profile(), [ticket("f", { status: "failed", failReason: "x" }), ticket("r", { status: "running" })]);
    expect(html).toMatch(/data-needs-open="true" aria-label="[^"]*" class="[^"]*max-sm:order-last max-sm:basis-full/);
    expect(html).toMatch(/max-sm:hidden" title="claude-opus-5-5"/);
    expect(html).toMatch(/max-sm:hidden" title="cost so far/);
  });

  it("hides a dismissed-but-undoable ticket from Needs you", () => {
    const html = render(profile(), [ticket("f", { status: "failed", failReason: "x" }), ticket("g", { status: "failed", failReason: "y" })], { dismissing: new Set(["dev\u0000f"]) });
    expect(html).not.toContain('data-needs-row="f"');
    expect(html).toContain('data-needs-row="g"');
  });

  it("lists failed before held, with the reason and a Dismiss action only on failed", () => {
    const html = render(profile(), [
      ticket("h", { status: "held", heldReason: "which db?", heldAt: local(8) }),
      ticket("f", { status: "failed", failReason: "tests red" }),
    ]);
    expect(html.indexOf('data-needs-row="f"')).toBeLessThan(html.indexOf('data-needs-row="h"'));
    expect(html).toContain("tests red");
    expect(html).toContain("which db?");
    expect(html.match(/data-needs-dismiss/g)).toHaveLength(1);
  });

  it("a failed row: one plain-words reason (raw log in the drawer), a short accessible name; Open log instead of Re-run when down", () => {
    const raw = 'sandbox (docker) could not start the run: service "bad" not ready within 5s (wait: false) — last log lines: 2026-10-24T18:00:00Z boot';
    const row = (html: string) => html.slice(html.indexOf('data-needs-row="f"'), html.indexOf("</li>", html.indexOf('data-needs-row="f"')));
    const up = row(render(profile(), [ticket("f", { status: "failed", failReason: raw })]));
    expect(up).toMatch(/data-needs-sub[^>]*>Sandbox could not start: service &quot;bad&quot; not ready within 5s \(wait: false\)</);
    expect(up).not.toContain("last log lines");
    expect(up).toContain('aria-label="#f Title f, failed: Sandbox could not start: service &quot;bad&quot; not ready within 5s (wait: false)"');
    expect(up).toContain('aria-label="Re-run #f (code)"');
    const down = row(render(profile({ up: false }), [ticket("f", { status: "failed", failReason: "non-zero exit (1)" })]));
    expect(down).not.toContain("data-needs-retry");
    expect(down).toMatch(/data-needs-primary[^>]*><button[^>]*data-needs-log[^>]*>Open log</);
    expect(down).toContain("data-needs-dismiss");
    expect(down).toContain("The agent exited with code 1");
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

  it("shows the agent's plain sentence in place of the reason / summary, with the full text in the tooltip (#563)", () => {
    const raw = "non-zero exit (1) — last log lines: npm ERR! test failed";
    const html = render(profile({ forge: "github" }), [
      ticket("f", { status: "failed", failReason: raw, plain: "The tests failed; decide whether to re-run." }),
      ticket("h", { status: "held", heldReason: "which db?", heldAt: local(8), summary: "Held ticket summary.", plain: "It needs you to pick a database." }),
      ticket("p", { status: "done", prState: "ready", finishedAt: local(9), prUrl: "https://github.com/o/r/pull/8", summary: "PR-ready summary.", plain: "The change is ready to merge." }),
      ticket("r", { status: "running", summary: "Cap triage runs.", plain: "Triage confirmed the bug." }),
    ]);
    const row = (attr: string) => html.slice(html.indexOf(attr), html.indexOf("</li>", html.indexOf(attr)));
    expect(row('data-needs-row="f"')).toContain(`data-needs-sub="true" title="${raw}">The tests failed; decide whether to re-run.</span>`);
    expect(row('data-needs-row="f"')).toContain('aria-label="#f Title f, failed: The tests failed; decide whether to re-run."');
    expect(row('data-needs-row="h"')).toContain('data-needs-sub="true" title="which db?">It needs you to pick a database.</span>');
    expect(row('data-needs-row="p"')).toContain('data-needs-sub="true" title="PR-ready summary.">The change is ready to merge.</span>');
    expect(row('data-now-row="r"')).toMatch(/data-now-sub="true">Triage confirmed the bug\.</);
    expect(row('data-now-row="r"')).toContain('title="Title r — Cap triage runs. — open details"');
    for (const r of ['data-needs-row="f"', 'data-needs-row="h"', 'data-now-row="r"']) expect(row(r)).not.toMatch(/font-mono[^>]*data-(needs|now)-sub/);
  });

  it("keeps each row's primary action visible in one fixed slot (PR link on PR ready, Release on held, Re-run on failed)", () => {
    const html = render(profile({ forge: "github" }), [
      ticket("p", { status: "done", prState: "ready", finishedAt: local(9), prUrl: "https://github.com/o/r/pull/8114" }),
      ticket("n", { status: "done", prState: "ready", finishedAt: local(9), prUrl: null }),
      ticket("h", { status: "held", heldReason: "q?", heldAt: local(8) }),
      ticket("f", { status: "failed", failReason: "x" }),
    ]);
    const row = (ref: string) => html.slice(html.indexOf(`data-needs-row="${ref}"`), html.indexOf("</li>", html.indexOf(`data-needs-row="${ref}"`)));
    expect(row("p")).toMatch(/data-needs-primary[^>]*><a[^>]*href="https:\/\/github.com\/o\/r\/pull\/8114"[^>]*>PR #8114/);
    expect(row("h")).toMatch(/data-needs-primary[^>]*><button[^>]*data-release-open/);
    expect(row("f")).toMatch(/data-needs-primary[^>]*><button[^>]*data-needs-retry[^>]*>Re-run</);
    expect(row("f")).toMatch(/data-needs-dismiss[^>]*>Dismiss</); // secondary, before the primary
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
    expect(html).toMatch(/data-free-slots="2"[^>]*>[\s\S]*?2 free slots/);
    expect(html.indexOf('data-now-row="q1"')).toBeLessThan(html.indexOf('data-now-row="q2"'));
    expect(html.match(/data-slot="busy"/g)).toHaveLength(1);
  });

  it("says a down receiver runs nothing and shows no free slots", () => {
    const html = render(profile({ up: false, pid: null, active: null }), []);
    expect(html).toMatch(/data-receiver="down"[^>]*text-status-held/);
    expect(html).toContain("receiver down");
    expect(html).not.toContain("data-free-slots");
  });

  it("explains a stopped receiver once at the top, with the commands that recover it", () => {
    const down = render(profile({ up: false, pid: null, active: null, configPath: "~/p/agenthook.config.json" }), []);
    expect(down).toContain("The receiver is stopped, so no agents will run.");
    expect(down).toContain("agenthook start --config ~/p/agenthook.config.json");
    expect(down).toContain("agenthook reconcile --config ~/p/agenthook.config.json");
    expect(down.match(/data-copy-command/g)).toHaveLength(2);
    expect(down).toContain('aria-label="Copy command: agenthook start --config ~/p/agenthook.config.json"');
    expect(down.indexOf("data-stopped-banner")).toBeLessThan(down.indexOf("data-all-clear"));
    expect(render(profile({ up: false, pid: null, configMissing: true }), [])).not.toContain("agenthook start");
    expect(render(profile(), [])).not.toContain("data-stopped-banner");
  });

  it("hides the rework rate until there are enough runs, then shows it", () => {
    const runs = (n: number) => Array.from({ length: n }, (_, i) => ({ at: local(9), outcome: i < 2 ? "changes" : "advance" }));
    expect(render(profile({ recentRuns: runs(9) }), [])).toContain("needs 10+ runs (9 so far)");
    expect(render(profile({ recentRuns: runs(10) }), [])).toContain("20%");
  });

  it("opens the All tickets drill-down only while a status filter is active", () => {
    expect(render(profile(), [])).toContain('data-all-tickets="true" data-open="false"');
    expect(render(profile(), [], { statusFilter: "failed" })).toContain('data-open="true"');
    expect(render(profile(), [], { epicFilter: "E1" })).toContain('data-open="true"');
    expect(render(profile(), [])).toMatch(/data-tickets-toggle[^>]*aria-expanded="false"/);
  });

  it("leaves the quota readout to the app bar but keeps the quota-paused badge", () => {
    const quota = { sevenDay: { utilization: 0.66, resetsAt: new Date(NOW + 2 * 86400e3 + 4 * 3600e3).toISOString() }, fiveHour: { utilization: 0.08, resetsAt: new Date(NOW - 1).toISOString() } };
    const html = render(profile({ quota, quotaPaused: { window: "sevenDay", utilization: 0.92, threshold: 0.9, resetsAt: quota.sevenDay.resetsAt } }), []);
    expect(html).not.toContain("weekly 66%");
    expect(html).toContain("quota paused");
  });
});
