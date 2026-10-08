import { useEffect, useId, useRef, useState } from "react";
import { IconButton } from "./IconButton";

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean };

/**
 * A ⋯ overflow menu: the trigger toggles a list of items; Escape or an outside click closes it
 * (Escape returns focus to the trigger), ArrowUp/ArrowDown move between items.
 */
export function Menu({ label, items, align = "right" }: { label: string; items: MenuItem[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
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
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          className={`absolute z-30 mt-1 min-w-36 rounded-md border border-border-strong bg-overlay py-1 shadow-lg ${align === "right" ? "right-0" : "left-0"}`}
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
        </div>
      )}
    </div>
  );
}
