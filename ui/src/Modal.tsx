import { useEffect, useRef } from "react";

// Shared by the Instructions and Config editors.

export function DiffLegend() {
  return (
    <div className="mb-1 flex text-xs text-[var(--color-muted)]">
      <span className="flex-1">on disk</span>
      <span className="flex-1">your buffer</span>
    </div>
  );
}

/** Minimal overlay dialog; Escape closes it. */
export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode }) {
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div role="dialog" aria-modal="true" className="flex max-h-full w-full max-w-5xl flex-col rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <h2 className="mb-2 font-semibold">{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}
