// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { AppBar } from "../AppBar";
import { I18nProvider } from "./react";
import { setLangSetting } from "./index";
import { mount, click } from "../domHarness";
import type { Mounted } from "../domHarness";

const html = document.documentElement;
const dot = () => document.querySelector<HTMLElement>("[data-connection]")!;
const open = () => click(document.querySelector("[data-reading-trigger]")!);
const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[data-reading-panel] [role="radio"]')];
const radio = (label: string) => radios().find((b) => b.textContent === label)!;

let m: Mounted;

beforeEach(async () => {
  localStorage.removeItem("ah-reading");
  setLangSetting("auto", ["en-US"]);
  m = await mount(createElement(I18nProvider, null, createElement(AppBar, { connection: "connected" })));
});

afterEach(async () => {
  await m.unmount();
  setLangSetting("auto", ["en-US"]);
  localStorage.removeItem("ah-reading");
});

describe("language setting", () => {
  it("at Auto renders English and writes nothing", async () => {
    expect(dot().textContent).toBe("Live updates");
    expect(html.lang).toBe("en");
    await open();
    expect(radio("Auto").getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("ah-reading")).toBeNull();
  });

  it("offers endonyms, Español flagged partial while its dictionary is incomplete", async () => {
    await open();
    const group = document.querySelector('[role="radiogroup"][aria-label="Language"]')!;
    expect([...group.querySelectorAll('[role="radio"]')].map((b) => b.textContent)).toEqual(["Auto", "English", "Español (partial)"]);
  });

  it("choosing Español re-renders live and sets <html lang>; English and Reset set it back", async () => {
    await open();
    await click(radio("Español (partial)"));
    expect(html.lang).toBe("es");
    expect(dot().textContent).toBe("Actualizaciones en vivo");
    // The panel itself follows: its labels and the partial flag are now Spanish.
    expect(document.querySelector('[role="radiogroup"][aria-label="Idioma"]')).toBeTruthy();
    expect(radio("Español (parcial)").getAttribute("aria-checked")).toBe("true");
    expect(JSON.parse(localStorage.getItem("ah-reading")!)).toEqual({ lang: "es" });

    await click(radio("English"));
    expect(html.lang).toBe("en");
    expect(dot().textContent).toBe("Live updates");

    await click(radio("Español (partial)"));
    expect(html.lang).toBe("es");
    await click(document.querySelector("[data-reading-reset]")!);
    expect(html.lang).toBe("en");
    expect(dot().textContent).toBe("Live updates");
    expect(radio("Auto").getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("ah-reading")).toBeNull();
  });

  it("Auto with a Spanish browser stays English: Spanish is not complete", () => {
    expect(setLangSetting("auto", ["es-MX"])).toBe("en");
    expect(html.lang).toBe("en");
  });
});
