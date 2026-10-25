import { useState } from "react";
import { Modal } from "../Modal";
import { setShortcutsEnabled, shortcutsEnabled } from "../shortcuts";

/** The "?" button that opens a view's shortcut sheet: the way back in when the keys are off. */
export function ShortcutsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-shortcuts-open
      aria-label="Keyboard shortcuts"
      aria-keyshortcuts="?"
      title="Keyboard shortcuts (?)"
      className="rounded-md px-2 py-1 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      onClick={onClick}
    >
      ?
    </button>
  );
}

/** A view's keyboard shortcuts, with the switch that turns all single-key shortcuts off. */
export function ShortcutSheet({ rows, onClose }: { rows: { keys: string; what: string }[]; onClose: () => void }) {
  const [on, setOn] = useState(shortcutsEnabled);
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <label className="mb-3 flex items-center gap-2 text-body">
        <input
          type="checkbox"
          data-shortcuts-toggle
          checked={on}
          onChange={(e) => {
            setShortcutsEnabled(e.target.checked);
            setOn(e.target.checked);
          }}
          className="size-4 accent-[var(--color-accent)]"
        />
        Single-key shortcuts on
      </label>
      <dl data-shortcuts className={`grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body ${on ? "" : "opacity-60"}`}>
        {rows.map((s) => (
          <div key={s.keys} className="contents">
            <dt>
              <kbd className="rounded-sm border border-border bg-surface-raised px-1.5 font-mono text-label">{s.keys}</kbd>
            </dt>
            <dd className="text-muted">{s.what}</dd>
          </div>
        ))}
      </dl>
      {!on && <p className="mt-3 text-label text-muted">Off: single keys do nothing. The ? button still opens this list.</p>}
    </Modal>
  );
}
