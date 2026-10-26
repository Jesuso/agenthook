import { useState } from "react";
import type { TicketRow } from "./contract";
import type { ReleaseOutcome } from "./config";
import { useT } from "./i18n/react";
import { AnswerOptions } from "./AnswerOptions";

const LINK = "rounded px-1.5 py-0.5 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent";

/** The inline answer form under a held row: pick-an-option buttons (when the agent offered any),
 * then an optional free-text comment for the agent, then Release. */
export function ReleasePanel({ ticket: t, onRelease, onClose }: { ticket: TicketRow; onRelease: (t: { profile: string; ref: string }, comment: string) => Promise<ReleaseOutcome>; onClose: () => void }) {
  const { t: tr } = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (comment: string) => {
    setBusy(true);
    setError(null);
    const out = await onRelease({ profile: t.profile, ref: t.ref }, comment);
    if (out.ok) return onClose();
    setBusy(false);
    setError(out.error);
  };
  const submit = () => send(text);
  return (
    <div data-release-panel={t.ref} className="flex flex-col gap-2 border-t border-border-subtle bg-surface-raised px-3 py-3">
      {t.options && t.options.length > 0 && <AnswerOptions options={t.options} busy={busy} onSend={send} />}
      <label className="flex flex-col gap-1 text-label text-muted">
        {t.step != null ? tr("release.answerStep", { step: t.step }) : tr("release.answer")}
        <textarea
          autoFocus
          rows={3}
          maxLength={8000}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) void submit();
          }}
          className="rounded border border-border bg-surface px-2 py-1 text-body text-fg focus-visible:outline-2 focus-visible:outline-accent"
        />
      </label>
      {error && (
        <p role="alert" className="text-label text-status-failed">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={() => void submit()} className="rounded-md bg-accent px-3 py-1 text-label font-medium text-accent-fg disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent">
          {busy ? tr("release.releasing") : tr("release.release")}
        </button>
        <button type="button" disabled={busy} onClick={onClose} className={LINK}>
          {tr("release.cancel")}
        </button>
        <span className="ml-auto text-meta text-muted">{tr("release.hint")}</span>
      </div>
    </div>
  );
}
