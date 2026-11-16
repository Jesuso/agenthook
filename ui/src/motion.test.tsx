// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount } from "./domHarness";
import type { Mounted } from "./domHarness";
import { forgetColumns, slideFrom, useArrivals, useSlide } from "./motion";

// #699: every board animation answers one event, once; none on first paint, none in a hidden tab.

let m: Mounted | null = null;
let hidden = false;
let reduce = false;

beforeEach(() => {
  hidden = false;
  reduce = false;
  forgetColumns();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
});

afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.unstubAllGlobals();
});

describe("slideFrom", () => {
  it("no slide the first time a ticket is seen, then the columns it crossed", () => {
    expect(slideFrom("p:1", 0)).toBe(0);
    expect(slideFrom("p:1", 0)).toBe(0);
    expect(slideFrom("p:1", 2)).toBe(-2);
    // Sent back for rework: it slides the other way.
    expect(slideFrom("p:1", 1)).toBe(1);
  });

  it("a ticket with no column keeps its last one", () => {
    slideFrom("p:2", 1);
    expect(slideFrom("p:2", -1)).toBe(0);
    expect(slideFrom("p:2", 3)).toBe(-2);
  });
});

function Mark({ at }: { at: number }) {
  const ref = useSlide("p:9", at);
  return createElement("span", { style: { width: "100px" } }, createElement("span", { ref, "data-mark": "" }));
}

describe("useSlide", () => {
  const prepare = () => {
    const animate = vi.fn();
    (HTMLElement.prototype as any).animate = animate;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 100 });
    return animate;
  };

  it("slides the mark from the column it left, once per crossing", async () => {
    const animate = prepare();
    m = await mount(createElement(Mark, { at: 0 }));
    expect(animate).not.toHaveBeenCalled();
    await m.rerender(createElement(Mark, { at: 2 }));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][0][0]).toEqual({ transform: "translateX(-200px)" });
    await m.rerender(createElement(Mark, { at: 2 }));
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("stays still under reduced motion and in a hidden tab", async () => {
    const animate = prepare();
    reduce = true;
    m = await mount(createElement(Mark, { at: 0 }));
    await m.rerender(createElement(Mark, { at: 1 }));
    reduce = false;
    hidden = true;
    await m.rerender(createElement(Mark, { at: 2 }));
    expect(animate).not.toHaveBeenCalled();
  });
});

function Rows({ keys, mode }: { keys: string[]; mode: "skip" | "defer" }) {
  const fresh = useArrivals(keys, 1000, mode);
  return createElement("p", null, [...fresh].join(","));
}

describe("useArrivals", () => {
  it("nothing arrives on the first paint; a later key does, a known one doesn't", async () => {
    m = await mount(createElement(Rows, { keys: ["a", "b"], mode: "skip" }));
    expect(m.root.textContent).toBe("");
    await m.rerender(createElement(Rows, { keys: ["a", "b", "c"], mode: "skip" }));
    expect(m.root.textContent).toBe("c");
  });

  it("hidden tab: skip forgets the arrival, defer plays it when the tab is looked at again", async () => {
    hidden = true;
    m = await mount(createElement(Rows, { keys: [], mode: "skip" }));
    await m.rerender(createElement(Rows, { keys: ["a"], mode: "skip" }));
    hidden = false;
    await m.rerender(createElement(Rows, { keys: ["a"], mode: "skip" }));
    expect(m.root.textContent).toBe("");
    await m.unmount();

    hidden = true;
    m = await mount(createElement(Rows, { keys: [], mode: "defer" }));
    await m.rerender(createElement(Rows, { keys: ["a"], mode: "defer" }));
    expect(m.root.textContent).toBe("");
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(m.root.textContent).toBe("a");
  });
});
