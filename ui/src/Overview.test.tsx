import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Overview } from "./Overview";
import type { OverviewProps } from "./Overview";
import type { ReleaseOutcome } from "./config";
import type { ProfileView, TicketRow } from "./contract";

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();
const local = (h: number, day = 8) => new Date(2026, 9, day, h).toISOString();

const profile = (over: Partial<ProfileView> = {}): ProfileView => ({
  name: "dev", label: "dev", up: true, pid: 1, port: null, tracker: "github", ticketSteps: null, ingress: null, fullAuto: null, color: "teal", emoji: "🚀", forge: null, maxConcurrent: 3,
  startedAt: null, updatedAt: null, active: 1, queued: 0, paused: false, restartPending: false, lastEvent: null, configPath: null, createdAt: null,
  lastSeenAt: null, ghost: false, configMissing: false, died: false, recentCosts: [], recentRuns: [], quotaPaused: null, quota: null, ...over,
});
const ticket = (ref: string, over: Partial<TicketRow> = {}): TicketRow => ({
  profile: "dev", ref, displayId: `#${ref}`, title: `Title ${ref}`, step: "code", status: "idle", model: "claude-opus-5-5", startedAt: local(9), costUsd: 1.5, estUsd: 0, trackerUrl: null,
  prUrl: null, summary: null, plain: null, options: null, heldReason: null, heldAt: null, failReason: null, prState: null, prNeeds: null, finishedAt: null, queuePos: null, queuedAt: null, epic: null, ...over,
});

const render = (p: ProfileView, tickets: TicketRow[], over: Partial<OverviewProps> = {}) =>
  renderToStaticMarkup(
    createElement(Overview, {
      profile: p, snapshot: { profiles: [p], tickets }, now: NOW, feed: [], statusFilter: "", setStatusFilter: () => {}, epicFilter: "", setEpicFilter: () => {}, stepFilter: "", setStepFilter: () => {}, showAll: false, setShowAll: () => {},
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
    const html = render(profile(), [ticket("f", { status: "failed", failReason: "x" }), ticket("h", { status: "held", heldReason: "?" }), ticket("r", { status: "running" })]);
    expect(html).toMatch(/text-stat[^>]*text-status-failed[^>]*>2<\/span> <span[^>]*>need you/);
    expect(html.indexOf("data-needs-you-zone")).toBeLessThan(html.indexOf("data-now-row"));
    expect(html.indexOf("data-needs-you-zone")).toBeLessThan(html.indexOf("data-digest"));
  });

  it("names every row action after its ticket and announces the headline politely", () => {
    const html = render(profile({ forge: "github" }), [ticket("f", { status: "failed", failReason: "x" }), ticket("h", { status: "held", heldReason: "?" })]);
    expect(html).toContain('aria-label="Dismiss #f"');
    expect(html).toContain('aria-label="Release #h…"');
    expect(html).toMatch(/aria-live="polite" data-needs-live[^>]*>2 tickets need you</);
    expect(render(profile(), [])).toMatch(/data-needs-live[^>]*>All clear, nothing needs you</);
  });

  it("narrow: a Needs-you row puts its step and its action on one line under the title", () => {
    const html = render(profile(), [ticket("f", { status: "failed", failReason: "x", step: "qa" }), ticket("r", { status: "running" })]);
    expect(html).toMatch(/class="[^"]*@max-4xl:col-start-3 @max-4xl:col-end-\[-1\][^"]*"><span data-row-step="true" class="mr-auto @4xl:hidden">.*?qa.*?<\/span><button type="button" data-needs-dismiss/);
  });

  it("a Now row is one line of essentials: id, title, step, time — model, context, cost and the agent's sentence live in the drawer", () => {
    const row = (html: string, ref: string) => html.slice(html.indexOf(`data-now-row="${ref}"`), html.indexOf("</li>", html.indexOf(`data-now-row="${ref}"`)));
    const html = render(profile(), [
      ticket("r", { status: "running", step: "code", ctx: 190000, ctxMax: 200000, costUsd: 1.5, summary: "Cap triage runs.", plain: "Triage confirmed the bug." }),
      ticket("q", { status: "queued", step: "code", queuePos: 1, summary: "Queued summary." }),
    ]);
    for (const ref of ["r", "q"]) {
      const r = row(html, ref);
      expect(r, ref).toContain(`Title ${ref}`);
      expect(r, ref).toContain(">code<");
      expect(r, ref).not.toContain("tokens");
      expect(r, ref).not.toContain("claude-");
      expect(r, ref).not.toContain("$");
      expect(r, ref).not.toContain("text-status-failed");
      expect(r, ref).not.toContain("data-now-sub");
      expect(r, ref).not.toMatch(/>(Cap triage runs\.|Triage confirmed the bug\.|Queued summary\.)</);
    }
    expect(row(html, "r")).toContain("data-elapsed");
    expect(row(html, "r").match(/<button/g)?.length).toBe(1); // one action: open the drawer
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

  it("says what a ticket is about: a Now row carries it in the title tooltip, Needs you shows the reason first and the summary when there is none", () => {
    const html = render(profile({ forge: "github" }), [
      ticket("r", { status: "running", summary: "Cap triage runs so they cannot take every slot." }),
      ticket("h", { status: "held", heldReason: "which db?", heldAt: local(8), summary: "Held ticket summary." }),
      ticket("p", { status: "done", prState: "ready", prNeeds: "openOnDone", finishedAt: local(9), prUrl: "https://github.com/o/r/pull/8", summary: "PR-ready summary." }),
    ]);
    const row = (attr: string) => html.slice(html.indexOf(attr), html.indexOf("</li>", html.indexOf(attr)));
    expect(row('data-now-row="r"')).toContain('title="Title r — Cap triage runs so they cannot take every slot. — open details"');
    expect(row('data-needs-row="h"')).toContain("which db?");
    expect(row('data-needs-row="h"')).toContain("Held ticket summary."); // tooltip only
    expect(row('data-needs-row="h"')).not.toMatch(/data-needs-sub[^>]*>Held ticket summary/);
    expect(row('data-needs-row="p"')).toMatch(/data-needs-sub[^>]*>Open PR on a done ticket — merge or close</); // the PR reason, like held/failed
  });

  it("shows the agent's plain sentence in place of the reason / summary, with the full text in the tooltip (#563)", () => {
    const raw = "non-zero exit (1) — last log lines: npm ERR! test failed";
    const html = render(profile({ forge: "github" }), [
      ticket("f", { status: "failed", failReason: raw, plain: "The tests failed; decide whether to re-run." }),
      ticket("h", { status: "held", heldReason: "which db?", heldAt: local(8), summary: "Held ticket summary.", plain: "It needs you to pick a database." }),
      ticket("p", { status: "done", prState: "ready", prNeeds: "openOnDone", finishedAt: local(9), prUrl: "https://github.com/o/r/pull/8", summary: "PR-ready summary.", plain: "The change is ready to merge." }),
      ticket("r", { status: "running", summary: "Cap triage runs.", plain: "Triage confirmed the bug." }),
    ]);
    const row = (attr: string) => html.slice(html.indexOf(attr), html.indexOf("</li>", html.indexOf(attr)));
    expect(row('data-needs-row="f"')).toContain(`data-needs-sub="true" title="${raw}">The tests failed; decide whether to re-run.</span>`);
    expect(row('data-needs-row="f"')).toContain('aria-label="#f Title f, failed: The tests failed; decide whether to re-run."');
    expect(row('data-needs-row="h"')).toContain('data-needs-sub="true" title="which db?">It needs you to pick a database.</span>');
    expect(row('data-needs-row="p"')).toContain('data-needs-sub="true" title="Open PR on a done ticket — merge or close">The change is ready to merge.</span>');
    expect(row('data-now-row="r"')).toContain('title="Title r — Triage confirmed the bug. — open details"'); // the agent's sentence leads the tooltip
    for (const r of ['data-needs-row="f"', 'data-needs-row="h"']) expect(row(r)).not.toMatch(/font-mono[^>]*data-needs-sub/);
  });

  it("keeps each row's primary action visible in one fixed slot (PR link on a PR reason, Release on held, Re-run on failed)", () => {
    const html = render(profile({ forge: "github" }), [
      ticket("p", { status: "done", prState: "ready", prNeeds: "openOnDone", finishedAt: local(9), prUrl: "https://github.com/o/r/pull/8114" }),
      ticket("n", { status: "done", prState: "ready", finishedAt: local(9), prUrl: null }),
      ticket("h", { status: "held", heldReason: "q?", heldAt: local(8) }),
      ticket("f", { status: "failed", failReason: "x" }),
    ]);
    const row = (ref: string) => html.slice(html.indexOf(`data-needs-row="${ref}"`), html.indexOf("</li>", html.indexOf(`data-needs-row="${ref}"`)));
    expect(row("p")).toMatch(/data-needs-primary[^>]*><a[^>]*href="https:\/\/github.com\/o\/r\/pull\/8114"[^>]*>PR #8114/);
    expect(row("h")).toMatch(/data-needs-primary[^>]*><button[^>]*data-release-open/);
    expect(row("f")).toMatch(/data-needs-primary[^>]*><button[^>]*data-needs-retry[^>]*>Re-run</);
    expect(row("f")).toMatch(/data-needs-dismiss[^>]*>Dismiss</); // secondary, before the primary
    expect(html).not.toContain('data-needs-row="n"'); // no PR known: Done, not Needs you
    for (const r of ["p", "h", "f"]) expect(row(r), r).not.toContain("opacity-0"); // nothing hover-gated
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

  it("counts a PR reason as Needs you only on a forge profile", () => {
    const pr = ticket("p", { status: "idle", prState: "merged", prNeeds: "mergedOpen", finishedAt: null, prUrl: "https://github.com/o/r/pull/7" });
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

  it("shows an active/max chip per harness next to the slot pips; none without harnesses (#620)", () => {
    const html = render(profile({ harnesses: { qwen: { active: 1, max: 2 }, opus: { active: 0, max: null } } }), []);
    expect(html).toMatch(/data-harness="qwen" class="[^"]*" title="harness qwen: 1 of 2 slots in use">qwen <span[^>]*>1<\/span><span[^>]*>\/2<\/span>/);
    expect(html).toMatch(/data-harness="opus"[^>]*title="harness opus: 0 running, no cap of its own">opus <span[^>]*>0<\/span><span[^>]*>\/∞<\/span>/);
    expect(html.indexOf("data-slot=")).toBeLessThan(html.indexOf("data-harness-slots"));
    expect(render(profile(), [])).not.toContain("data-harness");
  });

  it("shows an implicit, uncapped chip per unharnessed agent next to the configured chips; none without any (#726)", () => {
    const html = render(profile({ harnesses: { qwen: { active: 1, max: 2 } }, unharnessed: { claude: 3 } }), []);
    expect(html).toMatch(/data-harness-implicit="claude"[^>]*>claude <span[^>]*>3<\/span><\/span>/);
    expect(html).not.toMatch(/data-harness-implicit="claude"[^>]*\/\d/); // no /max beside it
    expect(html.indexOf('data-harness="qwen"')).toBeLessThan(html.indexOf('data-harness-implicit="claude"'));

    const onlyUnharnessed = render(profile({ harnesses: undefined, unharnessed: { claude: 1 } }), []);
    expect(onlyUnharnessed).toContain('data-harness-implicit="claude"');

    expect(render(profile({ unharnessed: {} }), [])).not.toContain("data-harness-implicit");
    expect(render(profile(), [])).not.toContain("data-harness-implicit");
  });

  it("a quota-closed harness chip shows its reopen time with a warn tint, not a failure tint (#723)", () => {
    const harnesses = {
      spent: { active: 0, max: 1, state: "down" as const, until: "2026-10-08T13:00:00.000Z", reason: "quota: weekly 92% ≥ 90%", cause: "quota" as const },
    };
    const html = render(profile({ harnesses }), []);
    expect(html).toContain('data-harness="spent" data-harness-state="down" data-harness-cause="quota"');
    expect(html).toContain("back at 13:00Z");
    expect(html).toMatch(/data-harness="spent"[^>]*status-held/);
    expect(html).not.toMatch(/data-harness="spent"[^>]*status-failed/);
  });

  it("never renders the Harnesses table on Overview (it lives on the Statistics page now, #754); the live slot chips stay", () => {
    const html = render(profile({ harnesses: { qwen: { active: 1, max: 2 } } }), []);
    expect(html).not.toContain("data-harnesses-table");
    expect(html).toContain("data-harness-slots");
    expect(html).toContain('data-harness="qwen"');
  });

  it("shows waiting time on a queued row with a queuedAt stamp, and nothing with none", () => {
    const html = render(profile({ active: 1, maxConcurrent: 3, queued: 2 }), [
      ticket("q1", { status: "queued", queuePos: 0, queuedAt: new Date(NOW - 6 * 60_000).toISOString() }),
      ticket("q2", { status: "queued", queuePos: 1, queuedAt: null }),
    ]);
    const q1 = html.slice(html.indexOf('data-now-row="q1"'), html.indexOf('data-now-row="q2"'));
    const q2 = html.slice(html.indexOf('data-now-row="q2"'));
    expect(q1).toContain("data-waiting");
    expect(q1).toContain("waiting 6m");
    expect(q2).not.toContain("data-waiting");
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
    expect(render(profile(), [], { stepFilter: "code" })).toContain('data-open="true"');
    expect(render(profile(), [])).toMatch(/data-tickets-toggle[^>]*aria-expanded="false"/);
    // A filter holds it open, and the way back (Hide) stays on screen.
    expect(render(profile(), [], { statusFilter: "done" })).toMatch(/data-tickets-toggle[^>]*aria-expanded="true"/);
  });

  it("a filter opens All tickets on the table (#697)", () => {
    const withFilter = render(profile(), [], { statusFilter: "failed" });
    expect(withFilter).toContain("data-tickets-toolbar");
    expect(render(profile(), [], { stepFilter: "code" })).toContain("step: code");
  });

  it("one board: the rows that need you first, then what runs, on the same grid (#696)", () => {
    const html = render(profile(), [ticket("h", { status: "held", heldReason: "?" }), ticket("r", { status: "running", step: "code" })]);
    expect(html.match(/data-board=/g)).toHaveLength(1);
    const board = html.slice(html.indexOf("data-board="));
    expect(board.indexOf("data-board-head")).toBeLessThan(board.indexOf('data-needs-row="h"'));
    expect(board.indexOf('data-needs-row="h"')).toBeLessThan(board.indexOf('data-now-row="r"'));
    // Until the pipeline's steps are read there are no step columns: each row names its step.
    expect(html).toContain('data-board-steps="0"');
    expect(html).not.toContain("data-track=");
    expect(html).toMatch(/data-row-step="true" class="mt-1 block "/);
  });

  it("all clear still shows the board, under the verdict", () => {
    const html = render(profile(), [ticket("r", { status: "running" })]);
    expect(html.indexOf("data-all-clear")).toBeLessThan(html.indexOf("data-board="));
    expect(html).toContain('data-now-row="r"');
  });

  it("leaves the quota readout to the app bar but keeps the quota-paused badge", () => {
    const quota = { sevenDay: { utilization: 0.66, resetsAt: new Date(NOW + 2 * 86400e3 + 4 * 3600e3).toISOString() }, fiveHour: { utilization: 0.08, resetsAt: new Date(NOW - 1).toISOString() } };
    const html = render(profile({ quota, quotaPaused: { window: "sevenDay", utilization: 0.92, threshold: 0.9, resetsAt: quota.sevenDay.resetsAt } }), []);
    expect(html).not.toContain("weekly 66%");
    expect(html).toContain("quota paused");
  });
});

describe("Overview: harness attention (#688)", () => {
  it("shows a down and a probing harness in Needs you, above the ticket rows, with the harness_reset hint", () => {
    const harnesses = {
      qwen: { active: 0, max: 1, state: "down" as const, until: "2026-10-08T13:00:00.000Z", reason: "exited 1 with no output after 3s" },
      local: { active: 0, max: 1, state: "probing" as const },
    };
    const html = render(profile({ harnesses }), [ticket("h", { status: "held", heldReason: "?" })]);
    expect(html).toContain("data-needs-you-zone");
    expect(html).toMatch(/data-harness-state="down"[\s\S]*data-harness-state="probing"[\s\S]*data-needs-row="h"/);
    expect(html).toContain("harness_reset qwen");
    expect(html).toContain("harness_reset local");
    expect(html).toContain("exited 1 with no output after 3s");
  });

  it("an all-up profile (even a full harness, a routing spill) shows none, and All clear still fires", () => {
    const html = render(profile({ harnesses: { qwen: { active: 1, max: 1, state: "up" as const } } }), [ticket("1", { status: "running" })]);
    expect(html).not.toContain('data-needs-row="harness:');
    expect(html).toMatch(/data-all-clear/);
  });

  it("counts the down harness in the headline alongside tickets", () => {
    const harnesses = { qwen: { active: 0, max: 1, state: "down" as const } };
    const html = render(profile({ harnesses }), [ticket("f", { status: "failed", failReason: "x" })]);
    expect(html).toMatch(/font-mono text-stat font-semibold[^>]*>2<\/span>/);
  });
});
