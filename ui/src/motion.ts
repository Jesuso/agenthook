import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The board's motion (#699). Every animation here answers one event and runs once:
 *  - a ticket changed step → its mark slides to the new column (`useSlide`);
 *  - a row arrived → it fades in (`useArrivals`, "skip" while the tab is hidden);
 *  - something new needs the operator → its row is washed once (`useArrivals`, "defer": a tab
 *    in the background keeps it for the moment the operator comes back).
 * Nothing loops, nothing plays on the first paint, and a hidden tab animates nothing.
 */

const visible = () => typeof document !== "undefined" && document.visibilityState === "visible";
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The arrival curve: quick off the mark, settles without a bounce. */
export const SETTLE = "cubic-bezier(0.16, 1, 0.3, 1)";
export const SLIDE_MS = 420;

/** Column a ticket's mark was last drawn in, by ticket. Module-level: a ticket that moves from
 *  the running rows to "Needs you" is a different element, and the slide must survive that. */
const lastColumn = new Map<string, number>();

/** How far (in columns) the mark must travel to reach `at`; 0 = no slide. Records `at`. */
export function slideFrom(id: string, at: number): number {
  const prev = lastColumn.get(id);
  if (at < 0) return 0;
  lastColumn.set(id, at);
  return prev === undefined || prev < 0 ? 0 : prev - at;
}

/** For tests. */
export const forgetColumns = () => lastColumn.clear();

/**
 * A ref for a ticket's mark: when the ticket's column changes, the mark starts where it was and
 * slides to where it is (transform only — the grid has already moved it). No id, no slide.
 */
export function useSlide(id: string | undefined, at: number) {
  const mark = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!id) return;
    const columns = slideFrom(id, at);
    const el = mark.current;
    if (!columns || !el || typeof el.animate !== "function" || !visible() || reduced()) return;
    const width = el.parentElement?.offsetWidth ?? 0;
    if (width > 0) el.animate([{ transform: `translateX(${columns * width}px)` }, { transform: "none" }], { duration: SLIDE_MS, easing: SETTLE });
  }, [id, at]);
  return mark;
}

/**
 * Which of `keys` arrived since the last render, for `ms` after they did. The first render
 * arrives nothing (a page load is not an event). Hidden tab: "skip" forgets the arrival,
 * "defer" holds it until the tab is looked at again.
 */
export function useArrivals(keys: string[], ms: number, hidden: "skip" | "defer"): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const until = useRef(new Map<string, number>());
  const waiting = useRef(new Set<string>());
  const [, repaint] = useState(0);
  const now = Date.now();
  if (seen.current) {
    for (const k of keys) {
      if (seen.current.has(k)) continue;
      if (visible()) until.current.set(k, now + ms);
      else if (hidden === "defer") waiting.current.add(k);
    }
  }
  seen.current = new Set(keys);
  useEffect(() => {
    if (hidden !== "defer") return;
    const back = () => {
      if (!visible() || waiting.current.size === 0) return;
      for (const k of waiting.current) until.current.set(k, Date.now() + ms);
      waiting.current.clear();
      repaint((n) => n + 1);
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [hidden, ms]);
  const fresh = new Set<string>();
  for (const [k, end] of until.current) {
    if (end > now && seen.current.has(k)) fresh.add(k);
    else until.current.delete(k);
  }
  return fresh;
}
