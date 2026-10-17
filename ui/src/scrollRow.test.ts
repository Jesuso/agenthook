import { describe, expect, it } from "vitest";
import { overflowEdges, revealScrollLeft } from "./scrollRow";

describe("overflowEdges", () => {
  it("no fade when everything fits", () => {
    expect(overflowEdges({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 })).toEqual({ start: false, end: false });
  });

  it("end fade at the start of an overflowing row, start fade at its end, both in between", () => {
    expect(overflowEdges({ scrollLeft: 0, scrollWidth: 640, clientWidth: 300 })).toEqual({ start: false, end: true });
    expect(overflowEdges({ scrollLeft: 340, scrollWidth: 640, clientWidth: 300 })).toEqual({ start: true, end: false });
    expect(overflowEdges({ scrollLeft: 100, scrollWidth: 640, clientWidth: 300 })).toEqual({ start: true, end: true });
  });

  it("ignores sub-pixel scroll positions", () => {
    expect(overflowEdges({ scrollLeft: 0.5, scrollWidth: 640, clientWidth: 300 }).start).toBe(false);
    expect(overflowEdges({ scrollLeft: 339.5, scrollWidth: 640, clientWidth: 300 }).end).toBe(false);
  });
});

describe("revealScrollLeft", () => {
  const row = { scrollLeft: 100, clientWidth: 300 };

  it("keeps the scroll when the item is already fully visible", () => {
    expect(revealScrollLeft(row, { start: 150, end: 250 })).toBe(100);
    expect(revealScrollLeft(row, { start: 150, end: 250 }, 32)).toBe(100);
  });

  it("scrolls left to an item hidden at the start, right to one hidden at the end, clear of the fade", () => {
    expect(revealScrollLeft(row, { start: 40, end: 120 }, 32)).toBe(8);
    expect(revealScrollLeft(row, { start: 380, end: 460 }, 32)).toBe(192);
  });

  it("never goes below 0", () => {
    expect(revealScrollLeft(row, { start: 10, end: 90 }, 32)).toBe(0);
  });
});
