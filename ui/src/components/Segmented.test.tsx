// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Segmented } from "./Segmented";
import { click, mount } from "../domHarness";
import type { Mounted } from "../domHarness";

const OPTIONS: { value: string; label: string }[] = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
  { value: "c", label: "C" },
];

type Radio = HTMLButtonElement;

const radios = (m: Mounted) => [...m.root.querySelectorAll<Radio>("[role=radio]")];

/** Focus `target` and dispatch a bubbling keydown on it (both inside `act`). */
async function press(target: Radio, key: string): Promise<void> {
  await act(async () => {
    target.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("Segmented keyboard (#765)", () => {
  let m: Mounted | null = null;
  const onChange = vi.fn();
  afterEach(async () => {
    await m?.unmount();
    m = null;
    onChange.mockReset();
  });

  it("roving tabindex: the selected option is the one tabIndex=0 Tab stop", async () => {
    m = await mount(<Segmented value="b" options={OPTIONS} onChange={onChange} label="pick" />);
    const list = radios(m);
    expect(list.map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
    expect(list[1].getAttribute("aria-checked")).toBe("true");
  });

  it("a value that matches no option leaves the first option as the Tab stop", async () => {
    m = await mount(<Segmented value="zzz" options={OPTIONS} onChange={onChange} />);
    const list = radios(m);
    expect(list.map((b) => b.tabIndex)).toEqual([0, -1, -1]);
  });

  it("ArrowRight on the last option wraps to the first; ArrowDown behaves the same", async () => {
    for (const key of ["ArrowRight", "ArrowDown"]) {
      onChange.mockClear();
      m = await mount(<Segmented value="a" options={OPTIONS} onChange={onChange} />);
      await press(radios(m)[0], key);
      expect(onChange).toHaveBeenLastCalledWith("b");
      expect(document.activeElement).toBe(radios(m)[1]);
      await press(radios(m)[1], key);
      expect(onChange).toHaveBeenLastCalledWith("c");
      await press(radios(m)[2], key);
      expect(onChange).toHaveBeenLastCalledWith("a");
      expect(document.activeElement).toBe(radios(m)[0]);
    }
  });

  it("ArrowLeft on the first option wraps to the last; ArrowUp behaves the same", async () => {
    for (const key of ["ArrowLeft", "ArrowUp"]) {
      onChange.mockClear();
      m = await mount(<Segmented value="a" options={OPTIONS} onChange={onChange} />);
      await press(radios(m)[0], key);
      expect(onChange).toHaveBeenLastCalledWith("c");
      expect(document.activeElement).toBe(radios(m)[2]);
      await press(radios(m)[2], key);
      expect(onChange).toHaveBeenLastCalledWith("b");
      expect(document.activeElement).toBe(radios(m)[1]);
    }
  });

  it("Home and End jump to the first and last option", async () => {
    m = await mount(<Segmented value="b" options={OPTIONS} onChange={onChange} />);
    await press(radios(m)[1], "Home");
    expect(onChange).toHaveBeenLastCalledWith("a");
    expect(document.activeElement).toBe(radios(m)[0]);
    await press(radios(m)[0], "End");
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(document.activeElement).toBe(radios(m)[2]);
  });

  it("when disabled, arrow keys do not call onChange", async () => {
    m = await mount(<Segmented value="b" options={OPTIONS} onChange={onChange} disabled />);
    const group = m.root.querySelector("[role=radiogroup]")!;
    await act(async () => {
      group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(onChange).not.toHaveBeenCalled();
    for (const b of radios(m)) expect(b.disabled).toBe(true);
  });

  it("the group keeps role=radiogroup and exposes the passed label", async () => {
    m = await mount(<Segmented value="a" options={OPTIONS} onChange={onChange} label="status filter" />);
    const group = m.root.querySelector("[role=radiogroup]");
    expect(group).not.toBeNull();
    expect(group!.getAttribute("aria-label")).toBe("status filter");
  });

  it("clicking an option still calls onChange; the selection classes are unchanged and no focus ring is hidden", async () => {
    m = await mount(<Segmented value="a" options={OPTIONS} onChange={onChange} />);
    const list = radios(m);
    await click(list[1]);
    expect(onChange).toHaveBeenLastCalledWith("b");
    // Simulate the caller's state update: the selection classes follow the new value.
    await m.rerender(<Segmented value="b" options={OPTIONS} onChange={onChange} />);
    expect(list[1].className).toContain("bg-accent");
    expect(list[1].className).toContain("text-accent-fg");
    expect(list[0].className).toContain("text-muted");
    for (const b of radios(m)) expect(b.className).not.toMatch(/outline-none|appearance-none/);
  });
});
