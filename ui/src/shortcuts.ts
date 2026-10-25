// Overview keyboard shortcuts: a pure key → action map, so the rules (never while typing, never with
// a modifier, never under an open dialog) are testable without a DOM.

export type OverviewAction = "next" | "prev" | "release" | "dismiss" | "help";

/** What the shortcuts sheet lists, in order. */
export const OVERVIEW_SHORTCUTS: { keys: string; what: string }[] = [
  { keys: "j / k", what: "Move to the next / previous ticket: Needs you first, then Now" },
  { keys: "Enter", what: "Open the focused ticket (a running one shows its live log)" },
  { keys: "r", what: "Release the focused held ticket (opens the answer box), or re-run the focused failed one" },
  { keys: "d", what: "Dismiss the focused failed ticket" },
  { keys: "Ctrl / ⌘ + Z", what: "Undo the last dismiss (within 5 s)" },
  { keys: "?", what: "Show this list (Esc closes it)" },
];

const KEYS: Record<string, OverviewAction> = { j: "next", k: "prev", r: "release", d: "dismiss", "?": "help" };

type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: EventTarget | null };

/** The action for a keydown, or null when it must pass through (typing, a modifier, a dialog is open). */
export function overviewAction(e: KeyLike, dialogOpen: boolean): OverviewAction | null {
  if (dialogOpen || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (editable(e.target)) return null;
  return KEYS[e.key] ?? null;
}

const editable = (target: EventTarget | null) => {
  const t = target as { tagName?: string; isContentEditable?: boolean } | null;
  return !!t && (!!t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName ?? ""));
};

/** Ctrl/⌘+Z outside a text field (where it must keep undoing typing), no Shift (that is redo). */
export function isUndoKey(e: KeyLike & { shiftKey: boolean }): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && !editable(e.target);
}

export type EpicsAction = "next" | "prev" | "up" | "help";

/** The Epics view's sheet: read-only keys (nothing here writes; Release and Re-run stay buttons). */
export const EPICS_SHORTCUTS: { keys: string; what: string }[] = [
  { keys: "j / k", what: "Move to the next / previous epic (on an epic's page: ticket)" },
  { keys: "Enter", what: "Open the focused epic or ticket" },
  { keys: "u", what: "Back to the epics list" },
  { keys: "?", what: "Show this list (Esc closes it)" },
];

const EPIC_KEYS: Record<string, EpicsAction> = { j: "next", k: "prev", u: "up", "?": "help" };

/** The Epics view's action for a keydown, under the same rules as the Overview's. */
export function epicsAction(e: KeyLike, dialogOpen: boolean): EpicsAction | null {
  if (dialogOpen || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (editable(e.target)) return null;
  return EPIC_KEYS[e.key] ?? null;
}

const OFF_KEY = "ah-shortcuts-off";

/**
 * Single-character shortcuts can be switched off (WCAG 2.1.4: speech input fires them by accident).
 * Per browser, in localStorage; storage that is absent or throws leaves them on.
 */
export function shortcutsEnabled(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) !== "1";
  } catch {
    return true;
  }
}

export function setShortcutsEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(OFF_KEY);
    else localStorage.setItem(OFF_KEY, "1");
  } catch {
    // a per-browser convenience only
  }
}
