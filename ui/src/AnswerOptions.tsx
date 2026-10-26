import { useState } from "react";
import { useT } from "./i18n/react";

const OPTION = "block w-full rounded border border-border bg-surface px-2 py-1 text-left text-body text-fg hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
const CONFIRM_BTN = "rounded-md bg-accent px-3 py-1 text-label font-medium text-accent-fg disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent";
const QUIET_BTN = "rounded px-1.5 py-0.5 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent";

/**
 * A held ticket's 2-4 short answers, click-to-pick with a confirm step: picking an option never
 * sends it by itself — only Confirm does, calling `onSend` with the exact text shown; Cancel goes
 * back to the list without sending anything. Shared by `ReleasePanel` and `TicketDrawer` so the
 * two can't drift apart. `options` is agent-authored — rendered as plain prose, never interpreted.
 * Busy/error handling (and what happens on success) is the caller's — this component only picks.
 */
export function AnswerOptions({ options, busy, onSend }: { options: string[]; busy: boolean; onSend: (comment: string) => void }) {
  const { t } = useT();
  const [picked, setPicked] = useState<string | null>(null);
  if (picked !== null) {
    return (
      <div data-answer-confirm className="flex flex-col gap-2">
        <p className="text-body text-fg">
          {t("release.sendAnswer")} <span className="font-medium">«{picked}»</span>
        </p>
        <div className="flex items-center gap-2">
          <button type="button" data-answer-confirm-send disabled={busy} onClick={() => onSend(picked)} className={CONFIRM_BTN}>
            {busy ? t("release.releasing") : t("release.confirm")}
          </button>
          <button type="button" disabled={busy} onClick={() => setPicked(null)} className={QUIET_BTN}>
            {t("release.cancel")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div data-answer-options className="flex flex-col gap-1.5">
      {options.map((o) => (
        <button key={o} type="button" disabled={busy} onClick={() => setPicked(o)} className={OPTION}>
          {o}
        </button>
      ))}
    </div>
  );
}
