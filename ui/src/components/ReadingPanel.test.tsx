// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { ReadingPanel } from "./ReadingPanel";
import { mount, click } from "../domHarness";
import type { Mounted } from "../domHarness";
import { installSpeech, uninstallSpeech } from "../speechMock";

const html = document.documentElement;
const trigger = () => document.querySelector<HTMLButtonElement>("[data-reading-trigger]")!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const radio = (group: string, label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(`[role="radiogroup"][aria-label="${group}"] [role="radio"]`)].find((b) => b.textContent === label)!;

let m: Mounted;

beforeEach(async () => {
  localStorage.removeItem("ah-reading");
  for (const a of [...html.attributes]) if (a.name.startsWith("data-ah-")) html.removeAttribute(a.name);
  m = await mount(createElement(ReadingPanel));
});

afterEach(async () => {
  await m.unmount();
});

describe("ReadingPanel", () => {
  it("is a named Aa trigger that reports and controls its popover", async () => {
    const t = trigger();
    expect(t.textContent).toBe("Aa");
    expect(t.getAttribute("aria-label")).toBe("Reading settings");
    expect(t.getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
    await click(t);
    expect(t.getAttribute("aria-expanded")).toBe("true");
    const d = dialog()!;
    expect(d.getAttribute("aria-label")).toBe("Reading settings");
    expect(d.hasAttribute("aria-modal")).toBe(false);
    expect(t.getAttribute("aria-controls")).toBe(d.id);
    expect(d.contains(document.activeElement)).toBe(true);
    for (const g of ["Text size", "Spacing", "Line width", "Background"]) expect(d.querySelector(`[role="radiogroup"][aria-label="${g}"]`), g).toBeTruthy();
  });

  it("leaves out the read-aloud rows where the browser can't speak", async () => {
    await click(trigger());
    const groups = [...dialog()!.querySelectorAll("[role=radiogroup]")].map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Text size", "Spacing", "Line width", "Background", "Language"]);
  });

  it("with speech: Read aloud, then Speed and Read new Needs you disabled until it is on; Reset returns all three", async () => {
    await m.unmount();
    installSpeech();
    try {
      m = await mount(createElement(ReadingPanel));
      await click(trigger());
      const groups = [...dialog()!.querySelectorAll("[role=radiogroup]")].map((g) => g.getAttribute("aria-label"));
      expect(groups).toEqual(["Text size", "Spacing", "Line width", "Background", "Language", "Read aloud", "Speed", "Read new Needs you"]);
      expect(radio("Read aloud", "Off").getAttribute("aria-checked")).toBe("true");
      expect(radio("Speed", "1×").getAttribute("aria-checked")).toBe("true");
      for (const g of ["Speed", "Read new Needs you"]) for (const b of dialog()!.querySelectorAll<HTMLButtonElement>(`[aria-label="${g}"] button`)) expect(b.disabled, g).toBe(true);
      expect(radio("Read aloud", "On").disabled).toBe(false);

      await click(radio("Read aloud", "On"));
      expect(radio("Speed", "1.5×").disabled).toBe(false);
      await click(radio("Speed", "1.5×"));
      await click(radio("Read new Needs you", "On"));
      expect(JSON.parse(localStorage.getItem("ah-reading")!)).toEqual({ readaloud: "on", rate: "1.5", autoread: "on" });

      await click(document.querySelector("[data-reading-reset]")!);
      expect(localStorage.getItem("ah-reading")).toBeNull();
      expect(radio("Read aloud", "Off").getAttribute("aria-checked")).toBe("true");
      expect(radio("Speed", "1×").getAttribute("aria-checked")).toBe("true");
      expect(radio("Read new Needs you", "Off").getAttribute("aria-checked")).toBe("true");
      expect(radio("Speed", "1×").disabled).toBe(true);
    } finally {
      uninstallSpeech();
    }
  });

  it("Escape closes it and returns focus to the trigger", async () => {
    await click(trigger());
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("an outside click closes it, a click inside does not", async () => {
    await click(trigger());
    await act(async () => {
      dialog()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(dialog()).toBeTruthy();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(dialog()).toBeNull();
  });

  it("choosing an option sets its data-ah-* attribute and persists it; Reset clears both", async () => {
    await click(trigger());
    await click(radio("Text size", "130%"));
    await click(radio("Spacing", "Wide"));
    await click(radio("Background", "Warm"));
    expect(html.getAttribute("data-ah-text")).toBe("2");
    expect(html.getAttribute("data-ah-spacing")).toBe("wide");
    expect(html.getAttribute("data-ah-bg")).toBe("warm");
    expect(html.hasAttribute("data-ah-measure")).toBe(false);
    expect(radio("Text size", "130%").getAttribute("aria-checked")).toBe("true");
    expect(JSON.parse(localStorage.getItem("ah-reading")!)).toEqual({ text: "2", spacing: "wide", bg: "warm" });

    await click(document.querySelector("[data-reading-reset]")!);
    for (const k of ["text", "spacing", "measure", "bg"]) expect(html.hasAttribute(`data-ah-${k}`), k).toBe(false);
    expect(localStorage.getItem("ah-reading")).toBeNull();
    expect(radio("Text size", "100%").getAttribute("aria-checked")).toBe("true");
  });

  it("opens on the stored choice", async () => {
    await m.unmount();
    localStorage.setItem("ah-reading", JSON.stringify({ measure: "narrow" }));
    m = await mount(createElement(ReadingPanel));
    await click(trigger());
    expect(radio("Line width", "Narrow").getAttribute("aria-checked")).toBe("true");
  });

  it("opening focuses the first setting's chosen option, not its first button", async () => {
    await m.unmount();
    localStorage.setItem("ah-reading", JSON.stringify({ text: "2" }));
    m = await mount(createElement(ReadingPanel));
    await click(trigger());
    expect(document.activeElement).toBe(radio("Text size", "130%"));
  });
});
