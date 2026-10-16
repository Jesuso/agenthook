import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EpicsView, { EpicsList } from "./EpicsView";
import { EpicPage } from "./EpicPage";
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

  it("completed epics sit last, dimmed, collapsed under Completed (k)", () => {
    const out = list({ epics });
    const details = out.indexOf("data-epics-completed");
    expect(details).toBeGreaterThan(out.indexOf('data-epic-row="E2"'));
    expect(out.indexOf('data-epic-row="E0"')).toBeGreaterThan(details);
    expect(out).toMatch(/<details class="[^"]*" data-epics-completed="true"><summary[^>]*>Completed \((<!-- -->)?1(<!-- -->)?\)<\/summary><ul class="opacity-60">/);
    expect(out).not.toMatch(/<details[^>]*data-epics-completed[^>]*\sopen/);
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

  it("Needs you comes first, then the buckets in order, then the untracked note", () => {
    const out = page({ epic: detail });
    const at = (g: string) => out.indexOf(`data-group="${g}"`);
    expect(at("needsYou")).toBeGreaterThan(-1);
    expect(at("needsYou")).toBeLessThan(out.indexOf("data-velocity"));
    expect(at("needsYou")).toBeLessThan(at("running"));
    expect(at("running")).toBeLessThan(at("backlog"));
    expect(at("backlog")).toBeLessThan(at("finished"));
    expect(at("finished")).toBeLessThan(at("merged"));
    expect(at("merged")).toBeLessThan(at("untracked"));
    expect(out).toContain("Untracked / not on board");
    expect(out.slice(at("untracked"))).toContain("Orphan");
  });

  it("header: name, status, no link for a non-http url; sparkline + per-day numbers", () => {
    const out = page({ epic: detail });
    expect(out).toContain("Checkout revamp");
    expect(out).toContain("At risk");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('data-chart="epic-velocity"');
    expect(out.match(/data-point=/g)).toHaveLength(2);
    expect(out).toContain("0.3/day");
    const linked = page({ epic: { ...detail, url: "https://app.asana.com/0/1/E1" } });
    expect(linked).toContain('href="https://app.asana.com/0/1/E1"');
  });

  it("a ticket with a local row is a button (opens the drawer); one without is plain", () => {
    const out = page({ epic: detail }, [row("n1")]);
    expect(out).toMatch(/data-epic-ticket="n1"><button/);
    expect(out).toMatch(/data-epic-ticket="b1"><div/);
  });

  it("no Needs you section when nothing needs you; live:false note; supported:false empty state", () => {
    const calm = epicDetail({ ref: "E2" }, [epicTicket("b1", "backlog")]);
    expect(page({ epic: calm })).not.toContain('data-group="needsYou"');
    expect(page({ epic: calm, live: false })).toContain("data-live-note");
    expect(page({ supported: false })).toContain("This tracker has no epics");
  });
});
