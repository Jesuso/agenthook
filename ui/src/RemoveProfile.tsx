import { useEffect, useState } from "react";
import type { RemovePreview } from "./contract";
import { Modal } from "./Modal";
import { canConfirmRemove, classifyRemoveResponse, removeErrorText, removeRequest } from "./remove";

export type Archived = { archivedTo: string; webhookHint: string | null };

/**
 * The Remove… modal for one profile row: fetches `/api/profile/remove-preview`, then POSTs
 * `/api/profile/remove`. 200 → `onArchived`, 202 → `onPending` (App tracks the pending row);
 * anything else stays open with the error inline.
 */
export function RemoveProfile(props: { profile: string; onClose: () => void; onArchived: (r: Archived) => void; onPending: () => void }) {
  const [preview, setPreview] = useState<RemovePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [unregister, setUnregister] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/profile/remove-preview?profile=${encodeURIComponent(props.profile)}`)
      .then((res) => (res.ok ? res.json().then((p: RemovePreview) => live && setPreview(p)) : live && setLoadError(`Couldn't load the profile (status ${res.status})`)))
      .catch(() => live && setLoadError("Couldn't load the profile (network error)"));
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
        setError(removeErrorText(status, body));
      });
  };

  return (
    <Modal title={`Remove ${preview?.label ?? props.profile}`} onClose={props.onClose}>
      {loadError ? (
        <p className="text-sm text-[var(--color-err)]">{loadError}</p>
      ) : !preview ? (
        <p className="text-sm">Loading…</p>
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

/** The modal body — hook-free, so it renders (and is tested) without a DOM. */
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
  const p = props.preview;
  const ok = canConfirmRemove(props.typed, p.label);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        {p.up ? "The receiver is running: it finishes its running agents, then stops and archives itself." : "The receiver is stopped: its state dir is archived now."}
      </p>
      <ul className="list-disc pl-5">
        <li>
          The state dir (history, dedup, logs, webhook secrets) moves to <code className="font-mono">{p.archivePattern}</code>. Reversible —
          move the dir back.
        </li>
        <li>
          The config file is not touched: <code className="font-mono">{p.configPath ?? "unknown"}</code>.
        </li>
        <li>
          Webhooks:{" "}
          {p.up ? (
            "unregistered by the receiver before it exits (when checked below)."
          ) : p.webhookHint ? (
            <>
              can't be unregistered without the receiver; run <code className="font-mono">{p.webhookHint}</code> (or skip if it never registered).
            </>
          ) : (
            "can't be unregistered without the receiver; run `agenthook unregister` with this profile's config (or skip if it never registered)."
          )}
        </li>
        <li>
          Agent worktrees are not touched — run <code className="font-mono">agenthook cleanup</code> in the repo.
        </li>
      </ul>
      {p.up && (
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={props.unregister} onChange={(e) => props.onUnregister(e.target.checked)} />
          Unregister webhooks
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span>
          Type <code className="font-mono">{p.label}</code> to confirm
        </span>
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
          Cancel
        </button>
        <button
          className="rounded border border-[var(--color-err)] px-3 py-1 text-[var(--color-err)] disabled:opacity-40"
          disabled={!ok || props.busy}
          onClick={props.onSubmit}
        >
          {props.busy ? "Removing…" : "Remove"}
        </button>
      </div>
    </div>
  );
}
