import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EpicsView, { EpicsList } from "./EpicsView";
import { EpicPage } from "./EpicPage";
import { EpicStageBar } from "./EpicStageBar";
import { epicDetail, epicStats, epicTicket, velocityDays } from "./epicsFixtures";
import type { EpicResponse, EpicsResponse, ProfileView, TicketRow } from "./contract";

const profile = { name: "dev", label: "dev", up: true, color: "teal", emoji: "🚀", forge: null } as unknown as ProfileView;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const list = (over: Partial<EpicsResponse>) => html(createElement(EpicsList, { body: { at: "t", live: true, supported: true, epics: [], ...over }, profile: "dev" }));
const page = (over: Partial<EpicResponse>, rows: TicketRow[] = []) =>
  html(createElement(EpicPage, { body: { at: "t", live: true, supported: true, epic: null, ...over }, profile: "dev", rows, onOpen: () => {} }));
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
    epicStats({ ref: "E1", name: "Checkout revamp", status: "On track", byStage: { merged: 2, finished: 1, running: 1, needsYou: 2, backlog: 4 }, needsYou: ["a", "b"], eta: { days: 5, date: "2026-10-21" } }),
    epicStats({ ref: "E0", name: "Old epic", completed: true, byStage: { merged: 3 } }),
    epicStats({ ref: "E2", name: "Search", byStage: { backlog: 3 } }),
  ];

  it("one row per epic: link to its page, status, N/M, needs-you count, ETA", () => {
    const out = list({ epics });
    expect(out.match(/data-epic-row=/g)).toHaveLength(3);
    expect(out).toContain('href="#/p/dev/epics/E1"');
    expect(out).toContain("Checkout revamp");
    expect(out).toContain("On track");
    expect(out).toMatch(/data-progress="true">3(<!-- -->)?\/(<!-- -->)?10</);
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
    expect(closed).toMatch(/Closed<span[^>]*>1<\/span><\/summary>/);
    expect(out).not.toContain("opacity-");
    expect(out).not.toContain("Completed");
    expect(out).not.toMatch(/<details[^>]*data-epics-completed[^>]*\sopen/);
  });

  it("open epics sort needs you, then running, then ready to close; the chip takes the ETA slot", () => {
    const ready = epicStats({ ref: "E9", name: "Ready one", readyToClose: true, byStage: { finished: 2 } });
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
    epicTicket("f1", "finished", { status: "done" }),
    epicTicket("m1", "merged"),
    epicTicket("u1", "untracked", { name: "Orphan" }),
  ];
  const detail = epicDetail({ ref: "E1", name: "Checkout revamp", status: "At risk", url: "javascript:alert(1)", velocity: { days: velocityDays([0, 1, 0, 2]), finished14: 3, activeDays: 2, perDay: 0.25 } }, tickets);

  it("attention order: Needs you, running, backlog, not on the board, then finished and merged folded", () => {
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

  it("header and summary: name, status, safe link only, stage bar named in finished, plain-language pace", () => {
    const out = page({ epic: detail });
    expect(out).toMatch(/<h2[^>]*>Checkout revamp<\/h2>/);
    expect(out).toContain("Tracker status: At risk");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('aria-label="2 of 6 finished: 1 merged, 1 finished, 1 running, 1 needs you, 1 backlog, 1 untracked"');
    expect(out).not.toContain('data-chart="epic-velocity"');
    expect(out).toContain("Nothing finished for 10 days.");
    expect(out).toContain("3 left, no estimate until something finishes.");
    const linked = page({ epic: { ...detail, url: "https://app.asana.com/0/1/E1" } });
    expect(linked).toContain('href="https://app.asana.com/0/1/E1"');
  });

  it("every ticket goes somewhere: drawer when it ran here, the tracker when its URL derives from the epic's", () => {
    const out = page({ epic: detail }, [row("r1")]);
    expect(out).toMatch(/data-epic-ticket="r1"><button/);
    expect(out).toMatch(/data-epic-ticket="b1"><div/);
    const linked = page({ epic: { ...detail, url: "https://acme.atlassian.net/browse/E1" } }, [row("r1")]);
    expect(linked).toMatch(/data-epic-ticket="b1"><a[^>]*href="https:\/\/acme.atlassian.net\/browse\/b1"/);
  });

  it("a Needs-you ticket shows why and its one action", () => {
    const held = { ...row("n1"), status: "held", heldReason: "Which database should it use?", heldAt: null, startedAt: null, step: "plan" } as TicketRow;
    const out = page({ epic: detail }, [held]);
    const needs = out.slice(out.indexOf('data-group="needsYou"'), out.indexOf('data-group="running"'));
    expect(needs).toContain("Which database should it use?");
    expect(needs).toContain(">Details</button>");
  });

  it("closed epics read as closed: pace says so, an empty one says Closed with no tickets", () => {
    const closed = epicDetail({ ref: "E7", completed: true }, [epicTicket("m1", "merged")]);
    expect(page({ epic: closed })).toContain("Closed with 1 of 1 finished.");
    expect(page({ epic: epicDetail({ ref: "E8", completed: true }, []) })).toContain("Closed with no tickets.");
  });

  it("readyToClose shows a banner saying finished, linking the tracker when safe", () => {
    const ready = epicDetail({ ref: "E3", readyToClose: true, url: "https://app.asana.com/0/1/E3" }, [epicTicket("f1", "finished")]);
    const out = page({ epic: ready });
    expect(out).toContain("data-ready-to-close");
    expect(out).toContain("All tickets finished");
    expect(out).not.toContain("shipped");
    expect(out).toContain('href="https://app.asana.com/0/1/E3"');

    const unsafe = epicDetail({ ref: "E4", readyToClose: true, url: "javascript:alert(1)" }, [epicTicket("f1", "finished")]);
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

describe("EpicStageBar running animation", () => {
  const bar = (byStage: Record<string, number>, total: number) => html(createElement(EpicStageBar, { epic: { byStage, total } as never }));
  it("marks only the running segment so it slides (epic-seg-running)", () => {
    const out = bar({ merged: 1, finished: 0, running: 2, needsYou: 0, backlog: 1, untracked: 0 }, 4);
    const seg = (b: string) => out.match(new RegExp(`<span[^>]*data-seg="${b}"[^>]*>`))?.[0] ?? "";
    expect(seg("running")).toContain("epic-seg-running");
    expect(seg("merged")).not.toContain("epic-seg-running");
    expect(seg("backlog")).not.toContain("epic-seg-running");
  });
  it("has no animated segment when nothing is running", () => {
    expect(bar({ merged: 2, finished: 0, running: 0, needsYou: 0, backlog: 2, untracked: 0 }, 4)).not.toContain("epic-seg-running");
  });
  it("renders an all-done epic as a fully filled bar with a divider between merged and finished", () => {
    const out = bar({ merged: 2, finished: 2, running: 0, needsYou: 0, backlog: 0, untracked: 0 }, 4);
    const seg = (b: string) => out.match(new RegExp(`<span[^>]*data-seg="${b}"[^>]*>`))?.[0] ?? "";
    expect(seg("merged")).toContain("bg-status-done");
    expect(seg("merged")).not.toContain("/55");
    expect(seg("finished")).toContain("bg-status-done");
    expect(seg("finished")).not.toContain("/55");
    expect(seg("finished")).toContain("border-l border-surface");
    const pct = (s: string) => Number(s.match(/width:\s*([\d.]+)%/)?.[1] ?? 0);
    expect(pct(seg("merged")) + pct(seg("finished"))).toBe(100);
  });
});
