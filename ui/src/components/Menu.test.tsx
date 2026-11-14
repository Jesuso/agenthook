// @vitest-environment happy-dom
import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu } from "./Menu";
import { click, mount } from "../domHarness";
import type { Mounted } from "../domHarness";

const mousedown = (target: EventTarget) => act(async () => target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));

// A card's ⋯ menu must float free of the card's `overflow-hidden` (#661): it portals to
// `document.body` rather than nesting inside the card's DOM subtree.

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.clearAllMocks();
});

const items = [
  { label: "Restart", onSelect: vi.fn() },
  { label: "Remove…", onSelect: vi.fn(), danger: true },
];

function Card() {
  return createElement(
    "article",
    { "data-profile-card": "demo", className: "relative overflow-hidden" },
    createElement(Menu, { label: "profile actions", items }),
  );
}

describe("Menu", () => {
  it("portals the open list outside the card, not as its descendant", async () => {
    m = await mount(createElement(Card));
    await click(m.root.querySelector("button")!);
    const list = document.querySelector('[role="menu"]')!;
    expect(list).not.toBeNull();
    expect(m.root.querySelector('[data-profile-card]')!.contains(list)).toBe(false);
    expect(list.parentElement).toBe(document.body);
  });

  it("an outside mousedown closes the menu", async () => {
    m = await mount(createElement(Card));
    await click(m.root.querySelector("button")!);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await mousedown(document.body);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("Escape closes the menu and returns focus to the trigger", async () => {
    m = await mount(createElement(Card));
    const trigger = m.root.querySelector<HTMLButtonElement>("button")!;
    await click(trigger);
    const list = document.querySelector('[role="menu"]')!;
    await act(async () => list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("a mousedown on a portaled item does not close the menu, and the following click still fires onSelect", async () => {
    m = await mount(createElement(Card));
    await click(m.root.querySelector("button")!);
    const remove = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Remove…")!;
    await mousedown(remove);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await click(remove);
    expect(items[1].onSelect).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("clicking an item inside the portaled list still fires onSelect, not a card navigation", async () => {
    m = await mount(createElement(Card));
    await click(m.root.querySelector("button")!);
    const remove = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Remove…")!;
    await click(remove);
    expect(items[1].onSelect).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("a scroll or resize while open does not move focus back to the first item", async () => {
    m = await mount(createElement(Card));
    await click(m.root.querySelector("button")!);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    await act(async () => buttons[1].focus());
    expect(document.activeElement).toBe(buttons[1]);

    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(document.activeElement).toBe(buttons[1]);

    await act(async () => window.dispatchEvent(new Event("scroll")));
    expect(document.activeElement).toBe(buttons[1]);
  });

  it("opens upward when there isn't room below the trigger", async () => {
    m = await mount(createElement(Card));
    const trigger = m.root.querySelector<HTMLButtonElement>("button")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ top: 580, bottom: 600, left: 100, right: 140, width: 40, height: 20, x: 100, y: 580, toJSON: () => {} } as DOMRect);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    await click(trigger);
    const list = document.querySelector<HTMLElement>('[role="menu"]')!;
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 80, left: 0, right: 144, width: 144, height: 80, x: 0, y: 0, toJSON: () => {} } as DOMRect);
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(parseFloat(list.style.top)).toBeCloseTo(580 - 80 - 4);
  });

  it("shifts left to stay inside a narrow viewport instead of overflowing the right edge", async () => {
    m = await mount(createElement(Card));
    const trigger = m.root.querySelector<HTMLButtonElement>("button")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ top: 20, bottom: 40, left: 350, right: 390, width: 40, height: 20, x: 350, y: 20, toJSON: () => {} } as DOMRect);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    await click(trigger);
    const list = document.querySelector<HTMLElement>('[role="menu"]')!;
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 80, left: 0, right: 144, width: 144, height: 80, x: 0, y: 0, toJSON: () => {} } as DOMRect);
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(parseFloat(list.style.left)).toBeCloseTo(360 - 144 - 4);
  });
});
