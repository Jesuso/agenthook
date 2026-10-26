import { useEffect, useId, useRef, useState } from "react";
import { IconButton } from "./IconButton";
import { Segmented } from "./Segmented";
import { READING_SETTINGS, readingDefaults, setReading } from "../reading";
import { useReading } from "../useReading";

/**
 * The app bar's `Aa` reading settings (#559): a non-modal popover with one segmented control per
 * `READING_SETTINGS` entry and a Reset. A change goes through the shared store (`setReading`): it is
 * persisted, applied to <html> and seen at once by every `useReading()`, the read-aloud buttons too.
 * Escape or an outside click closes it (Escape returns focus to the trigger), as in Menu. While
 * it is open its `role="dialog"` holds off the Overview / Epics single-key shortcuts.
 */
export function ReadingPanel() {
  const [open, setOpen] = useState(false);
  const values = useReading();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    // The first setting's chosen option; a selector list would match the first button in document order.
    (panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? panel.current?.querySelector<HTMLButtonElement>("button"))?.focus();
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || !open) return;
    e.stopPropagation();
    setOpen(false);
    trigger.current?.focus();
  };

  const change = (key: string, value: string) => setReading({ ...values, [key]: value });

  return (
    <div ref={root} className="relative inline-block" onKeyDown={onKeyDown}>
      <IconButton
        ref={trigger}
        label="Reading settings"
        aria-expanded={open}
        aria-controls={id}
        data-reading-trigger
        className="text-label font-semibold"
        onClick={() => setOpen((o) => !o)}
      >
        Aa
      </IconButton>
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label="Reading settings"
          data-reading-panel
          className="absolute right-0 z-30 mt-1 flex w-max flex-col gap-3 rounded-md border border-border-strong bg-overlay p-3 shadow-lg"
        >
          {/* A row the browser can't support is left out; one whose `requires` is unmet is disabled. */}
          {READING_SETTINGS.filter((s) => s.available?.() ?? true).map((s) => (
            <div key={s.key} className="flex flex-col gap-1">
              <span aria-hidden="true" className="text-label text-muted">
                {s.label}
              </span>
              <Segmented
                label={s.label}
                value={values[s.key]}
                options={s.options}
                disabled={!!s.requires && values[s.requires.key] !== s.requires.value}
                onChange={(v) => change(s.key, v)}
              />
            </div>
          ))}
          <button
            type="button"
            data-reading-reset
            className="self-start rounded-md px-2 py-1 text-label font-medium text-muted hover:bg-surface-raised hover:text-fg"
            onClick={() => setReading(readingDefaults())}
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}
