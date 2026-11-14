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

  it("clicking an item inside the portaled list still fires onSelect, not a card navigation", async () => {
    m = await mount(createElement(Card));
    await click(m.root.querySelector("button")!);
    const remove = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Remove…")!;
    await click(remove);
    expect(items[1].onSelect).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
