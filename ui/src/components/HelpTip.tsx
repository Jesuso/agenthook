import { useId, useRef, useState } from "react";

/**
 * A "?" button with a help bubble that works by mouse, keyboard and touch — never hover-only.
 * Opens on mouse enter, keyboard focus and click/tap (a tap toggles); closes on Escape (focus
 * stays on the button), blur, and mouse leave unless a click/tap pinned it open. The bubble is
 * always in the DOM (`hidden` while closed) so `aria-describedby` — on the button, and on the
 * field's control when the caller passes the same `id` — always resolves. No portal: the bubble
 * is width-capped to fit a phone screen and wraps.
 */
export function HelpTip({ label, help, id }: { label: string; help: string; id?: string }) {
  const own = useId();
  const tipId = id ?? own;
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const close = () => {
    pinned.current = false;
    setOpen(false);
  };
  return (
    <span
      className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned.current) setOpen(false);
      }}
    >
      <button
        type="button"
        data-helptip
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        aria-describedby={tipId}
        className="inline-flex size-4 items-center justify-center rounded-full border border-[var(--color-border)] text-[10px] leading-none text-[var(--color-muted)] hover:text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-accent"
        onFocus={() => setOpen(true)}
        onBlur={close}
        onClick={() => {
          if (pinned.current) return close();
          pinned.current = true;
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !open) return;
          e.stopPropagation();
          close();
        }}
      >
        ?
      </button>
      <span
        role="tooltip"
        id={tipId}
        hidden={!open}
        className="absolute left-0 top-full z-30 mt-1 w-max max-w-[min(18rem,calc(100vw-2rem))] whitespace-normal break-words rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs font-normal normal-case tracking-normal text-[var(--color-fg)] shadow-lg"
      >
        {help}
      </span>
    </span>
  );
}
