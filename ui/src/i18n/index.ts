// The UI's in-house i18n (#561): dictionaries keyed by dotted ids, `{name}` interpolation, plural
// forms picked by `Intl.PluralRules`, and the language store the reading panel drives. No
// dependency. Adding a language is one dictionary file registered in DICTIONARIES
// (docs/web-ui.md § Languages).
import * as en from "./en";
import * as es from "./es";
import type { MessageKey } from "./en";
import type { DictionaryMeta, Message, Messages, PluralForms } from "./types";

export type { MessageKey } from "./en";
export type { DictionaryMeta, Message, Messages, PluralForms } from "./types";

export type Dictionary = { meta: DictionaryMeta; messages: Record<MessageKey, Message> };
export type Vars = Record<string, string | number>;
export type T = (key: MessageKey, vars?: Vars) => string;

/** Every language the UI can render, in the reading panel's order. English is the fallback. */
export const DICTIONARIES: Record<string, Dictionary> = { en, es };

const plurals = new Map<string, Intl.PluralRules>();
function pluralRules(lang: string): Intl.PluralRules {
  let r = plurals.get(lang);
  if (!r) plurals.set(lang, (r = new Intl.PluralRules(lang)));
  return r;
}

/** `{name}` → `vars.name`; a placeholder without a var stays as written. */
export function interpolate(text: string, vars: Vars): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** The plural form for `count` in `lang` (`other` when that category is missing or no count is given). */
function pick(forms: PluralForms, lang: string, count: unknown): string {
  if (typeof count !== "number") return forms.other;
  return forms[pluralRules(lang).select(count) as keyof PluralForms] ?? forms.other;
}

/** `key` in `lang`: a missing language or key falls back to English, then to the key itself. */
export function translate(lang: string, key: MessageKey, vars?: Vars): string {
  let from = DICTIONARIES[lang] ? lang : "en";
  let msg: Message | undefined = DICTIONARIES[from].messages[key];
  if (msg === undefined && from !== "en") msg = DICTIONARIES[(from = "en")].messages[key];
  if (msg === undefined) return key;
  const text = typeof msg === "string" ? msg : pick(msg, from, vars?.count);
  return vars ? interpolate(text, vars) : text;
}

/** A `t` bound to one language. */
export const makeT = (lang: string): T => (key, vars) => translate(lang, key, vars);

/**
 * The language to render for a reading-panel setting: `"en"`/`"es"` as chosen (an unknown one is
 * English); `"auto"` the first browser language whose base subtag has a dictionary marked
 * `complete`, else English — a partial translation is only ever an explicit choice.
 */
export function resolveLang(setting: string, languages: readonly string[] = []): string {
  if (setting !== "auto") return DICTIONARIES[setting] ? setting : "en";
  for (const l of languages) {
    const base = l.toLowerCase().split("-")[0];
    if (DICTIONARIES[base]?.meta.complete) return base;
  }
  return "en";
}

/** `navigator.languages`, or [] outside a browser. */
function browserLanguages(): readonly string[] {
  const nav = globalThis.navigator;
  return nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : [];
}

// The current language: set by main.tsx before the first render and by the reading panel after,
// read by I18nProvider through useSyncExternalStore.
let current = "en";
const listeners = new Set<() => void>();

export const getLang = (): string => current;

export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resolve a language setting, set `<html lang>` and re-render every `useT` consumer. Returns the language. */
export function setLangSetting(setting: string, languages: readonly string[] = browserLanguages(), root: Element | undefined = globalThis.document?.documentElement): string {
  const next = resolveLang(setting, languages);
  root?.setAttribute("lang", next);
  if (next !== current) {
    current = next;
    for (const fn of listeners) fn();
  }
  return next;
}

/** `{a}{b}` → ["a", "b"]: the placeholders a message uses, sorted. */
const varsOf = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(",");

/**
 * What differs between a dictionary and the source of truth (empty = in parity): a key missing or
 * extra, a plural in one and a plain string in the other, or a `{var}` set that differs — every
 * plural form is held to the source's `other`.
 */
export function parityErrors(base: Messages, other: Messages): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(base)) if (!(key in other)) errors.push(`missing key ${key}`);
  for (const key of Object.keys(other)) {
    if (!(key in base)) {
      errors.push(`extra key ${key}`);
      continue;
    }
    const a = base[key];
    const b = other[key];
    if (typeof a !== typeof b) {
      errors.push(`${key}: plural in one dictionary, a string in the other`);
      continue;
    }
    const want = varsOf(typeof a === "string" ? a : a.other);
    const forms = (m: Message) => (typeof m === "string" ? [["", m]] : Object.entries(m));
    for (const [form, text] of [...forms(a), ...forms(b)]) {
      if (text !== undefined && varsOf(text) !== want) errors.push(`${key}${form ? `.${form}` : ""}: vars {${varsOf(text)}} ≠ {${want}}`);
    }
  }
  return errors;
}
