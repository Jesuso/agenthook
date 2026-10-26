import { useT } from "../i18n/react";

/**
 * The one disclosure control on the Overview (All tickets, History, the stale digest, Activity): a
 * bordered "Show" / "Hide" button that says what it controls to assistive tech.
 */
export function ShowHide({ open, onToggle, controls, label, ...data }: { open: boolean; onToggle: () => void; controls?: string; label: string } & Record<`data-${string}`, string | boolean>) {
  const { t } = useT();
  return (
    <button
      type="button"
      {...data}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={t(open ? "showHide.hideLabel" : "showHide.showLabel", { label })}
      onClick={onToggle}
      className="rounded-md border border-border px-2 py-0.5 text-label hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:px-3 pointer-coarse:py-2"
    >
      {t(open ? "showHide.hide" : "showHide.show")}
    </button>
  );
}
