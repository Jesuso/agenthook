// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StatsView, { Calendar, Diverging, Range, Stacked } from "./StatsView";
import { harnessesVisible } from "./HarnessesCard";
import { day } from "./statsFixtures";
import type { ProfileView, StatsGroup } from "./contract";
import { I18nProvider } from "./i18n/react";
import { setLangSetting, translate } from "./i18n";
import { mount, until } from "./domHarness";
import type { Mounted } from "./domHarness";

const profile = { name: "dev", label: "dev", up: true, color: "teal", emoji: "🚀", forge: null, recentCosts: [], recentRuns: [] } as unknown as ProfileView;
const todayAt = () => new Date(Date.now() - 60e3).toISOString();
const yesterdayAt = () => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(12, 0, 0, 0); return d.toISOString(); };
const runs = (n: number) => Array.from({ length: n }, (_, i) => ({ at: todayAt(), outcome: i < 2 ? "changes" : "advance" }));
const statsPage = (over: Partial<ProfileView> = {}) => html(createElement(StatsView, { profile: { ...profile, ...over } as unknown as ProfileView, feed: [] }));
const days = [
  day("2026-10-12", { finished: 4, runs: 6, costUsd: 9, estUsd: 0, byStep: { code: { runs: 3, costUsd: 6, estUsd: 0 }, review: { runs: 3, costUsd: 3, estUsd: 0 } }, outcomes: { advance: 4, changes: 1, hold: 0, fail: 1, other: 0 }, ticketCost: { n: 4, p10: 1, p50: 2, p90: 5 } }),
  day("2026-10-13"),
  day("2026-10-14", { finished: 9, runs: 10, costUsd: 5, estUsd: 0, byStep: { code: { runs: 10, costUsd: 5, estUsd: 0 } }, outcomes: { advance: 9, changes: 1, hold: 0, fail: 0, other: 0 }, ticketCost: { n: 9, p10: 0.4, p50: 0.5, p90: 0.9 } }),
];
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const group = (over: Partial<StatsGroup> = {}): StatsGroup => ({
  key: "(none)", runs: 1, outcomes: { advance: 1, changes: 0, hold: 0, fail: 0, timeout: 0, requeued: 0, unknown: 0 },
  successRate: 1, wallP50Ms: 1000, wallP90Ms: 1000, turns: null, firstContext: null, peakContext: null, compactions: null,
  input: 0, output: 0, cacheRead: 0, outPerMin: null, costUsd: 0, estUsd: 0, unpriced: 0, ...over,
});

describe("StatsView", () => {
  it("renders its frame and range control before any data arrives (fetch runs in an effect)", () => {
    const out = html(createElement(StatsView, { profile, feed: [] }));
    expect(out).toContain("data-stats-view");
    expect(out).toContain("Stats");
    for (const r of ["14d", "30d", "90d"]) expect(out).toContain(r);
  });
});

describe("the Today card (moved from the Overview's Progress zone, #786)", () => {
  it("shows cost today, with a muted 'yesterday {spend}' when yesterday is non-zero", () => {
    const out = statsPage({ recentCosts: [{ at: todayAt(), costUsd: 4, estUsd: 0 }, { at: yesterdayAt(), costUsd: 1, estUsd: 0 }] });
    expect(out).toContain("data-stats-today");
    expect(out).toContain("cost today (approx.)");
    expect(out).toContain("$4.00");
    expect(out).toContain("yesterday $1.00");
  });
  it("shows no 'yesterday' line when yesterday's spend is zero", () => {
    const out = statsPage({ recentCosts: [{ at: todayAt(), costUsd: 4, estUsd: 0 }] });
    expect(out).toContain("$4.00");
    expect(out).not.toContain("yesterday");
  });
  it("shows the 48 h rework rate with its title, once the window has enough runs", () => {
    const out = statsPage({ recentRuns: runs(10) });
    expect(out).toContain("rework \u00b7 48 h");
    expect(out).toContain("share of agent runs that ended in a rework loop (changes)");
    expect(out).toContain("20%");
  });
  it("hides the rework rate until there are enough runs, and says how many are needed", () => {
    const out = statsPage({ recentRuns: runs(9) });
    expect(out).toContain("needs 10+ runs (9 so far)");
    expect(out).not.toContain("20%");
  });
  it("renders the History strip (StatsStrip) on the page, once", () => {
    const out = statsPage();
    expect(out.match(/data-stats="/g)).toHaveLength(1);
    expect(out).toContain("data-stats-today");
  });
});

describe("the four charts", () => {
  it("spend by step: a rect per step per day with spend, a legend ranked by spend", () => {
    const out = html(createElement(Stacked, { days }));
    expect(out).toContain('data-chart="spend-by-step"');
    expect(out.match(/<rect /g)).toHaveLength(3); // Mon code+review, Wed code; the zero day draws nothing
    expect(out.indexOf("code $")).toBeLessThan(out.indexOf("review $"));
  });

  it("spend by step: an estimate is a dashed, separate rect and the legend says ~est.; runs with no estimate are counted", () => {
    const out = html(createElement(Stacked, { days: [day("2026-10-12", { runs: 3, estUsd: 2, unestimatedRuns: 1, byStep: { code: { runs: 3, costUsd: 1, estUsd: 2 } } })] }));
    expect(out.match(/<rect /g)).toHaveLength(2);
    expect(out.match(/data-est=/g)).toHaveLength(1);
    expect(out).toContain("stroke-dasharray");
    expect(out).toContain("code $1.00 + ~$2.00 est.");
    expect(out).toContain("1 run with no estimate");
  });

  it("outcomes: one rect per outcome present, a legend for all four", () => {
    const out = html(createElement(Diverging, { days }));
    expect(out).toContain('data-chart="outcomes"');
    expect(out.match(/<rect /g)).toHaveLength(5); // Mon: advance, changes, fail; Wed: advance, changes
    for (const l of ["advanced", "sent back (changes)", "held", "failed"]) expect(out).toContain(l);
  });

  it("calendar: a cell per day, shaded ones only where tickets finished", () => {
    const out = html(createElement(Calendar, { days }));
    expect(out).toContain('data-chart="calendar"');
    expect(out.match(/data-cell="/g)).toHaveLength(2);
    expect(out).toContain('data-cell="2026-10-14"');
  });

  it("ticket cost: a median dot per costed day and a spread bar, nothing for a day with none", () => {
    const out = html(createElement(Range, { days }));
    expect(out).toContain('data-chart="ticket-cost"');
    expect(out.match(/data-median="/g)).toHaveLength(2);
    expect(out).toContain("10th–90th percentile");
  });

  it("every chart survives no data at all", () => {
    for (const C of [Stacked, Diverging, Calendar, Range]) expect(() => html(createElement(C, { days: [] }))).not.toThrow();
    for (const C of [Stacked, Diverging, Range]) expect(() => html(createElement(C, { days: [day("2026-10-12")] }))).not.toThrow();
  });
});

describe("the Harnesses card (moved from Overview, #754; the table is #646)", () => {
  let m: Mounted;
  afterEach(async () => {
    await m.unmount();
    vi.unstubAllGlobals();
  });

  // HarnessesCard fetches /api/harness-stats in its own effect, so route by URL against the
  // stats stub: the card's visibility is decided from its own 7-day result, not /api/stats.
  const fetchStub = (harnessGroups: StatsGroup[]) =>
    vi.fn(async (url: string) =>
      String(url).includes("harness-stats")
        ? { ok: true, json: async () => ({ groups: harnessGroups }) }
        : { ok: true, json: async () => ({ days, since: "2026-10-12T08:00:00Z" }) },
    );

  it("shows the table with a Harnesses heading when the profile configures named harnesses (#646)", async () => {
    vi.stubGlobal("fetch", fetchStub([group({ key: "qwen", runs: 4, costUsd: 2.5 })]));
    m = await mount(createElement(I18nProvider, null, createElement(StatsView, { profile: { ...profile, harnesses: { qwen: { active: 1, max: 2 } } } as ProfileView, feed: [] })));
    await until(() => m.root.querySelector("[data-harnesses-table]")?.innerHTML.includes("qwen") ?? false);
    const card = m.root.querySelector("[data-harnesses-card]")!;
    expect(card.querySelector("h2")!.textContent).toContain("Harnesses");
    expect(card.innerHTML).toContain("qwen");
    expect(card.innerHTML).toContain("Last 7 days");
  });

  it("shows no card at all with no harnesses configured and only a (none) group (#646)", async () => {
    vi.stubGlobal("fetch", fetchStub([group()]));
    m = await mount(createElement(I18nProvider, null, createElement(StatsView, { profile, feed: [] })));
    await until(() => m.root.querySelector('[data-chart="outcomes"]'));
    await new Promise((r) => setTimeout(r, 0)); // let the harness fetch resolve too
    expect(m.root.querySelector("[data-harnesses-card]")).toBeNull();
    expect(m.root.querySelector("[data-harnesses-table]")).toBeNull();
  });

  it("shows a Slots column: live active/max per configured harness (∞ when uncapped), incl. one with no 7-day runs (#788)", async () => {
    vi.stubGlobal("fetch", fetchStub([group({ key: "qwen", runs: 4, costUsd: 2.5 }), group({ key: "opus", runs: 1, costUsd: 0.5 }), group()]));
    m = await mount(createElement(I18nProvider, null, createElement(StatsView, { profile: { ...profile, harnesses: { qwen: { active: 1, max: 2 }, opus: { active: 0, max: null }, fresh: { active: 2, max: 3 } } } as ProfileView, feed: [] })));
    await until(() => (m.root.querySelector("[data-harnesses-table]")?.innerHTML ?? "").includes("fresh"));
    const html = m.root.querySelector("[data-harnesses-table]")!.innerHTML;
    expect(html).toContain(">Slots</th>");
    const row = (key: string) => html.slice(html.indexOf(`>${key}</td>`), html.indexOf("</tr>", html.indexOf(`>${key}</td>`)));
    // the live slot is its own cell — assert on it, not on any — in the row (out/min reads — too)
    const slotCell = (key: string) => {
      const rowHtml = row(key);
      const i = rowHtml.indexOf("data-harness-slots-cell");
      expect(i).toBeGreaterThan(-1);
      return rowHtml.slice(i, rowHtml.indexOf("</td>", i));
    };
    expect(slotCell("qwen")).toContain(">1/2");
    expect(row("qwen")).toContain('title="harness qwen: 1 of 2 slots in use"');
    expect(slotCell("opus")).toContain(">0/∞");
    // configured, but no 7-day group yet: its own row, runs 0, other metrics —, slots still live
    expect(slotCell("fresh")).toContain(">2/3");
    expect(row("fresh")).toMatch(">0</td>");
    expect(row("fresh")).toContain(">—</td>");
    // a (none) group has no configured harness behind it: no live slots
    expect(slotCell("(none)")).toContain(">—");
  });

  it("slots read — when the receiver is down (#788)", async () => {
    vi.stubGlobal("fetch", fetchStub([group({ key: "qwen", runs: 2, costUsd: 1 })]));
    m = await mount(createElement(I18nProvider, null, createElement(StatsView, { profile: { ...profile, up: false, harnesses: { qwen: { active: 1, max: 2 } } } as ProfileView, feed: [] })));
    await until(() => /data-harness-slots-cell[^>]*>—<\/td>/.test(m.root.querySelector("[data-harnesses-table]")?.innerHTML ?? ""));
    const html = m.root.querySelector("[data-harnesses-table]")!.innerHTML;
    // the slot cell itself reads — (the row's out/min cell reads — too), and no live 1/2 anywhere
    expect(html).toMatch(/data-harness-slots-cell[^>]*>—<\/td>/);
    expect(html).not.toContain("1/2");
  });

  it("harnessesVisible: shown when harnesses are configured, or a named group exists even without config (#646)", () => {
    expect(harnessesVisible(true, [])).toBe(true);
    expect(harnessesVisible(false, [])).toBe(false);
    expect(harnessesVisible(false, [group({ key: "(none)" })])).toBe(false);
    expect(harnessesVisible(false, [group({ key: "qwen" })])).toBe(true);
  });
});

describe("StatsView in Spanish", () => {
  let m: Mounted;
  afterEach(async () => {
    await m.unmount();
    vi.unstubAllGlobals();
    setLangSetting("en", []);
  });

  it("titles, legends, labels and day letters follow the language", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ days, since: "2026-10-12T08:00:00Z" }) })));
    setLangSetting("es", []);
    m = await mount(createElement(I18nProvider, null, createElement(StatsView, { profile, feed: [] })));
    await until(() => m.root.querySelector('[data-chart="outcomes"]'));
    const out = m.root.innerHTML;
    expect(m.root.querySelector("h1")!.textContent).toBe("Estadísticas · dev");
    for (const s of ["30 d", "Gasto por paso", "Cómo terminaron las ejecuciones", "avanzadas", "devueltas (changes)", "percentil 10–90", "Historial desde 12 oct. Los días se cortan a tu medianoche local."]) expect(out).toContain(s);
    expect(out).toContain('aria-label="Tickets terminados por día, como calendario"');
    expect(out).toContain(">L</text>"); // Monday 2026-10-12 under the band charts
    expect(out).toContain("color más intenso = más tickets"); // #775
  });
});

describe("the calendar caption (#775)", () => {
  let m: Mounted;
  afterEach(async () => {
    await m.unmount();
    vi.unstubAllGlobals();
    setLangSetting("en", []);
  });

  it("says stronger colour = more tickets in English, in both plural forms", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ days, since: "2026-10-12T08:00:00Z" }) })));
    m = await mount(createElement(I18nProvider, null, createElement(StatsView, { profile, feed: [] })));
    await until(() => m.root.querySelector('[data-chart="outcomes"]'));
    expect(m.root.innerHTML).toContain("stronger colour = more tickets");
    expect(translate("en", "statsView.calendarNote", { count: 1 })).toBe("last 1 week · stronger colour = more tickets");
    expect(translate("en", "statsView.calendarNote", { count: 5 })).toBe("last 5 weeks · stronger colour = more tickets");
  });
});

describe("the tab title (#757)", () => {
  let m: Mounted;
  afterEach(async () => {
    await m.unmount();
    vi.unstubAllGlobals();
  });

  it("Stats · <profile> · agenthook while mounted, agenthook after unmount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("harness-stats") ? { ok: true, json: async () => ({ groups: [] }) } : { ok: true, json: async () => ({ days: [], since: "2026-10-12T08:00:00Z" }) },
      ),
    );
    m = await mount(createElement(I18nProvider, null, createElement(StatsView, { profile, feed: [] })));
    expect(document.title).toBe("Stats · dev · agenthook");
    await m.unmount();
    expect(document.title).toBe("agenthook");
  });
});
