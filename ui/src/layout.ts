import { useEffect, useState } from "react";

/**
 * The viewport width (px) at which the ticket drawer docks beside the page instead of covering
 * it (#708). Measured in a real browser: the tickets table needs ~1030 px to render without
 * sideways scrolling, and docking from 1536 left it at ~700 px (331 px of horizontal scroll).
 * 1880 keeps the table clear once the drawer takes its ~720–880 px column. It deliberately does
 * NOT share the side rail's `2xl` breakpoint (1536px): between 1536 and 1879 the page shows its
 * rail and the drawer overlays it, exactly as on master. Every docked/overlay decision reads
 * `useDocked`, so raising the breakpoint means editing this one constant.
 */
export const DOCK_MIN_PX = 1880;

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
