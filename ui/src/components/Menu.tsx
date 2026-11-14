import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./IconButton";

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean };

type Pos = { top: number; left: number };

const GAP = 4;
const EDGE = 4;

/**
 * A ⋯ overflow menu: the trigger toggles a list of items; Escape or an outside click closes it
 * (Escape returns focus to the trigger), ArrowUp/ArrowDown move between items. The list portals to
 * `document.body` and is positioned `fixed` from the trigger's rect so it can float free of an
 * `overflow-hidden` ancestor (e.g. a profile card, #661), flipping above the trigger when there's
 * no room below and shifting to stay inside the viewport horizontally.
 */
export function Menu({ label, items, align = "right" }: { label: string; items: MenuItem[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const focusedOnOpen = useRef(false);
  const id = useId();

  const reposition = () => {
    const t = trigger.current;
    const l = list.current;
    if (!t || !l) return;
    const tr = t.getBoundingClientRect();
    const lr = l.getBoundingClientRect();
    const openUp = tr.bottom + lr.height + GAP > window.innerHeight && tr.top - lr.height - GAP >= 0;
    const top = openUp ? tr.top - lr.height - GAP : tr.bottom + GAP;
    const rawLeft = align === "right" ? tr.right - lr.width : tr.left;
    const left = Math.min(Math.max(rawLeft, EDGE), window.innerWidth - lr.width - EDGE);
    setPos({ top, left });
  };

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open]);

  // Focus only once per open, the first time `pos` is set: before that the list is
  // `visibility: hidden` (so `reposition()` can measure it without a flash), and a browser won't
  // move focus into a hidden element. `reposition()` re-runs on every scroll/resize while open and
  // always sets a new `pos` object, so guard with a ref rather than depending on `pos` alone —
  // otherwise a scroll or resize would steal focus back to the first item mid-navigation (#661).
  useEffect(() => {
    if (!open) {
      focusedOnOpen.current = false;
      return;
    }
    if (!pos || focusedOnOpen.current) return;
    focusedOnOpen.current = true;
    list.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (root.current?.contains(target) || list.current?.contains(target)) return;
      setOpen(false);
    };
    const onReposition = () => reposition();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = (at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div ref={root} className="relative inline-block" onKeyDown={onKeyDown}>
      <IconButton ref={trigger} label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        ⋯
      </IconButton>
      {open &&
        createPortal(
          <div
            ref={list}
            id={id}
            role="menu"
            style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden" }}
            className="z-30 min-w-36 rounded-md border border-border-strong bg-overlay py-1 shadow-lg"
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={`block w-full px-3 py-1 text-left text-label hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none disabled:opacity-50 ${item.danger ? "text-status-failed" : "text-fg"}`}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
