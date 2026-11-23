import { useEffect, useState } from "react";

/**
 * The viewport width (px) at which the ticket drawer docks beside the page instead of covering it
 * (#708). Tailwind's `2xl` breakpoint (1536px): the drawer takes the Overview rail's place from
 * exactly where the rail appears. Every docked/overlay decision reads `useDocked`, so raising the
 * breakpoint means editing this one constant.
 */
export const DOCK_MIN_PX = 1536;

const dockQuery = () => `(min-width: ${DOCK_MIN_PX}px)`;

/**
 * Whether the ticket drawer docks beside the page at the current viewport width. Reads
 * `matchMedia(dockQuery)` once and follows its `change` events, so a resize across the
 * breakpoint flips docked/overlay live (and tests can stub `matchMedia`).
 */
export function useDocked(): boolean {
  const [docked, setDocked] = useState<boolean>(() => window.matchMedia?.(dockQuery())?.matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(dockQuery());
    if (!m) return;
    const update = () => setDocked(m.matches);
    m.addEventListener?.("change", update);
    return () => m.removeEventListener?.("change", update);
  }, []);
  return docked;
}
