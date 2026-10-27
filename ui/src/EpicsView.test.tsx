// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EpicsView, { EpicsList } from "./EpicsView";
import { EpicPage, paceOf } from "./EpicPage";
import type { EpicActions } from "./EpicPage";
import { EpicStageBar } from "./EpicStageBar";
import { epicDetail, epicStats, epicTicket, velocityDays } from "./epicsFixtures";
import type { EpicResponse, EpicsResponse, ProfileView, TicketRow } from "./contract";
import { I18nProvider } from "./i18n/react";
import { setLangSetting } from "./i18n";
import { mount } from "./domHarness";
import type { Mounted } from "./domHarness";

const profile = { name: "dev", label: "dev", up: true, color: "teal", emoji: "🚀", forge: null } as unknown as ProfileView;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const list = (over: Partial<EpicsResponse>) => html(createElement(EpicsList, { body: { at: "t", live: true, supported: true, epics: [], ...over }, profile: "dev" }));
const ok = async () => ({ ok: true as const, text: "" });
const page = (over: Partial<EpicResponse>, rows: TicketRow[] = [], actions: Partial<EpicActions> = {}) =>
  html(createElement(EpicPage, { body: { at: "t", live: true, supported: true, epic: null, ...over }, profile: "dev", rows, onOpen: () => {}, actions: { up: true, onRelease: ok, onRetry: ok, onDismiss: () => {}, ...actions } }));
const row = (ref: string) => ({ profile: "dev", ref }) as TicketRow;

describe("EpicsView", () => {
  it("renders its frame and a Refresh button before data arrives (the fetch runs in an effect)", () => {
    const out = html(createElement(EpicsView, { profile, rows: [], ticketsNonce: 0, onOpen: () => {} }));
    expect(out).toContain("data-epics-view");
    expect(out).toContain("data-refresh");
    expect(out).toContain("Loading epics…");
  });
});

describe("EpicsList", () => {
  const epics = [
    epicStats({ ref: "E1", name: "Checkout revamp", status: "On track", byStage: { done: 3, running: 1, needsYou: 2, backlog: 4 }, needsYou: ["a", "b"], eta: { days: 5, date: "2026-10-21" } }),
    epicStats({ ref: "E0", name: "Old epic", completed: true, byStage: { done: 3 } }),
    epicStats({ ref: "E2", name: "Search", byStage: { backlog: 3 } }),
  ];

  it("one row per epic: link to its page, status, N/M, needs-you count, ETA", () => {
    const out = list({ epics });
    expect(out.match(/data-epic-row=/g)).toHaveLength(3);
    expect(out).toContain('href="#/p/dev/epics/E1"');
    expect(out).toContain("Checkout revamp");
    expect(out).toContain("On track");
    expect(out).toMatch(/data-progress="true"><span class="font-mono">3(<!-- -->)?\/(<!-- -->)?10<\/span>/);
    expect(out).toContain(" · 7 left");
    expect(out).toContain('data-needs-you="2"');
    expect(out).toContain("~5 d · Oct 21");
    // Search: no needs-you, no ETA, no status pill
    const search = out.slice(out.indexOf('data-epic-row="E2"'));
    expect(search).not.toContain("data-needs-you");
  });

  it("closed epics sit last, collapsed under Closed (k), muted but not dimmed", () => {
    const out = list({ epics });
    const details = out.indexOf("data-epics-completed");
    expect(details).toBeGreaterThan(out.indexOf('data-epic-row="E2"'));
    expect(out.indexOf('data-epic-row="E0"')).toBeGreaterThan(details);
    const closed = out.slice(details);
    expect(closed).toMatch(/Closed<span[^>]*><span class="sr-only"> \(<\/span>1<span class="sr-only"> epic\)<\/span><\/span><\/summary>/);
    expect(out).not.toContain("opacity-");
    expect(out).not.toContain("Completed");
    expect(out).not.toMatch(/<details[^>]*data-epics-completed[^>]*\sopen/);
  });

  it("open epics sort needs you, then running, then ready to close; the chip takes the ETA slot", () => {
    const ready = epicStats({ ref: "E9", name: "Ready one", readyToClose: true, byStage: { done: 2 } });
    const out = list({ epics: [...epics, ready] });
    expect(out).toContain("ready to close");
    const at = (r: string) => out.indexOf(`data-epic-row="${r}"`);
    expect(at("E1")).toBeLessThan(at("E9"));
    expect(at("E9")).toBeLessThan(at("E2"));
    const running = epicStats({ ref: "E5", name: "Moving", byStage: { running: 1, backlog: 1 } });
    const out2 = list({ epics: [ready, running, ...epics] });
    expect(out2.indexOf('data-epic-row="E5"')).toBeLessThan(out2.indexOf('data-epic-row="E9"'));
    expect(out.slice(at("E9"), at("E2"))).toMatch(/data-eta="true"><span[^>]*>ready to close/);
  });

  it("supported:false → no-epics empty state; live:false → receiver-down note", () => {
    expect(list({ supported: false })).toContain("This tracker has no epics");
    const down = list({ live: false, epics: [epics[2]] });
    expect(down).toContain("data-live-note");
    expect(down).toContain("receiver down");
    expect(list({ epics: [epics[2]] })).not.toContain("data-live-note");
  });
});

describe("EpicPage", () => {
  const tickets = [
    epicTicket("r1", "running", { status: "running" }),
    epicTicket("b1", "backlog"),
    epicTicket("n1", "needsYou", { status: "held", name: "Answer me" }),
    epicTicket("f1", "done", { status: "done" }),
    epicTicket("m1", "done"),
    epicTicket("u1", "untracked", { name: "Orphan" }),
  ];
  const detail = epicDetail({ ref: "E1", name: "Checkout revamp", status: "At risk", url: "javascript:alert(1)", velocity: { days: velocityDays([0, 1, 0, 2]), finished14: 3, activeDays: 2, perDay: 0.25 } }, tickets);

  it("attention order: Needs you, running, backlog, not on the board, then done folded", () => {
    const out = page({ epic: detail });
    const at = (g: string) => out.indexOf(`data-group="${g}"`);
    expect(at("needsYou")).toBeGreaterThan(-1);
    expect(at("needsYou")).toBeLessThan(at("running"));
    expect(at("running")).toBeLessThan(at("backlog"));
    expect(at("backlog")).toBeLessThan(at("untracked"));
    expect(at("untracked")).toBeLessThan(at("history"));
    expect(out).toContain("Not on the board");
    expect(out.slice(at("untracked"), at("history"))).toContain("Orphan");
    const history = out.slice(at("history"));
    expect(history).toContain('data-epic-ticket="f1"');
    expect(history).toContain('data-epic-ticket="m1"');
    expect(out).not.toMatch(/<details[^>]*data-group="history"[^>]*\sopen/);
  });

  it("header and summary: name, status, safe link only, stage bar named in done, plain-language pace", () => {
    const out = page({ epic: detail });
    expect(out).toMatch(/<h2[^>]*>Checkout revamp<\/h2>/);
    expect(out).toContain("Tracker status: At risk");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('aria-label="2 of 6 done: 2 done, 1 running, 1 needs you, 1 backlog, 1 not on the board"');
    expect(out).not.toContain('data-chart="epic-velocity"');
    expect(out).toContain("Stalled: nothing finished for 10 days.");
    expect(out).toContain('data-stalled="true"');
    expect(out).toContain("4 left. No estimate yet: that needs work finished on 3 different days (2 so far).");
    expect(out).not.toContain("<header");
    const linked = page({ epic: { ...detail, url: "https://app.asana.com/0/1/E1" } });
    expect(linked).toContain('href="https://app.asana.com/0/1/E1"');
  });

  it("every ticket goes somewhere: drawer when it ran here, the tracker when it carries its own URL", () => {
    const out = page({ epic: detail }, [row("r1")]);
    expect(out).toMatch(/data-epic-ticket="r1"><button/);
    expect(out).toMatch(/data-epic-ticket="b1"><div/);
    const withUrl = { ...detail, tickets: detail.tickets.map((t) => (t.ref === "b1" ? { ...t, url: "https://acme.atlassian.net/browse/b1" } : t)) };
    const linked = page({ epic: withUrl }, [row("r1")]);
    expect(linked).toMatch(/data-epic-ticket="b1"><a[^>]*href="https:\/\/acme.atlassian.net\/browse\/b1"/);
  });

  it("a Needs-you ticket shows why and its one action", () => {
    const held = { ...row("n1"), status: "held", heldReason: "Which database should it use?", heldAt: null, startedAt: null, step: "plan" } as TicketRow;
    const out = page({ epic: detail }, [held]);
    const needs = out.slice(out.indexOf('data-group="needsYou"'), out.indexOf('data-group="running"'));
    expect(needs).toContain("Which database should it use?");
    expect(needs).toContain(">Release…</button>");
    expect(needs).toContain('aria-label="Release n1…"');
    expect(needs).toContain("plan");
    expect(needs).not.toContain(">Details<");
  });

  it("closed epics read as closed: pace says so, an empty one says Closed with no tickets", () => {
    const closed = epicDetail({ ref: "E7", completed: true }, [epicTicket("m1", "done")]);
    expect(page({ epic: closed })).toContain("Closed with 1 of 1 finished.");
    expect(page({ epic: epicDetail({ ref: "E8", completed: true }, []) })).toContain("Closed with no tickets.");
  });

  it("readyToClose shows a banner saying finished, linking the tracker when safe", () => {
    const ready = epicDetail({ ref: "E3", readyToClose: true, url: "https://app.asana.com/0/1/E3" }, [epicTicket("f1", "done")]);
    const out = page({ epic: ready });
    expect(out).toContain("data-ready-to-close");
    expect(out).toContain("All tickets finished.");
    expect(out).toContain("Close this epic on the tracker");
    expect(out).not.toContain("bg-status-done-bg");
    expect(out).not.toContain("shipped");
    expect(out).toContain('href="https://app.asana.com/0/1/E3"');

    const unsafe = epicDetail({ ref: "E4", readyToClose: true, url: "javascript:alert(1)" }, [epicTicket("f1", "done")]);
    const outUnsafe = page({ epic: unsafe });
    expect(outUnsafe).toContain("data-ready-to-close");
    expect(outUnsafe).toContain("on the tracker");
    expect(outUnsafe).not.toContain("javascript:");
  });

  it("no Needs you section when nothing needs you; live:false note; supported:false empty state", () => {
    const calm = epicDetail({ ref: "E2" }, [epicTicket("b1", "backlog")]);
    expect(page({ epic: calm })).not.toContain('data-group="needsYou"');
    expect(page({ epic: calm, live: false })).toContain("data-live-note");
    expect(page({ supported: false })).toContain("This tracker has no epics");
  });
});

describe("EpicStageBar", () => {
  const bar = (byStage: Record<string, number>, total: number, awaiting = 0) => html(createElement(EpicStageBar, { epic: { byStage, total } as never, awaiting }));
  const seg = (out: string, b: string) => out.match(new RegExp(`<span[^>]*data-seg="${b}"[^>]*>`))?.[0] ?? "";
  it("marks only the running segment so it slides (epic-seg-running)", () => {
    const out = bar({ done: 1, running: 2, needsYou: 0, backlog: 1, untracked: 0 }, 4);
    expect(seg(out, "running")).toContain("epic-seg-running");
    expect(seg(out, "done")).not.toContain("epic-seg-running");
    expect(seg(out, "backlog")).not.toContain("epic-seg-running");
  });
  it("has no animated segment when nothing is running", () => {
    expect(bar({ done: 2, running: 0, needsYou: 0, backlog: 2, untracked: 0 }, 4)).not.toContain("epic-seg-running");
  });
  it("one solid done segment; hollow awaiting merge only for the counted tickets with a known PR, carved out of done", () => {
    const out = bar({ done: 5, running: 0, needsYou: 0, backlog: 0, untracked: 0 }, 5, 1);
    expect(seg(out, "done")).toContain("bg-status-done");
    expect(seg(out, "done")).not.toContain("ring-status-done");
    expect(seg(out, "awaiting")).toContain("ring-status-done");
    expect(out).toContain("4 done, 1 awaiting merge");
    expect(bar({ done: 2, running: 0, needsYou: 0, backlog: 0, untracked: 0 }, 2)).not.toContain("ring-status-done");
  });
});

describe("EpicsList, second pass", () => {
  it("whole row is the link; closed rows drop the bar and status for a muted count", () => {
    const out = list({ epics: [epicStats({ ref: "E1", status: "Done", completed: true, byStage: { done: 7 } }), epicStats({ ref: "E2", byStage: { backlog: 1 } })] });
    expect(out).toContain("after:absolute");
    const closed = out.slice(out.indexOf('data-epic-row="E1"'));
    expect(closed).toMatch(/<span class="font-mono">7\/7<\/span> finished/);
    expect(closed).not.toContain("data-stage-bar");
    expect(closed).not.toContain(">Done<");
  });
  it("a swatch-only key under the open list; ready to close is neutral, a stall shows in the note slot", () => {
    const out = list({ epics: [epicStats({ ref: "E1", readyToClose: true, byStage: { done: 2 } }), epicStats({ ref: "E2", byStage: { backlog: 2 } })] });
    const key = out.slice(out.indexOf("data-stage-key"));
    expect(key).toContain("done");
    expect(key).toContain("backlog");
    expect(key).not.toContain('class="font-mono"');
    expect(out).not.toContain("bg-status-done-bg");
    expect(out.slice(out.indexOf('data-epic-row="E2"'))).toContain("no finishes yet");
  });
  it("no note column when nothing fills it", () => {
    const out = list({ epics: [epicStats({ ref: "E2", byStage: { done: 2 } })] });
    expect(out).not.toContain("data-eta");
  });
});

describe("EpicPage actions and pace", () => {
  const tickets = [epicTicket("n1", "needsYou"), epicTicket("b1", "backlog")];
  const detail = epicDetail({ ref: "E1" }, tickets);
  const needs = (out: string) => out.slice(out.indexOf('data-group="needsYou"'), out.indexOf('data-group="backlog"'));
  const failed = { profile: "dev", ref: "n1", status: "failed", failReason: "Tests failed", startedAt: null, step: "build" } as unknown as TicketRow;
  it("a failed ticket offers Re-run while the receiver is up, Open log while it is down", () => {
    const up = needs(page({ epic: detail }, [failed]));
    expect(up).toContain(">Re-run…</button>");
    expect(up).toContain('aria-label="Re-run n1 (build)…"');
    expect(up).toContain("data-epic-dismiss");
    expect(up).toContain("bg-accent/10");
    const down = needs(page({ epic: detail }, [failed], { up: false }));
    expect(down).toContain(">Open log</button>");
    expect(down).not.toContain("Re-run");
  });
  it("a Needs-you ticket that never ran here says so and links the tracker", () => {
    const withUrl = { ...detail, tickets: detail.tickets.map((t) => (t.ref === "n1" ? { ...t, url: "https://acme.atlassian.net/browse/n1" } : t)) };
    const out = needs(page({ epic: withUrl }));
    expect(out).toContain("it never ran here");
    expect(out).toContain('href="https://acme.atlassian.net/browse/n1"');
  });
  it("a dead row says why on the row itself; tracker links announce the new tab", () => {
    const out = page({ epic: detail });
    expect(out).toContain("never ran here, no link");
    const withUrl = { ...detail, tickets: detail.tickets.map((t) => (t.ref === "n1" ? { ...t, url: "https://acme.atlassian.net/browse/n1" } : t)) };
    const linked = page({ epic: withUrl });
    expect(linked).toContain("(new tab)");
  });
  it("a non-http ticket url (e.g. javascript:) is treated as no link", () => {
    const withBadUrl = { ...detail, tickets: detail.tickets.map((t) => (t.ref === "n1" ? { ...t, url: "javascript:alert(1)" } : t)) };
    const out = needs(page({ epic: withBadUrl }));
    expect(out).not.toContain("Open on the tracker");
    expect(out).not.toContain("javascript:");
  });
  it("pace counts tickets, and gives the real reason when there is no estimate", () => {
    const base = { byStage: { backlog: 2, running: 0, needsYou: 0, done: 0, untracked: 0 }, total: 2, completed: false, eta: null };
    const none = paceOf({ ...base, velocity: { days: velocityDays([]), finished14: 0, activeDays: 0, perDay: null } });
    expect(none.eta).toBe("2 left. No estimate until something finishes.");
    const one = paceOf({ ...base, velocity: { days: velocityDays([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), finished14: 1, activeDays: 1, perDay: 0.07 } });
    expect(one.text).toBe("1 ticket finished this week, the latest today.");
    expect(one.eta).toContain("(1 so far)");
    expect(one.stalled).toBe(false);
  });
});

describe("Epics round 3", () => {
  it("Awaiting merge only on evidence: a recorded, open PR with a reason; done without one is just done (CONTEXT.md)", () => {
    const tickets = [epicTicket("f1", "done"), epicTicket("f2", "done"), epicTicket("f3", "done"), epicTicket("m1", "done"), epicTicket("b1", "backlog")];
    const detail = epicDetail({ ref: "E1" }, tickets);
    const withPr = { ...row("f1"), status: "done", prUrl: "https://github.com/o/r/pull/42", prState: "ready", prNeeds: "openOnDone" } as TicketRow;
    const mergedPr = { ...row("f3"), prUrl: "https://github.com/o/r/pull/43", prState: "merged" } as TicketRow;
    const out = page({ epic: detail }, [withPr, mergedPr]);
    const at = (g: string) => out.indexOf(`data-group="${g}"`);
    expect(at("awaiting")).toBeGreaterThan(-1);
    expect(at("awaiting")).toBeLessThan(at("backlog"));
    const awaiting = out.slice(at("awaiting"), at("backlog"));
    expect(awaiting).toContain("Awaiting merge");
    expect(awaiting).toContain('href="https://github.com/o/r/pull/42"');
    expect(awaiting).toContain("PR #42");
    expect(awaiting).not.toContain('data-epic-ticket="f2"');
    expect(awaiting).not.toContain('data-epic-ticket="f3"');
    expect(out).not.toContain("no PR recorded");
    const history = out.slice(at("history"));
    expect(history).toContain(">Done<");
    for (const r of ["f2", "f3", "m1"]) expect(history).toContain(`data-epic-ticket="${r}"`);
    expect(out).toContain('aria-label="4 of 5 done: 3 done, 1 awaiting merge, 1 backlog"');
  });
  it("a PR with no reason (its history left the events tail) is not awaiting merge", () => {
    const stale = { ...row("f1"), status: "idle", prUrl: "https://github.com/o/r/pull/42", prState: "ready", prNeeds: null } as TicketRow;
    const out = page({ epic: epicDetail({ ref: "E1" }, [epicTicket("f1", "done")]) }, [stale]);
    expect(out).not.toContain('data-group="awaiting"');
  });
  it("no recorded PRs: no Awaiting merge section, nothing hollow, history titled Done", () => {
    const out = page({ epic: epicDetail({ ref: "E1" }, [epicTicket("f1", "done"), epicTicket("m1", "done")]) });
    expect(out).not.toContain('data-group="awaiting"');
    expect(out).not.toContain("ring-status-done");
    expect(out).toContain(">Done<");
  });
  it("heading counts are read aloud with their noun", () => {
    const out = page({ epic: epicDetail({ ref: "E1" }, [epicTicket("b1", "backlog"), epicTicket("b2", "backlog")]) });
    expect(out).toMatch(/Backlog<span[^>]*><span class="sr-only"> \(<\/span>2<span class="sr-only"> tickets\)<\/span>/);
  });
  it("a list row's link names the tracker status and points at its state (need, bar, note) for screen readers", () => {
    const out = list({ epics: [epicStats({ ref: "E1", status: "On track", needsYou: ["a"], byStage: { needsYou: 1, backlog: 1 } })] });
    const link = out.match(/<a data-epic-nav[^>]*>/)?.[0] ?? "";
    const ids = (link.match(/aria-describedby="([^"]+)"/)?.[1] ?? "").split(" ");
    expect(ids.length).toBe(3);
    expect(link).toBeTruthy();
    const linkHtml = out.slice(out.indexOf("<a data-epic-nav"), out.indexOf("</a>"));
    expect(linkHtml).toContain("tracker status </span>On track");
    for (const id of ids) expect(out).toContain(`id="${id}"`);
  });
  it("no open epics: a plain line and Closed open by default", () => {
    const out = list({ epics: [epicStats({ ref: "E0", completed: true, byStage: { done: 1 } })] });
    expect(out).toContain(">No open epics.<");
    expect(out).toMatch(/<details[^>]*data-epics-completed[^>]*\sopen/);
  });
});

describe("Epics round 4 list polish", () => {
  it("closed rows show their outcome; an empty one says no tickets", () => {
    const out = list({ epics: [epicStats({ ref: "E1", completed: true, byStage: { done: 4, backlog: 2 } }), epicStats({ ref: "E2", completed: true })] });
    expect(out).toMatch(/<span class="font-mono">4\/6<\/span> finished/);
    expect(out.slice(out.indexOf('data-epic-row="E2"'))).toContain(">no tickets<");
  });
  it("the tracker status sits muted with the name, not as a pill beside the bar", () => {
    const out = list({ epics: [epicStats({ ref: "E1", status: "Idea", byStage: { backlog: 1 } })] });
    expect(out).toContain("data-tracker-status");
    expect(out).not.toMatch(/rounded-full[^>]*>Idea</);
  });
});

describe("Epics PR #555 review fixes", () => {
  it("a page that turns unsupported on refetch renders the empty state (hooks run before the early return)", () => {
    expect(page({ supported: false, epic: null })).toContain("This tracker has no epics");
  });
  it("untracked tickets count as left, as the server's remaining does", () => {
    const e = epicStats({ ref: "E1", byStage: { done: 4, untracked: 2 } });
    expect(html(createElement(EpicStageBar, { epic: e }))).toContain(" · 2 left");
    expect(paceOf(e).eta).toContain("2 left.");
  });
  it("a stall wins over 'this week': the page says Stalled when the list would", () => {
    const e = epicStats({ ref: "E1", byStage: { backlog: 1, done: 1 }, velocity: { days: velocityDays([0, 0, 0, 0, 0, 0, 0, 0, 1]), finished14: 1, activeDays: 1, perDay: null } });
    const p = paceOf(e);
    expect(p.stalled).toBe(true);
    expect(p.text).toMatch(/^Stalled: nothing finished for 5 days\./);
  });
  it("Running names queued, interrupted and stalled tickets", () => {
    const detail = epicDetail({ ref: "E1" }, [epicTicket("r1", "running"), epicTicket("r2", "running")]);
    const out = page({ epic: detail }, [{ ...row("r1"), status: "running" } as TicketRow, { ...row("r2"), status: "stalled" } as TicketRow]);
    const r1 = out.slice(out.indexOf('data-epic-ticket="r1"'), out.indexOf('data-epic-ticket="r2"'));
    expect(r1).not.toContain("stalled");
    expect(out.slice(out.indexOf('data-epic-ticket="r2"'))).toContain("stalled");
  });
  it("a dismissed ticket leaves Needs you at once, during its Undo window", () => {
    const detail = epicDetail({ ref: "E1" }, [epicTicket("n1", "needsYou")]);
    const failed = { ...row("n1"), status: "failed", step: "build" } as TicketRow;
    expect(page({ epic: detail }, [failed])).toContain('data-group="needsYou"');
    expect(page({ epic: detail }, [failed], { dismissing: new Set(["dev\u0000n1"]) })).not.toContain('data-group="needsYou"');
  });
  it("Review PR refuses a non-http PR URL", () => {
    const detail = epicDetail({ ref: "E1" }, [epicTicket("n1", "needsYou")]);
    const bad = { ...row("n1"), status: "idle", prState: "ready", prNeeds: "awaitingMerge", prUrl: "javascript:alert(1)" } as TicketRow;
    expect(page({ epic: detail }, [bad])).not.toContain("javascript:");
  });
});

describe("Epics in Spanish", () => {
  let m: Mounted;
  afterEach(async () => {
    await m.unmount();
    setLangSetting("en", []);
  });
  const es = async (el: React.ReactElement) => {
    setLangSetting("es", []);
    m = await mount(createElement(I18nProvider, null, el));
    return m.root.innerHTML;
  };

  it("the list: closed fold, pills, counts, the stage bar and its key", async () => {
    const epics = [
      epicStats({ ref: "E1", name: "Checkout revamp", status: "On track", byStage: { done: 3, needsYou: 1, backlog: 3 }, needsYou: ["a"] }),
      epicStats({ ref: "E9", name: "Ready one", readyToClose: true, byStage: { done: 2 } }),
      epicStats({ ref: "E0", name: "Old epic", completed: true, byStage: { done: 3 } }),
    ];
    const out = await es(createElement(EpicsList, { body: { at: "t", live: false, supported: true, epics }, profile: "dev" }));
    for (const s of ["Cerradas", " épica)", "te necesita 1", "listo para cerrar", " · faltan 4", "3/3</span> terminados", "Solo tickets conocidos", "hechos", "estado en el tracker"]) expect(out).toContain(s);
    expect(out).toContain('aria-label="3 de 7 hechos: 3 hechos, 1 te necesita, 3 backlog"');
    expect(out).not.toContain("needs you");
  });

  it("an epic's page: sections, pace, actions", async () => {
    const tickets = [epicTicket("n1", "needsYou"), epicTicket("b1", "backlog"), epicTicket("m1", "done")];
    const failed = { profile: "dev", ref: "n1", status: "failed", failReason: null, startedAt: null, step: "build" } as unknown as TicketRow;
    const body = { at: "t", live: true, supported: true, epic: epicDetail({ ref: "E1", status: "At risk" }, tickets) };
    const out = await es(createElement(EpicPage, { body, profile: "dev", rows: [failed], onOpen: () => {}, actions: { up: true, onRetry: ok, onDismiss: () => {} } }));
    for (const s of ["Estado en el tracker: At risk", ">Te necesita<", ">Backlog<", ">Hechos<", " ticket)", "La ejecución falló sin un motivo.", ">Reejecutar…</button>", 'aria-label="Reejecutar n1 (build)…"', ">Descartar</button>", "Faltan 2. Sin estimación hasta que algo termine.", "nunca se ejecutó aquí, sin enlace"]) expect(out).toContain(s);
  });
});
