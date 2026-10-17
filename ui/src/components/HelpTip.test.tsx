// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { HelpTip } from "./HelpTip";
import { click, mount } from "../domHarness";
import type { Mounted } from "../domHarness";

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
});

const fire = (target: Element, ev: Event) => act(async () => void target.dispatchEvent(ev));
const parts = (root: HTMLElement) => ({ button: root.querySelector("button")!, tip: root.querySelector<HTMLElement>('[role="tooltip"]')! });
const isOpen = (root: HTMLElement) => {
  const { button, tip } = parts(root);
  expect(button.getAttribute("aria-expanded")).toBe(String(!tip.hidden));
  return !tip.hidden;
};

describe("HelpTip", () => {
  it("is an accessible button whose aria-describedby resolves to the always-present bubble", async () => {
    m = await mount(<HelpTip label="Max attempts" help="Runs allowed per task." />);
    const { button, tip } = parts(m.root);
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Help: Max attempts");
    expect(button.textContent).toBe("?");
    expect(tip.textContent).toBe("Runs allowed per task.");
    expect(tip.id).not.toBe("");
    expect(button.getAttribute("aria-describedby")).toBe(tip.id);
    expect(document.getElementById(tip.id)).toBe(tip);
    expect(isOpen(m.root)).toBe(false);
  });

  it("uses a caller-supplied id, so a field control can share the description", async () => {
    m = await mount(<HelpTip id="tip-x" label="L" help="H" />);
    expect(parts(m.root).tip.id).toBe("tip-x");
    expect(parts(m.root).button.getAttribute("aria-describedby")).toBe("tip-x");
  });

  it("opens on mouse enter and closes on mouse leave", async () => {
    m = await mount(<HelpTip label="L" help="H" />);
    const { button } = parts(m.root);
    await fire(button, new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    expect(isOpen(m.root)).toBe(true);
    await fire(button, new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    expect(isOpen(m.root)).toBe(false);
  });

  it("opens on keyboard focus, closes on Escape keeping focus on the button, and on blur", async () => {
    m = await mount(<HelpTip label="L" help="H" />);
    const { button } = parts(m.root);
    await act(async () => button.focus());
    expect(document.activeElement).toBe(button);
    expect(isOpen(m.root)).toBe(true);
    await fire(button, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isOpen(m.root)).toBe(false);
    expect(document.activeElement).toBe(button);
    await fire(button, new FocusEvent("focusin", { bubbles: true }));
    expect(isOpen(m.root)).toBe(true);
    await act(async () => button.blur());
    expect(isOpen(m.root)).toBe(false);
  });

  it("a tap toggles it, and a tap-opened bubble survives mouse leave", async () => {
    m = await mount(<HelpTip label="L" help="H" />);
    const { button } = parts(m.root);
    await click(button);
    expect(isOpen(m.root)).toBe(true);
    await fire(button, new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    expect(isOpen(m.root)).toBe(true);
    await click(button);
    expect(isOpen(m.root)).toBe(false);
  });

  it("caps the bubble's width to the viewport so it wraps on a phone", async () => {
    m = await mount(<HelpTip label="L" help="H" />);
    expect(parts(m.root).tip.className).toContain("max-w-[min(18rem,calc(100vw-2rem))]");
  });
});
