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

/** Minimal overlay dialog; Escape closes it (unless a dialog above it takes the key). */
export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEscape(props.onClose);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div role="dialog" aria-modal="true" className="flex max-h-full w-full max-w-5xl flex-col rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <h2 className="mb-2 font-semibold">{props.title}</h2>
        {props.children}
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

/**
 * The in-app "are you sure?" (replaces `window.confirm`). Opens focused on Cancel, traps Tab,
 * Escape / a backdrop click cancel, and focus returns to whatever had it on close.
 */
export function ConfirmModal(props: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEscape(props.onCancel);
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    return () => {
      if (prev?.isConnected) prev.focus();
    };
  }, []);
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = box.current.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div
        ref={box}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={props.body ? `${id}-body` : undefined}
        onKeyDown={trapTab}
        className="w-full max-w-md rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-4"
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
