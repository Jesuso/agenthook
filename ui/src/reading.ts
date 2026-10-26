// The reading panel's settings (#559): a registry of per-browser display options for prose. Each
// setting is one `data-ah-<key>` attribute on <html>, styled only by index.css; its default value
// removes the attribute, so with nothing chosen the page is exactly as it was. Adding a setting is
// one entry here plus its CSS. Labels are dictionary keys (i18n/en.ts), translated when rendered;
// an option with `text` instead (a percentage, a language's own name) is never translated. `lang`
// (#561) has no CSS rule: ReadingPanel and main.tsx also hand it to the i18n store, which sets <html lang>.
// `available` hides a row the browser can't support; `requires` shows it disabled until another
// setting has a given value (read aloud, #560, needs no CSS).
import { DICTIONARIES } from "./i18n";
import type { MessageKey } from "./i18n";
import { speechSupported } from "./speech";

export type ReadingOption = { value: string; label: MessageKey } | { value: string; text: string; partial?: boolean };
export type ReadingSetting = {
  key: string;
  label: MessageKey;
  options: ReadingOption[];
  default: string;
  /** False hides the row (e.g. no `speechSynthesis`). */
  available?: () => boolean;
  /** The row is disabled unless setting `key` has `value`. */
  requires?: { key: string; value: string };
};

export const READING_SETTINGS: ReadingSetting[] = [
  {
    key: "text",
    label: "reading.text",
    options: [
      { value: "0", text: "100%" },
      { value: "1", text: "115%" },
      { value: "2", text: "130%" },
      { value: "3", text: "150%" },
    ],
    default: "0",
  },
  {
    key: "spacing",
    label: "reading.spacing",
    options: [
      { value: "off", label: "reading.off" },
      { value: "wide", label: "reading.wide" },
      { value: "wider", label: "reading.wider" },
    ],
    default: "off",
  },
  {
    key: "measure",
    label: "reading.measure",
    options: [
      { value: "default", label: "reading.default" },
      { value: "narrow", label: "reading.narrow" },
    ],
    default: "default",
  },
  {
    key: "bg",
    label: "reading.bg",
    options: [
      { value: "default", label: "reading.default" },
      { value: "warm", label: "reading.warm" },
    ],
    default: "default",
  },
  {
    // Endonyms: a reader lost in a language they can't read still finds their own. An incomplete
    // dictionary is flagged "(partial)" (ReadingPanel) and is never what Auto picks.
    key: "lang",
    label: "reading.lang",
    options: [
      { value: "auto", label: "reading.auto" },
      ...Object.values(DICTIONARIES).map((d) => ({ value: d.meta.lang, text: d.meta.name, partial: !d.meta.complete })),
    ],
    default: "auto",
  },
  {
    key: "readaloud",
    label: "reading.readaloud",
    options: [
      { value: "off", label: "reading.off" },
      { value: "on", label: "reading.on" },
    ],
    default: "off",
    available: speechSupported,
  },
  {
    key: "rate",
    label: "reading.rate",
    options: [
      { value: "0.75", text: "0.75×" },
      { value: "1", text: "1×" },
      { value: "1.25", text: "1.25×" },
      { value: "1.5", text: "1.5×" },
    ],
    default: "1",
    available: speechSupported,
    requires: { key: "readaloud", value: "on" },
  },
  {
    key: "autoread",
    label: "reading.autoread",
    options: [
      { value: "off", label: "reading.off" },
      { value: "on", label: "reading.on" },
    ],
    default: "off",
    available: speechSupported,
    requires: { key: "readaloud", value: "on" },
  },
];

/** One value per setting key. */
export type ReadingValues = Record<string, string>;

const KEY = "ah-reading";

/** `localStorage`, or undefined where merely touching it throws (storage blocked by the browser). */
function local(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export const readingDefaults = (): ReadingValues => Object.fromEntries(READING_SETTINGS.map((s) => [s.key, s.default]));

/** The stored settings over the defaults; unknown keys and invalid values are dropped, and missing,
 * throwing or corrupt storage reads as all defaults. */
export function readReading(store: Pick<Storage, "getItem"> | undefined = local()): ReadingValues {
  const out = readingDefaults();
  try {
    const raw = store?.getItem(KEY);
    const saved = raw ? JSON.parse(raw) : null;
    if (!saved || typeof saved !== "object") return out;
    for (const s of READING_SETTINGS) {
      const v = saved[s.key];
      if (s.options.some((o) => o.value === v)) out[s.key] = v;
    }
  } catch {
    /* storage disabled or corrupt — defaults */
  }
  return out;
}

/** Persist the non-default values; all defaults removes the key. Best effort. */
export function writeReading(values: ReadingValues, store: Pick<Storage, "setItem" | "removeItem"> | undefined = local()): void {
  const changed = Object.fromEntries(READING_SETTINGS.filter((s) => values[s.key] !== undefined && values[s.key] !== s.default).map((s) => [s.key, values[s.key]]));
  try {
    if (Object.keys(changed).length) store?.setItem(KEY, JSON.stringify(changed));
    else store?.removeItem(KEY);
  } catch {
    /* storage disabled — the settings just won't persist */
  }
}

/** Set (or, for a default or missing value, remove) each setting's `data-ah-<key>` attribute. */
export function applyReading(values: ReadingValues, root: Element = document.documentElement): void {
  for (const s of READING_SETTINGS) {
    const v = values[s.key];
    if (v === undefined || v === s.default) root.removeAttribute(`data-ah-${s.key}`);
    else root.setAttribute(`data-ah-${s.key}`, v);
  }
}

/** Back to the defaults: storage cleared, attributes removed. */
export function resetReading(store: Pick<Storage, "setItem" | "removeItem"> | undefined = local(), root: Element = document.documentElement): ReadingValues {
  const values = readingDefaults();
  writeReading(values, store);
  applyReading(values, root);
  return values;
}

// The shared store (#560): one in-memory copy of the settings that the panel writes and every
// `useReading()` (useReading.ts) follows, so a change shows everywhere at once. Once the last
// subscriber leaves it is dropped, and the next read goes back to storage.
let current: ReadingValues | null = null;
const listeners = new Set<() => void>();

/** The current settings: the store's copy, else storage. */
export function getReading(): ReadingValues {
  return (current ??= readReading());
}

/** Persist, apply to <html> and notify every subscriber. */
export function setReading(values: ReadingValues): void {
  current = values;
  writeReading(values);
  applyReading(values);
  for (const fn of [...listeners]) fn();
}

export function subscribeReading(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (!listeners.size) current = null;
  };
}
