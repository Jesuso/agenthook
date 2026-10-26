import { useEffect, useState } from "react";
import type { RemovePreview } from "./contract";
import { Modal } from "./Modal";
import { rich, useT } from "./i18n/react";
import { canConfirmRemove, classifyRemoveResponse, removeErrorText, removeRequest } from "./remove";

export type Archived = { archivedTo: string; webhookHint: string | null };

/**
 * The Remove… modal for one profile row: fetches `/api/profile/remove-preview`, then POSTs
 * `/api/profile/remove`. 200 → `onArchived`, 202 → `onPending` (App tracks the pending row);
 * anything else stays open with the error inline.
 */
export function RemoveProfile(props: { profile: string; onClose: () => void; onArchived: (r: Archived) => void; onPending: () => void }) {
  const { t, lang } = useT();
  const [preview, setPreview] = useState<RemovePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [unregister, setUnregister] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/profile/remove-preview?profile=${encodeURIComponent(props.profile)}`)
      .then((res) => (res.ok ? res.json().then((p: RemovePreview) => live && setPreview(p)) : live && setLoadError(t("removeDialog.loadFailed", { status: res.status }))))
      .catch(() => live && setLoadError(t("removeDialog.loadNetwork")));
    return () => {
      live = false;
    };
  }, [props.profile]);

  const submit = () => {
    if (!preview || busy || !canConfirmRemove(typed, preview.label)) return;
    setBusy(true);
    setError(null);
    const { url, init } = removeRequest(preview.profile, unregister);
    fetch(url, init)
      .then((res) => res.json().catch(() => null).then((body) => ({ status: res.status, body })))
      .catch(() => ({ status: 0, body: null }))
      .then(({ status, body }) => {
        setBusy(false);
        const kind = classifyRemoveResponse(status);
        if (kind === "archived") return props.onArchived({ archivedTo: body?.archivedTo ?? "", webhookHint: body?.webhookHint ?? null });
        if (kind === "pending") return props.onPending();
        setError(removeErrorText(status, body, lang));
      });
  };

  return (
    <Modal title={t("removeDialog.title", { label: preview?.label ?? props.profile })} onClose={props.onClose}>
      {loadError ? (
        <p className="text-sm text-[var(--color-err)]">{loadError}</p>
      ) : !preview ? (
        <p className="text-sm">{t("removeDialog.loading")}</p>
      ) : (
        <RemoveProfileForm
          preview={preview}
          typed={typed}
          onType={setTyped}
          unregister={unregister}
          onUnregister={setUnregister}
          busy={busy}
          error={error}
          onSubmit={submit}
          onCancel={props.onClose}
        />
      )}
    </Modal>
  );
}

/** The modal body — stateless (only the i18n context), so it renders (and is tested) without a DOM. */
export function RemoveProfileForm(props: {
  preview: RemovePreview;
  typed: string;
  onType: (v: string) => void;
  unregister: boolean;
  onUnregister: (v: boolean) => void;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const p = props.preview;
  const ok = canConfirmRemove(props.typed, p.label);
  const code = (text: string) => <code className="font-mono">{text}</code>;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>{t(p.up ? "removeDialog.up" : "removeDialog.down")}</p>
      <ul className="list-disc pl-5">
        <li>{rich(t("removeDialog.stateDir"), { pattern: code(p.archivePattern) })}</li>
        <li>{rich(t("removeDialog.configKept"), { path: code(p.configPath ?? t("removeDialog.unknown")) })}</li>
        <li>
          {p.up
            ? t("removeDialog.webhooksUp")
            : p.webhookHint
              ? rich(t("removeDialog.webhooksHint"), { cmd: code(p.webhookHint) })
              : t("removeDialog.webhooksNoHint")}
        </li>
        <li>{rich(t("removeDialog.worktrees"), { cmd: code("agenthook cleanup") })}</li>
      </ul>
      {p.up && (
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={props.unregister} onChange={(e) => props.onUnregister(e.target.checked)} />
          {t("removeDialog.unregister")}
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span>{rich(t("removeDialog.typeToConfirm"), { label: code(p.label) })}</span>
        <input
          className="rounded border border-[var(--color-border)] bg-transparent px-1.5 py-0.5 font-mono"
          value={props.typed}
          onChange={(e) => props.onType(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && props.onSubmit()}
          autoFocus
        />
      </label>
      {props.error && (
        <p role="alert" className="text-[var(--color-err)]">
          {props.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button className="rounded border border-[var(--color-border)] px-3 py-1" onClick={props.onCancel}>
          {t("removeDialog.cancel")}
        </button>
        <button
          className="rounded border border-[var(--color-err)] px-3 py-1 text-[var(--color-err)] disabled:opacity-40"
          disabled={!ok || props.busy}
          onClick={props.onSubmit}
        >
          {props.busy ? t("removeDialog.removing") : t("removeDialog.remove")}
        </button>
      </div>
    </div>
  );
}
