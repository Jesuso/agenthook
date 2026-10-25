// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ShortcutSheet } from "./ShortcutSheet";
import { setShortcutsEnabled, shortcutsEnabled } from "../shortcuts";

describe("ShortcutSheet", () => {
  it("the switch persists per browser: off, then back on", () => {
    localStorage.removeItem("ah-shortcuts-off");
    expect(shortcutsEnabled()).toBe(true);
    setShortcutsEnabled(false);
    expect(shortcutsEnabled()).toBe(false);
    setShortcutsEnabled(true);
    expect(shortcutsEnabled()).toBe(true);
  });
  it("is a named dialog with a visible Close and the single-key switch", () => {
    localStorage.removeItem("ah-shortcuts-off");
    const out = renderToStaticMarkup(createElement(ShortcutSheet, { rows: [{ keys: "j / k", what: "Move" }], onClose: () => {} }));
    const labelled = out.match(/role="dialog"[^>]*aria-labelledby="([^"]+)"/)?.[1];
    expect(labelled).toBeTruthy();
    expect(out).toContain(`id="${labelled}"`);
    expect(out).toContain(">Close</button>");
    expect(out).toMatch(/data-shortcuts-toggle="true"[^>]*checked=""/);
    expect(out).toContain("Single-key shortcuts on");
  });
  it("shows the off state and how to get back", () => {
    localStorage.setItem("ah-shortcuts-off", "1");
    const out = renderToStaticMarkup(createElement(ShortcutSheet, { rows: [], onClose: () => {} }));
    expect(out).not.toMatch(/data-shortcuts-toggle="true"[^>]*checked=""/);
    expect(out).toContain("Off: single keys do nothing.");
    localStorage.removeItem("ah-shortcuts-off");
  });
});
