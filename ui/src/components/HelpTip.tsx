import { useId, useLayoutEffect, useRef, useState } from "react";

/**
 * A "?" button with a help bubble that works by mouse, keyboard and touch — never hover-only.
 * Opens on mouse enter, keyboard focus and click/tap (a tap toggles); closes on Escape (focus
 * stays on the button), blur, and mouse leave unless a click/tap pinned it open. The bubble is
 * always in the DOM (`hidden` while closed) so `aria-describedby` — on the button, and on the
 * field's control when the caller passes the same `id` — always resolves. No portal: the bubble
 * is width-capped to fit a phone screen and wraps, and on open it is shifted sideways
 * (`tipShift`) so a "?" near either edge never pushes it past the viewport.
 */
/** How close the bubble may come to the viewport's edge, px. */
const TIP_MARGIN = 8;

/**
 * Pure: the bubble's `left` offset from its "?" (whose left edge is at `anchorLeft` in the
 * viewport) so a `width`-wide bubble stays `margin` px inside a `viewport`-wide screen — 0 (aligned
 * with the "?") when it already fits, negative to pull it left near the right edge.
 */
export function tipShift(anchorLeft: number, width: number, viewport: number, margin = TIP_MARGIN): number {
  const left = Math.max(margin, Math.min(anchorLeft, viewport - margin - width));
  return Math.round(left - anchorLeft);
}

export function HelpTip({ label, help, id }: { label: string; help: string; id?: string }) {
  const own = useId();
  const tipId = id ?? own;
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  // Measured before paint on every open: the bubble's width is its own (w-max, capped), not the position's.
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return;
    const viewport = document.documentElement.clientWidth || window.innerWidth;
    setShift(tipShift(anchor.current.getBoundingClientRect().left, tip.current.getBoundingClientRect().width, viewport));
  }, [open]);
  const close = () => {
    pinned.current = false;
    setOpen(false);
  };
  return (
    <span
      ref={anchor}
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
        className="inline-flex size-4 items-center justify-center rounded-full border border-[var(--color-border)] text-meta leading-none text-[var(--color-muted)] hover:text-[var(--color-fg)] focus-visible:outline-2 focus-visible:outline-accent"
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
        ref={tip}
        role="tooltip"
        id={tipId}
        hidden={!open}
        style={{ left: shift }}
        className="absolute left-0 top-full z-30 mt-1 w-max max-w-[min(18rem,calc(100vw-2rem))] whitespace-normal break-words rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs font-normal normal-case tracking-normal text-[var(--color-fg)] shadow-lg"
      >
        {help}
      </span>
    </span>
  );
}
