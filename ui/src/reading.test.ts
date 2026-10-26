import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { READING_SETTINGS, applyReading, readReading, readingDefaults, resetReading, writeReading } from "./reading";

const DEFAULTS = { text: "0", spacing: "off", measure: "default", bg: "default", lang: "auto", readaloud: "off", rate: "1", autoread: "off" };

/** An in-memory Storage subset. */
function memory(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

/** The Element subset applyReading touches. */
function element() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    hasAttribute: (k: string) => attrs.has(k),
  } as unknown as Element & { attrs: Map<string, string> };
}

const throwing = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};

describe("reading settings", () => {
  it("register text, spacing, line width, background, language and the read-aloud trio, each default one of its options", () => {
    expect(READING_SETTINGS.map((s) => s.key)).toEqual(["text", "spacing", "measure", "bg", "lang", "readaloud", "rate", "autoread"]);
    for (const s of READING_SETTINGS) expect(s.options.map((o) => o.value), s.key).toContain(s.default);
    expect(readingDefaults()).toEqual(DEFAULTS);
  });

  it("gate the read-aloud rows on speech support, Speed and auto-read on Read aloud being on", () => {
    const by = Object.fromEntries(READING_SETTINGS.map((s) => [s.key, s]));
    for (const k of ["text", "spacing", "measure", "bg", "lang"]) expect(by[k].available ?? by[k].requires, k).toBeUndefined();
    for (const k of ["readaloud", "rate", "autoread"]) expect(typeof by[k].available, k).toBe("function");
    expect(by.readaloud.requires).toBeUndefined();
    expect(by.rate.requires).toEqual({ key: "readaloud", value: "on" });
    expect(by.autoread.requires).toEqual({ key: "readaloud", value: "on" });
    expect(by.rate.options.map((o) => [o.value, "text" in o ? o.text : o.label])).toEqual([["0.75", "0.75×"], ["1", "1×"], ["1.25", "1.25×"], ["1.5", "1.5×"]]);
    expect(by.autoread.label).toBe("reading.autoread");
  });

  it("read as the defaults with nothing stored, no storage, or storage that throws", () => {
    expect(readReading(memory())).toEqual(DEFAULTS);
    expect(readReading(undefined)).toEqual(DEFAULTS);
    expect(readReading(throwing)).toEqual(DEFAULTS);
  });

  it("default storage: a browser where touching localStorage throws reads defaults and writes nothing, without throwing", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: storage blocked");
      },
    });
    try {
      expect(readReading()).toEqual(DEFAULTS);
      expect(() => writeReading({ ...DEFAULTS, text: "1" })).not.toThrow();
    } finally {
      if (desc) Object.defineProperty(globalThis, "localStorage", desc);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it("drop corrupt JSON, unknown keys and invalid values", () => {
    expect(readReading(memory({ "ah-reading": "{not json" }))).toEqual(DEFAULTS);
    expect(readReading(memory({ "ah-reading": "null" }))).toEqual(DEFAULTS);
    expect(readReading(memory({ "ah-reading": '"wide"' }))).toEqual(DEFAULTS);
    const got = readReading(memory({ "ah-reading": JSON.stringify({ text: "9", spacing: "wide", font: "comic", bg: 1 }) }));
    expect(got).toEqual({ ...DEFAULTS, spacing: "wide" });
  });

  it("round-trip through one JSON key, storing only what differs from the defaults", () => {
    const store = memory();
    writeReading({ ...DEFAULTS, text: "2", bg: "warm" }, store);
    expect(JSON.parse(store.data.get("ah-reading")!)).toEqual({ text: "2", bg: "warm" });
    expect(readReading(store)).toEqual({ ...DEFAULTS, text: "2", bg: "warm" });
    writeReading(DEFAULTS, store);
    expect(store.data.has("ah-reading")).toBe(false);
  });

  it("language: Auto, then every dictionary by its own name (none partial today); stored only when chosen", () => {
    const lang = READING_SETTINGS.find((s) => s.key === "lang")!;
    expect(lang.options).toEqual([
      { value: "auto", label: "reading.auto" },
      { value: "en", text: "English", partial: false },
      { value: "es", text: "Español", partial: false },
    ]);
    const store = memory();
    writeReading(DEFAULTS, store);
    expect(store.data.has("ah-reading")).toBe(false);
    writeReading({ ...DEFAULTS, lang: "es" }, store);
    expect(JSON.parse(store.data.get("ah-reading")!)).toEqual({ lang: "es" });
    expect(readReading(store).lang).toBe("es");
    expect(readReading(memory({ "ah-reading": JSON.stringify({ lang: "fr" }) })).lang).toBe("auto");
  });

  it("write best effort: throwing or absent storage is not an error", () => {
    expect(() => writeReading({ ...DEFAULTS, text: "1" }, throwing)).not.toThrow();
    expect(() => writeReading({ ...DEFAULTS, text: "1" }, undefined)).not.toThrow();
  });

  it("apply as data-ah-* attributes on the given root, a default removing it", () => {
    const root = element();
    applyReading({ ...DEFAULTS, text: "3", spacing: "wider", measure: "narrow", bg: "warm" }, root);
    expect(root.getAttribute("data-ah-text")).toBe("3");
    expect(root.getAttribute("data-ah-spacing")).toBe("wider");
    expect(root.getAttribute("data-ah-measure")).toBe("narrow");
    expect(root.getAttribute("data-ah-bg")).toBe("warm");
    applyReading({ ...DEFAULTS, text: "3" }, root);
    expect(root.getAttribute("data-ah-text")).toBe("3");
    for (const k of ["spacing", "measure", "bg"]) expect(root.hasAttribute(`data-ah-${k}`), k).toBe(false);
    applyReading(DEFAULTS, root);
    expect(root.attrs.size).toBe(0);
  });

  it("reset clears storage and attributes", () => {
    const store = memory({ "ah-reading": JSON.stringify({ text: "1" }) });
    const root = element();
    root.setAttribute("data-ah-text", "1");
    expect(resetReading(store, root)).toEqual(DEFAULTS);
    expect(store.data.has("ah-reading")).toBe(false);
    expect(root.hasAttribute("data-ah-text")).toBe(false);
  });
});

// The CSS side: every rule is keyed on a data-ah-* attribute, and monospace is held to the base.
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`no ${selector} rule in index.css`);
  return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
}

const decls = (body: string) => Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

const theme = decls(css.slice(css.indexOf("@theme"), css.indexOf(":root")));
const SCALED = ["body", "label", "meta", "title", "heading"].flatMap((t) => [`--text-${t}`, `--text-${t}--line-height`]);
const MONO = ":is(.font-mono, code, pre, .cm-editor, [data-diff])";

describe("reading CSS", () => {
  it("scales every prose type token by 1.15 / 1.3 / 1.5, never --text-stat", () => {
    expect(decls(rule('html[data-ah-text="1"]'))).toEqual({ "--ah-text-scale": "1.15" });
    expect(decls(rule('html[data-ah-text="2"]'))).toEqual({ "--ah-text-scale": "1.3" });
    expect(decls(rule('html[data-ah-text="3"]'))).toEqual({ "--ah-text-scale": "1.5" });
    const scaled = decls(rule("html[data-ah-text]"));
    expect(Object.keys(scaled).sort()).toEqual([...SCALED].sort());
    for (const t of SCALED) expect(scaled[t], t).toBe(`calc(${theme[t]} * var(--ah-text-scale, 1))`);
  });

  it("resets every scaled token to its base value on monospace", () => {
    const reset = decls(rule(`html[data-ah-text] ${MONO}`));
    expect(Object.keys(reset).sort()).toEqual([...SCALED].sort());
    for (const t of SCALED) expect(reset[t], t).toBe(theme[t]);
    expect(theme["--text-body"]).toBe("13px");
    expect(theme["--text-label"]).toBe("12px");
    expect(theme["--text-meta"]).toBe("11px");
  });

  it("sets letter and word spacing together from one attribute, monospace back to normal", () => {
    expect(decls(rule('html[data-ah-spacing="wide"] body'))).toEqual({ "letter-spacing": "0.06em", "word-spacing": "0.16em" });
    expect(decls(rule('html[data-ah-spacing="wider"] body'))).toEqual({ "letter-spacing": "0.12em", "word-spacing": "0.32em" });
    expect(decls(rule(`html[data-ah-spacing] ${MONO}`))).toEqual({ "letter-spacing": "normal", "word-spacing": "normal" });
  });

  it("caps rendered prose at 60ch when narrow", () => {
    expect(decls(rule('html[data-ah-measure="narrow"] .md-preview'))).toEqual({ "max-width": "60ch" });
  });

  it("keys every reading rule on its attribute", () => {
    const tail = css.slice(css.indexOf('html[data-ah-text="1"]'), css.indexOf("@keyframes status-pulse"));
    for (const m of tail.matchAll(/([^{}]+)\{/g)) {
      const sel = m[1].trim();
      if (sel.startsWith("@media")) continue;
      expect(sel, sel).toMatch(/^html\[data-ah-(text|spacing|measure|bg)/);
    }
  });
});
