// Overview keyboard shortcuts: a pure key → action map, so the rules (never while typing, never with
// a modifier, never under an open dialog) are testable without a DOM.

export type OverviewAction = "next" | "prev" | "release" | "dismiss" | "help";

/** What the shortcuts sheet lists, in order. */
export const OVERVIEW_SHORTCUTS: { keys: string; what: string }[] = [
  { keys: "j / k", what: "Move to the next / previous ticket that needs you" },
  { keys: "Enter", what: "Open the focused ticket" },
  { keys: "r", what: "Release the focused held ticket (opens the answer box)" },
  { keys: "d", what: "Dismiss the focused failed ticket" },
  { keys: "?", what: "Show this list (Esc closes it)" },
];

const KEYS: Record<string, OverviewAction> = { j: "next", k: "prev", r: "release", d: "dismiss", "?": "help" };

type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: EventTarget | null };

/** The action for a keydown, or null when it must pass through (typing, a modifier, a dialog is open). */
export function overviewAction(e: KeyLike, dialogOpen: boolean): OverviewAction | null {
  if (dialogOpen || e.metaKey || e.ctrlKey || e.altKey) return null;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName ?? ""))) return null;
  return KEYS[e.key] ?? null;
}
