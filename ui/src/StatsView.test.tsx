import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StatsView, { Calendar, Diverging, Range, Stacked } from "./StatsView";
import { day } from "./statsFixtures";
import type { ProfileView } from "./contract";

const profile = { name: "dev", label: "dev", up: true, color: "teal", emoji: "🚀", forge: null } as unknown as ProfileView;
const days = [
  day("2026-10-12", { finished: 4, runs: 6, costUsd: 9, byStep: { code: { runs: 3, costUsd: 6 }, review: { runs: 3, costUsd: 3 } }, outcomes: { advance: 4, changes: 1, hold: 0, fail: 1, other: 0 }, ticketCost: { n: 4, p10: 1, p50: 2, p90: 5 } }),
  day("2026-10-13"),
  day("2026-10-14", { finished: 9, runs: 10, costUsd: 5, byStep: { code: { runs: 10, costUsd: 5 } }, outcomes: { advance: 9, changes: 1, hold: 0, fail: 0, other: 0 }, ticketCost: { n: 9, p10: 0.4, p50: 0.5, p90: 0.9 } }),
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
