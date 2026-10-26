// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StatsView, { Calendar, Diverging, Range, Stacked } from "./StatsView";
import { day } from "./statsFixtures";
import type { ProfileView } from "./contract";
import { I18nProvider } from "./i18n/react";
import { setLangSetting } from "./i18n";
import { mount, until } from "./domHarness";
import type { Mounted } from "./domHarness";

const profile = { name: "dev", label: "dev", up: true, color: "teal", emoji: "🚀", forge: null } as unknown as ProfileView;
const days = [
  day("2026-10-12", { finished: 4, runs: 6, costUsd: 9, estUsd: 0, byStep: { code: { runs: 3, costUsd: 6, estUsd: 0 }, review: { runs: 3, costUsd: 3, estUsd: 0 } }, outcomes: { advance: 4, changes: 1, hold: 0, fail: 1, other: 0 }, ticketCost: { n: 4, p10: 1, p50: 2, p90: 5 } }),
  day("2026-10-13"),
  day("2026-10-14", { finished: 9, runs: 10, costUsd: 5, estUsd: 0, byStep: { code: { runs: 10, costUsd: 5, estUsd: 0 } }, outcomes: { advance: 9, changes: 1, hold: 0, fail: 0, other: 0 }, ticketCost: { n: 9, p10: 0.4, p50: 0.5, p90: 0.9 } }),
];
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("StatsView", () => {
  it("renders its frame and range control before any data arrives (fetch runs in an effect)", () => {
    const out = html(createElement(StatsView, { profile, feed: [] }));
    expect(out).toContain("data-stats-view");
    expect(out).toContain("Stats");
    for (const r of ["14d", "30d", "90d"]) expect(out).toContain(r);
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
  });
});
