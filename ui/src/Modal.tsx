import { createContext, useCallback, useEffect, useId, useRef, useState } from "react";

// Shared by the Instructions and Config editors.

export function DiffLegend() {
  return (
    <div className="mb-1 flex text-xs text-[var(--color-muted)]">
      <span className="flex-1">on disk</span>
      <span className="flex-1">your buffer</span>
    </div>
  );
}

// Open dialogs, bottom → top. One window listener hands Escape to the topmost only, so a confirm
// opened over a Modal closes alone.
const escapeStack: Array<{ current: () => void }> = [];
const onEscapeKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") escapeStack.at(-1)?.current();
};

function useEscape(onEscape: () => void) {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  useEffect(() => {
    if (!escapeStack.length) window.addEventListener("keydown", onEscapeKey);
    escapeStack.push(cb);
    return () => {
      escapeStack.splice(escapeStack.lastIndexOf(cb), 1);
      if (!escapeStack.length) window.removeEventListener("keydown", onEscapeKey);
    };
  }, []);
}

/**
 * Minimal overlay dialog, named by its title. Opens with focus on the dialog, keeps Tab inside,
 * closes on Escape (unless a dialog above it takes the key), the backdrop or Close, and hands focus
 * back to whatever had it.
 */
export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEscape(props.onClose);
  useReturnFocus(() => box.current?.focus());
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-2 sm:p-6" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onKeyDown={(e) => trapTab(e, box.current)}
        className="flex max-h-full w-full min-w-0 max-w-5xl flex-col rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 outline-none sm:p-4"
      >
        <div className="mb-2 flex items-start gap-2">
          <h2 id={`${id}-title`} className="min-w-0 flex-1 break-words font-semibold">
            {props.title}
          </h2>
          <button type="button" data-modal-close className="shrink-0 rounded-md px-2 py-0.5 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent" onClick={props.onClose}>
            Close
          </button>
        </div>
        {/* The body scrolls inside the dialog; a DiffView (flex-1, min-h-0) shrinks and scrolls in its own box first. */}
        <div data-modal-body className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
          {props.children}
        </div>
      </div>
    </div>
  );
}

export type ConfirmOptions = {
  title: string;
  body?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Failure styling on the confirm button (removals, discards, overwrites). */
  destructive?: boolean;
};

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Focus `into` the dialog on open; on close, back to whatever had focus before. */
function useReturnFocus(into: () => void) {
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    into();
    return () => {
      if (prev?.isConnected) prev.focus();
    };
  }, []);
}

/** Keep Tab cycling inside `box`. */
function trapTab(e: React.KeyboardEvent, box: HTMLElement | null) {
  if (e.key !== "Tab" || !box) return;
  const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const inside = box.contains(active) && active !== box;
  if (e.shiftKey && (active === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * The in-app "are you sure?" (replaces `window.confirm`). Opens focused on Cancel, traps Tab,
 * Escape / a backdrop click cancel, and focus returns to whatever had it on close.
 */
export function ConfirmModal(props: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEscape(props.onCancel);
  useReturnFocus(() => cancel.current?.focus());
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-6" onClick={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div
        ref={box}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={props.body ? `${id}-body` : undefined}
        onKeyDown={(e) => trapTab(e, box.current)}
        className="max-h-full w-full max-w-md overflow-auto break-words rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
      >
        <h2 id={`${id}-title`} className="mb-2 font-semibold">
          {props.title}
        </h2>
        {props.body && (
          <div id={`${id}-body`} className="text-sm">
            {props.body}
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button ref={cancel} data-confirm-cancel className="rounded border border-[var(--color-border)] px-3 py-1" onClick={props.onCancel}>
            {props.cancelLabel ?? "Cancel"}
          </button>
          <button
            data-confirm-ok
            className={`rounded border px-3 py-1 ${props.destructive ? "border-status-failed text-status-failed" : "border-[var(--color-accent)] text-[var(--color-accent)]"}`}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Opens a ConfirmModal; resolves true on confirm, false on cancel (or when a newer ask replaces it). */
export type Ask = (opts: ConfirmOptions) => Promise<boolean>;

/** `[ask, element]` — render `element` once per view; call sites read `ask({...}).then((ok) => ok && doIt())`. */
export function useConfirm(): [Ask, React.ReactNode] {
  // `n` keys the modal so a replacing ask mounts fresh (initial focus again).
  const [open, setOpen] = useState<{ opts: ConfirmOptions; n: number } | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const ask = useCallback<Ask>((opts) => {
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpen((o) => ({ opts, n: (o?.n ?? 0) + 1 }));
    });
  }, []);
  const settle = (ok: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setOpen(null);
    resolve?.(ok);
  };
  const element = open ? <ConfirmModal key={open.n} {...open.opts} onConfirm={() => settle(true)} onCancel={() => settle(false)} /> : null;
  return [ask, element];
}

/** The asker for nested forms (Config's remove buttons), provided by the view that renders the element. */
export const ConfirmContext = createContext<Ask>(() => Promise.reject(new Error("no ConfirmContext provider")));

/** A provider with its own modal — for a form rendered outside a view (tests). */
export function ConfirmProvider(props: { children: React.ReactNode }) {
  const [ask, element] = useConfirm();
  return (
    <ConfirmContext.Provider value={ask}>
      {props.children}
      {element}
    </ConfirmContext.Provider>
  );
}
