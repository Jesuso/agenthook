import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { DICTIONARIES, getLang, interpolate, makeT, parityErrors, resolveLang, setLangSetting, subscribeLang, translate } from "./index";
import type { MessageKey, Messages } from "./index";
import * as en from "./en";
import * as es from "./es";
import { formatCost, formatLastEvent, formatRelative, formatUp, profileBadge, ticketTitle } from "../format";
import { shortDate } from "../stats";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const ago = (mins: number) => new Date(NOW - mins * 60000).toISOString();

describe("dictionary parity", () => {
  it("every registered dictionary has exactly en's keys, plural shapes and {vars}", () => {
    for (const [lang, d] of Object.entries(DICTIONARIES)) expect(parityErrors(en.messages, d.messages), lang).toEqual([]);
  });

  it("catches a key or a {var} added to only one dictionary, and a plural/string mismatch", () => {
    const base: Messages = { "a.b": "Hi {name}", "a.n": { one: "{count} item", other: "{count} items" } };
    expect(parityErrors(base, { "a.b": "Hola {name}", "a.n": { one: "{count} cosa", other: "{count} cosas" } })).toEqual([]);
    expect(parityErrors(base, { "a.b": "Hola {name}" })).toEqual(["missing key a.n"]);
    expect(parityErrors(base, { ...base, "a.extra": "x" })).toEqual(["extra key a.extra"]);
    expect(parityErrors(base, { ...base, "a.b": "Hola {name} {when}" })).toEqual(["a.b: vars {name,when} ≠ {name}"]);
    expect(parityErrors(base, { ...base, "a.b": "Hola" })).toEqual(["a.b: vars {} ≠ {name}"]);
    expect(parityErrors(base, { ...base, "a.n": "{count} cosas" })).toEqual(["a.n: plural in one dictionary, a string in the other"]);
    // Every plural form is compared, not just `other`.
    expect(parityErrors(base, { ...base, "a.n": { one: "una cosa", many: "{count} {x}", other: "{count} cosas" } })).toEqual([
      "a.n.one: vars {} ≠ {count}",
      "a.n.many: vars {count,x} ≠ {count}",
    ]);
    // The real dictionaries, perturbed on one side only.
    expect(parityErrors(en.messages, { ...es.messages, "time.extra": "x" })).toEqual(["extra key time.extra"]);
    expect(parityErrors({ ...en.messages, "time.extra": "x" }, es.messages)).toEqual(["missing key time.extra"]);
    expect(parityErrors(en.messages, { ...es.messages, "home.lastSeen": "visto {when} {who}" })).toHaveLength(1);
  });

  it("metadata: English is complete, Spanish is partial until #562", () => {
    expect(en.meta).toEqual({ lang: "en", name: "English", complete: true });
    expect(es.meta).toEqual({ lang: "es", name: "Español", complete: false });
    for (const [lang, d] of Object.entries(DICTIONARIES)) expect(d.meta.lang).toBe(lang);
  });

  it("Spanish uses CONTEXT.md's glossary terms", () => {
    const context = readFileSync(new URL("../../../CONTEXT.md", import.meta.url), "utf8");
    const terms = [...context.matchAll(/^_Español_: (.+)$/gm)].map((m) => m[1].trim());
    expect(terms).toEqual(["Perfil", "Ticket", "Épica", "Terminado", "Fusionado", "Te necesita", "Listo para cerrar", "Resumen", "Servicio", "SOUL"]);
    expect(es.messages["home.profiles"]).toBe("Perfiles");
    expect(es.messages["home.needsYou"]).toBe("te necesita");
    expect(es.messages["lastEvent.merge"]).toBe("fusionado");
    expect(es.messages["status.done"]).toBe("terminado");
    expect(es.messages["digest.label"]).toBe("resumen");
  });
});

describe("t", () => {
  const t = makeT("es");

  it("interpolates {name}, leaving an unknown placeholder as written", () => {
    expect(translate("en", "home.lastSeen", { when: "5m ago" })).toBe("last seen 5m ago");
    expect(t("home.lastSeen", { when: "hace 5 min" })).toBe("visto hace 5 min");
    expect(interpolate("{a} and {b}", { a: 1 })).toBe("1 and {b}");
    // A value is inserted once, never re-scanned.
    expect(interpolate("{a}", { a: "{b}", b: "x" })).toBe("{b}");
  });

  it("picks the plural form for vars.count; a missing category falls back to other", () => {
    expect(translate("en", "overview.freeSlots", { count: 1 })).toBe("1 free slot");
    expect(translate("en", "overview.freeSlots", { count: 2 })).toBe("2 free slots");
    expect(t("overview.freeSlots", { count: 1 })).toBe("1 hueco libre");
    expect(t("overview.freeSlots", { count: 3 })).toBe("3 huecos libres");
    // es has a "many" category (1000000) that our dictionary leaves to `other`.
    expect(new Intl.PluralRules("es").select(1000000)).toBe("many");
    expect(t("overview.freeSlots", { count: 1000000 })).toBe("1000000 huecos libres");
    // No count: `other`.
    expect(t("overview.needYou")).toBe("te necesitan");
  });

  it("a missing key falls back to English, then to the key; an unknown language is English", () => {
    const saved = DICTIONARIES.es.messages["home.profiles"];
    delete (DICTIONARIES.es.messages as Partial<Record<MessageKey, unknown>>)["home.profiles"];
    try {
      expect(t("home.profiles")).toBe("Profiles");
    } finally {
      DICTIONARIES.es.messages["home.profiles"] = saved;
    }
    expect(t("no.such.key" as MessageKey)).toBe("no.such.key");
    expect(translate("fr", "home.profiles")).toBe("Profiles");
  });
});

describe("resolveLang", () => {
  it("an explicit choice wins; an unknown one is English", () => {
    expect(resolveLang("es", ["en-US"])).toBe("es");
    expect(resolveLang("en", ["es-MX"])).toBe("en");
    expect(resolveLang("fr", ["fr"])).toBe("en");
  });

  it("auto takes the first browser language with a complete dictionary, else English", () => {
    expect(resolveLang("auto", ["en-GB"])).toBe("en");
    expect(resolveLang("auto", [])).toBe("en");
    // Spanish is partial: Auto never picks it.
    expect(resolveLang("auto", ["es-MX", "es"])).toBe("en");
    DICTIONARIES.es.meta.complete = true;
    try {
      expect(resolveLang("auto", ["fr-FR", "ES-mx", "en"])).toBe("es");
      expect(resolveLang("auto", ["en-US", "es"])).toBe("en");
    } finally {
      DICTIONARIES.es.meta.complete = false;
    }
  });
});

describe("language store", () => {
  afterEach(() => setLangSetting("auto", []));

  it("sets <html lang> and notifies subscribers only on a change", () => {
    const attrs = new Map<string, string>();
    const root = { setAttribute: (k: string, v: string) => void attrs.set(k, v) } as unknown as Element;
    let calls = 0;
    const off = subscribeLang(() => calls++);
    expect(setLangSetting("es", [], root)).toBe("es");
    expect(getLang()).toBe("es");
    expect(attrs.get("lang")).toBe("es");
    setLangSetting("es", [], root);
    expect(calls).toBe(1);
    expect(setLangSetting("auto", ["es-MX"], root)).toBe("en");
    expect(attrs.get("lang")).toBe("en");
    expect(calls).toBe(2);
    off();
  });
});

describe("format helpers take a language", () => {
  it("English output is today's, byte for byte, with or without lang", () => {
    for (const lang of [undefined, "en"]) {
      expect(formatRelative(ago(0), NOW, lang)).toBe("just now");
      expect(formatRelative(ago(5), NOW, lang)).toBe("5m ago");
      expect(formatRelative(ago(180), NOW, lang)).toBe("3h ago");
      expect(formatRelative(ago(2 * 1440), NOW, lang)).toBe("2d ago");
      expect(formatCost(0.57, lang)).toBe("$0.57");
      expect(shortDate("2026-10-14", lang)).toBe("Oct 14");
    }
  });

  it("Spanish uses Intl and the dictionary", () => {
    expect(formatRelative(ago(0), NOW, "es")).toBe("ahora mismo");
    expect(formatRelative(ago(5), NOW, "es")).toBe("hace 5 min");
    expect(formatRelative(ago(180), NOW, "es")).toBe(new Intl.RelativeTimeFormat("es", { style: "narrow", numeric: "always" }).format(-3, "hour"));
    expect(formatRelative(null, NOW, "es")).toBe("—");
    expect(formatCost(0.57, "es")).toBe(new Intl.NumberFormat("es", { style: "currency", currency: "USD" }).format(0.57));
    expect(formatCost(0.57, "es")).toContain("0,57");
    expect(formatCost(0, "es")).toBe("—");
    expect(shortDate("2026-10-14", "es")).toBe(new Date(2026, 9, 14).toLocaleDateString("es", { month: "short", day: "numeric" }));
    expect(formatUp({ up: true, pid: 1, port: 2 }, "es").text).toBe("activo");
    expect(ticketTitle({ title: null }, "es").text).toBe("(título desconocido: aparece tras su próxima ejecución)");
    expect(formatLastEvent({ kind: "merge", ref: "42", step: null, at: ago(5) }, null, NOW, "es").text).toBe("fusionado 42 · hace 5 min");
    expect(profileBadge({ name: "x", label: "x", ghost: false, configMissing: true, configPath: null, createdAt: null }, "es")?.title).toBe(
      "el archivo de configuración ya no existe",
    );
  });
});
