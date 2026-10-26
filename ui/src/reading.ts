// The reading panel's settings (#559): a registry of per-browser display options for prose. Each
// setting is one `data-ah-<key>` attribute on <html>, styled only by index.css; its default value
// removes the attribute, so with nothing chosen the page is exactly as it was. Adding a setting is
// one entry here plus its CSS. `available` hides a row the browser can't support; `requires` shows
// it disabled until another setting has a given value (read aloud, #560, needs no CSS).

import { speechSupported } from "./speech";

export type ReadingSetting = {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  default: string;
  /** False hides the row (e.g. no `speechSynthesis`). */
  available?: () => boolean;
  /** The row is disabled unless setting `key` has `value`. */
  requires?: { key: string; value: string };
};

export const READING_SETTINGS: ReadingSetting[] = [
  {
    key: "text",
    label: "Text size",
    options: [
      { value: "0", label: "100%" },
      { value: "1", label: "115%" },
      { value: "2", label: "130%" },
      { value: "3", label: "150%" },
    ],
    default: "0",
  },
  {
    key: "spacing",
    label: "Spacing",
    options: [
      { value: "off", label: "Off" },
      { value: "wide", label: "Wide" },
      { value: "wider", label: "Wider" },
    ],
    default: "off",
  },
  {
    key: "measure",
    label: "Line width",
    options: [
      { value: "default", label: "Default" },
      { value: "narrow", label: "Narrow" },
    ],
    default: "default",
  },
  {
    key: "bg",
    label: "Background",
    options: [
      { value: "default", label: "Default" },
      { value: "warm", label: "Warm" },
    ],
    default: "default",
  },
  {
    key: "readaloud",
    label: "Read aloud",
    options: [
      { value: "off", label: "Off" },
      { value: "on", label: "On" },
    ],
    default: "off",
    available: speechSupported,
  },
  {
    key: "rate",
    label: "Speed",
    options: [
      { value: "0.75", label: "0.75×" },
      { value: "1", label: "1×" },
      { value: "1.25", label: "1.25×" },
      { value: "1.5", label: "1.5×" },
    ],
    default: "1",
    available: speechSupported,
    requires: { key: "readaloud", value: "on" },
  },
  {
    key: "autoread",
    label: "Read new Needs you",
    options: [
      { value: "off", label: "Off" },
      { value: "on", label: "On" },
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
