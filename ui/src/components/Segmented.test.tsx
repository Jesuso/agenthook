// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Segmented } from "./Segmented";
import { mount } from "../domHarness";
import type { Mounted } from "../domHarness";

const options = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
  { value: "c", label: "C" },
];

function Harness() {
  const [v, setV] = useState("a");
  return createElement(Segmented, { label: "Pick", value: v, options, onChange: setV });
}

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
});

const radios = () => [...m!.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const key = (el: HTMLElement, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

describe("Segmented keyboard", () => {
  it("is one tab stop: only the checked option is tabbable", async () => {
    m = await mount(createElement(Harness));
    expect(m.root.querySelector('[role="radiogroup"]')!.getAttribute("aria-label")).toBe("Pick");
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it("arrow keys and Home/End move focus and selection, wrapping at the ends", async () => {
    m = await mount(createElement(Harness));
    await key(radios()[0], "ArrowRight");
    expect(radios()[1].getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios()[1]);
    await key(radios()[1], "End");
    expect(radios()[2].getAttribute("aria-checked")).toBe("true");
    await key(radios()[2], "ArrowRight");
    expect(radios()[0].getAttribute("aria-checked")).toBe("true");
    await key(radios()[0], "ArrowLeft");
    expect(radios()[2].getAttribute("aria-checked")).toBe("true");
    await key(radios()[2], "Home");
    expect(radios()[0].getAttribute("aria-checked")).toBe("true");
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });
});
