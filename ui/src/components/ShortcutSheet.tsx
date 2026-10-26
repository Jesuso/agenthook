import { useState } from "react";
import { Modal } from "../Modal";
import { setShortcutsEnabled, shortcutsEnabled } from "../shortcuts";
import { useT } from "../i18n/react";

/** The "?" button that opens a view's shortcut sheet: the way back in when the keys are off. */
export function ShortcutsButton({ onClick }: { onClick: () => void }) {
  const { t } = useT();
  return (
    <button
      type="button"
      data-shortcuts-open
      aria-label={t("shortcuts.button")}
      aria-keyshortcuts="?"
      title={t("shortcuts.buttonTitle")}
      className="rounded-md px-2 py-1 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      onClick={onClick}
    >
      ?
    </button>
  );
}

/** A view's keyboard shortcuts, with the switch that turns all single-key shortcuts off. */
export function ShortcutSheet({ rows, onClose }: { rows: { keys: string; what: string }[]; onClose: () => void }) {
  const { t } = useT();
  const [on, setOn] = useState(shortcutsEnabled);
  return (
    <Modal title={t("shortcuts.title")} onClose={onClose}>
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
        {t("shortcuts.toggle")}
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
      {!on && <p className="mt-3 text-label text-muted">{t("shortcuts.off")}</p>}
    </Modal>
  );
}
