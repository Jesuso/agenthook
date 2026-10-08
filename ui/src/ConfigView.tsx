import { useEffect, useReducer, useRef, useState } from "react";
import { json } from "@codemirror/lang-json";
import type { ConfigView as ConfigBody, ProfileView } from "./contract";
import { isDirty } from "./instructions";
import { MarkdownEditor } from "./MarkdownEditor";
import { DiffView } from "./DiffView";
import { DiffLegend, Modal } from "./Modal";
import { classifySaveResponse, freshSave, saveErrorText, saveReducer } from "./save";
import type { SaveAction, SaveState } from "./save";
import {
  CONFIG_DISCARD_PROMPT,
  RESTART_IDLE,
  configEventAsFile,
  configSaveRequest,
  configUrl,
  parseCheck,
  restartReducer,
  restartRequest,
  restartText,
  sensitiveDiff,
} from "./config";
import type { ConfigSinkEvent, SensitiveChange } from "./config";

// The server's view of the file as of the last load / accepted save / 422 — the local parse check
// is live, this is not.
type Meta = { errors: string[]; literalSecrets: string[]; as: "load" | "save" | "rejected" };
type FileState = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; doc: SaveState; meta: Meta };

const JSON_LANG = json();
const OVERWRITE_PROMPT = "Overwrite the on-disk config with your buffer? The on-disk changes will be replaced (the previous content is kept as a backup).";
const META_LABEL: Record<Meta["as"], string> = { load: "as of last load", save: "as of last save", rejected: "save rejected" };

/**
 * The profile's raw `agenthook.config.json` in a JSON CodeMirror editor. Saves reuse the
 * Instructions flow (`save.ts`): diff → confirm (plus an explicit ack when SENSITIVE_FIELDS
 * change) → guarded `PUT /api/config`. A 200 offers "Restart when idle" (`POST /api/restart`),
 * whose banner follows `restartReducer` off SSE only. `eventSink` carries `config` events
 * (external edits) and feed `event`s (the restart lifecycle) from the parent's /api/stream.
 */
export default function ConfigView(props: {
  profiles: ProfileView[];
  eventSink: React.RefObject<((ev: ConfigSinkEvent) => void) | null>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [picked, setPicked] = useState(props.profiles[0]?.name ?? "");
  const profile = props.profiles.some((p) => p.name === picked) ? picked : (props.profiles[0]?.name ?? "");
  const profileView = props.profiles.find((p) => p.name === profile) ?? null;
  const [file, setFileState] = useState<FileState>({ kind: "loading" });
  // Remounts the editor on every load: fresh document, fresh undo history.
  const [editorKey, setEditorKey] = useState(0);
  const [diff, setDiff] = useState(false);
  const [ack, setAck] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [restart, dispatchRestart] = useReducer(restartReducer, RESTART_IDLE);
  const restartRef = useRef(restart);
  restartRef.current = restart;
  const [toast, setToast] = useState<string | null>(null);
  // Only the latest load may land. `fileRef`/`profileRef` are written with every update (not at
  // render), so async callbacks always see the newest state.
  const loadSeq = useRef(0);
  const fileRef = useRef(file);
  const setFile = (f: FileState) => {
    fileRef.current = f;
    setFileState(f);
  };
  const profileRef = useRef(profile);
  profileRef.current = profile;
  /** Apply a save action to the open config; returns the resulting state (null when none is open). */
  const act = (a: SaveAction): SaveState | null => {
    const f = fileRef.current;
    if (f.kind !== "ok") return null;
    const next = saveReducer(f.doc, a);
    if (next !== f.doc) setFile({ ...f, doc: next });
    return next;
  };
  /** Replace the panel's server view, if `prof` is still the open profile. */
  const setMeta = (prof: string, meta: Meta) => {
    const f = fileRef.current;
    if (f.kind === "ok" && f.doc.open.profile === prof) setFile({ ...f, meta });
  };
  const doc = file.kind === "ok" ? file.doc : null;
  const open = doc?.open ?? null;
  const phase = doc?.phase.kind ?? null;
  const dirty = doc ? isDirty(doc.buffer, doc.open) : false;
  const parsed = doc ? parseCheck(doc.buffer) : null;

  /** Load the profile's config. `silent` (an external edit on a clean buffer — the `stale` phase)
   *  keeps the current view while fetching, and lands only if still stale. */
  const load = (prof: string, silent = false) => {
    const seq = ++loadSeq.current;
    if (!silent) setFile({ kind: "loading" });
    const landable = () => {
      const f = fileRef.current;
      return seq === loadSeq.current && (!silent || (f.kind === "ok" && f.doc.phase.kind === "stale"));
    };
    fetch(configUrl(prof))
      .then((res) => {
        if (!landable()) return;
        if (!res.ok) return setFile({ kind: "error", status: res.status });
        return res.json().then((b: ConfigBody) => {
          if (!landable()) return;
          setFile({
            kind: "ok",
            doc: freshSave({ profile: prof, path: b.path, content: b.text, baseHash: b.hash }),
            meta: { errors: b.errors, literalSecrets: b.literalSecrets, as: "load" },
          });
          setEditorKey((k) => k + 1);
        });
      })
      .catch(() => {
        if (landable()) setFile({ kind: "error", status: 0 });
      });
  };

  useEffect(() => {
    if (profile) load(profile);
  }, [profile]);

  useEffect(() => {
    props.eventSink.current = (ev) => {
      if (ev.type === "event") {
        if (ev.profile === profileRef.current) dispatchRestart({ type: "event", event: ev.event });
        return;
      }
      const f = fileRef.current;
      if (f.kind === "ok") act({ type: "external", ev: configEventAsFile(ev, f.doc.open.path) });
    };
    return () => {
      props.eventSink.current = null;
    };
  });

  useEffect(() => {
    if (profileView) dispatchRestart({ type: "profile", profile: profileView });
  }, [profileView]);

  const staleHash = doc?.phase.kind === "stale" ? doc.phase.hash : null;
  useEffect(() => {
    if (staleHash !== null && open) load(open.profile, true);
  }, [staleHash]);

  /** Save button / Mod-s: opens the diff confirm on a dirty buffer that parses, else a no-op. */
  const requestSave = () => {
    const f = fileRef.current;
    if (f.kind === "ok" && parseCheck(f.doc.buffer).ok) act({ type: "save" });
  };

  /** PUT the buffer — `confirm` claims the loaded hash, `overwrite` the conflict's on-disk hash. */
  const put = (type: "confirm" | "overwrite") => {
    const s = act({ type });
    if (s?.phase.kind !== "saving") return;
    const { url, init } = configSaveRequest(s.open.profile, s.phase.base, s.phase.sent);
    const target = s.open;
    // A different profile opened meanwhile (discard confirmed) must not receive this result.
    const settle = (a: SaveAction) => {
      const f = fileRef.current;
      if (f.kind === "ok" && f.doc.open === target) act(a);
    };
    const fail = (status: number) => {
      settle({ type: "failed" });
      setToast(saveErrorText(status));
    };
    fetch(url, init)
      .then((res) => {
        const kind = classifySaveResponse(res.status);
        if (kind === "error") return fail(res.status);
        return res.json().then((b: { hash: string; text?: string; errors?: string[] }) => {
          if (kind === "conflict") return settle({ type: "conflict", hash: b.hash, content: b.text ?? "" });
          const f = fileRef.current;
          const secrets = f.kind === "ok" ? f.meta.literalSecrets : [];
          if (kind === "invalid") {
            // Nothing written: back to editing with the buffer kept and the server's errors shown.
            settle({ type: "failed" });
            return setMeta(target.profile, { errors: b.errors ?? [], literalSecrets: secrets, as: "rejected" });
          }
          settle({ type: "saved", hash: b.hash });
          setMeta(target.profile, { errors: [], literalSecrets: secrets, as: "save" });
          refreshMeta(target.profile, b.hash);
          setSavedNote(true);
          // A finished/failed restart's line no longer describes this save.
          const r = restartRef.current.kind;
          if (r === "up" || r === "error") dispatchRestart({ type: "reset" });
        });
      })
      .catch(() => fail(0));
  };

  /** After a save, re-read the server's literal-secret warnings for exactly what we saved. */
  const refreshMeta = (prof: string, hash: string) => {
    fetch(configUrl(prof))
      .then((res) => (res.ok ? res.json() : null))
      .then((b: ConfigBody | null) => {
        const f = fileRef.current;
        if (b && b.hash === hash && f.kind === "ok" && f.doc.open.baseHash === hash) setMeta(prof, { errors: b.errors, literalSecrets: b.literalSecrets, as: "save" });
      })
      .catch(() => {});
  };

  const overwrite = () => {
    if (doc?.phase.kind !== "conflict") return;
    const changes = sensitiveDiff(doc.phase.content ?? doc.open.content, doc.buffer);
    const note = changes.length ? `\n\nSensitive fields change:\n${changes.map((c) => `  ${c.path}: ${c.from} → ${c.to}`).join("\n")}` : "";
    if (window.confirm(OVERWRITE_PROMPT + note)) put("overwrite");
  };

  /** Diff on a conflict: the 409 carried the disk text; an SSE-raised one fetches it. */
  const showDiff = () => {
    setDiff(true);
    if (doc?.phase.kind !== "conflict" || doc.phase.content !== null) return;
    const target = doc.open;
    const settle = (a: SaveAction) => {
      const f = fileRef.current;
      if (f.kind === "ok" && f.doc.open === target) act(a);
    };
    fetch(configUrl(target.profile))
      .then((res) => {
        if (res.status === 404) return settle({ type: "disk", disk: null });
        if (!res.ok) return setToast(`Couldn't load the on-disk config (status ${res.status})`);
        return res.json().then((b: ConfigBody) => settle({ type: "disk", disk: { content: b.text, hash: b.hash } }));
      })
      .catch(() => setToast("Couldn't load the on-disk config (network error)"));
  };

  const requestRestart = () => {
    const prof = profile;
    dispatchRestart({ type: "request", pid: profileView?.pid ?? null });
    const { url, init } = restartRequest(prof);
    const settle = (status: number, body: any) => {
      if (profileRef.current === prof) dispatchRestart({ type: "response", status, body });
    };
    fetch(url, init)
      .then((res) =>
        res
          .json()
          .catch(() => null)
          .then((body) => settle(res.status, body)),
      )
      .catch(() => settle(0, null));
  };

  // Mod-s anywhere in the view (the editor's own binding stops propagation when it has focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      requestSave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (phase !== "conflict") setDiff(false);
    if (phase === "confirming") setAck(false);
  }, [phase]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    props.onDirtyChange(dirty);
  }, [dirty]);
  useEffect(() => () => props.onDirtyChange(false), []);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const pickProfile = (name: string) => {
    if (name === profile || (dirty && !window.confirm(CONFIG_DISCARD_PROMPT))) return;
    loadSeq.current++;
    setPicked(name);
    setSavedNote(false);
    dispatchRestart({ type: "reset" });
  };

  if (!props.profiles.length) return <p className="text-sm text-[var(--color-muted)]">No profiles.</p>;

  const sensitive: SensitiveChange[] = doc?.phase.kind === "confirming" ? sensitiveDiff(doc.open.content, doc.buffer) : [];
  const receiverUp = profileView?.up ?? false;
  const restartBusy = restart.kind === "requesting" || restart.kind === "pending" || restart.kind === "restarting";
  const restartLine = restartText(restart);

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-[24rem] flex-col">
      <div className="mb-3 flex items-center gap-3 text-sm">
        <select
          className="border border-[var(--color-border)] rounded px-1.5 py-0.5 bg-transparent"
          value={profile}
          onChange={(e) => pickProfile(e.target.value)}
        >
          {props.profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        {open && (
          <span className="truncate font-mono text-xs text-[var(--color-muted)]" title={open.path}>
            {open.path}
          </span>
        )}
        {phase === "saving" ? (
          <span className="shrink-0 text-[var(--color-muted)]">saving…</span>
        ) : (
          dirty && <span className="shrink-0 text-[var(--color-warn)]">● modified</span>
        )}
        {open && (
          <button
            className="ml-auto shrink-0 rounded border border-[var(--color-border)] px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!dirty || phase !== "editing" || !parsed?.ok}
            title={parsed && !parsed.ok ? "Fix the JSON first" : "Save (Ctrl/Cmd-S)"}
            onClick={requestSave}
          >
            Save
          </button>
        )}
      </div>
      {file.kind === "loading" && <p className="text-sm">Loading config…</p>}
      {file.kind === "error" && (
        <p className="text-sm text-[var(--color-err)]">
          {file.status === 404
            ? "This profile's receiver hasn't published a config path (start it once)."
            : `Failed to load the config (status ${file.status}).`}
        </p>
      )}
      {file.kind === "ok" && open && doc && (
        <>
          {savedNote && (
            <div className="mb-2 flex items-center gap-3 rounded border border-[var(--color-accent)] bg-[var(--color-accent)]/10 px-3 py-1.5 text-sm">
              <span>Saved — takes effect on restart.</span>
              {restartLine && (
                <span
                  className={
                    restart.kind === "error" ? "text-[var(--color-err)]" : restart.kind === "up" ? "text-[var(--color-ok)]" : "text-[var(--color-muted)]"
                  }
                >
                  {restartLine}
                </span>
              )}
              {!receiverUp && !restartBusy && <span className="text-[var(--color-muted)]">receiver not running; start it to apply</span>}
              <span className="ml-auto flex gap-2">
                <button
                  className="rounded border border-[var(--color-accent)] px-2 py-0.5 text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!receiverUp || restartBusy}
                  onClick={requestRestart}
                >
                  Restart when idle
                </button>
                <button aria-label="dismiss" onClick={() => setSavedNote(false)}>
                  ×
                </button>
              </span>
            </div>
          )}
          {(phase === "conflict" || phase === "deleted") && (
            <div className="mb-2 flex items-center gap-3 rounded border border-[var(--color-warn)] bg-[var(--color-warn)]/10 px-3 py-1.5 text-sm text-[var(--color-warn)]">
              {phase === "deleted" ? "deleted on disk" : "changed on disk"} — your edits are based on an older version.
              <span className="ml-auto flex gap-2">
                <button className="rounded border border-[var(--color-warn)] px-2 py-0.5" onClick={() => load(open.profile)}>
                  Reload
                </button>
                {phase === "conflict" && (
                  <>
                    <button className="rounded border border-[var(--color-warn)] px-2 py-0.5" onClick={showDiff}>
                      Diff
                    </button>
                    <button className="rounded border border-[var(--color-warn)] px-2 py-0.5" onClick={overwrite}>
                      Overwrite
                    </button>
                  </>
                )}
              </span>
            </div>
          )}
          {file.meta.literalSecrets.length > 0 && (
            <div className="mb-2 rounded border border-[var(--color-warn)] bg-[var(--color-warn)]/10 px-3 py-1.5 text-sm text-[var(--color-warn)]">
              ⚠ Literal secret{file.meta.literalSecrets.length === 1 ? "" : "s"} in{" "}
              <span className="font-mono">{file.meta.literalSecrets.join(", ")}</span> — prefer a <span className="font-mono">{"${VAR}"}</span> ref
              (saving is still allowed).
            </div>
          )}
          <div className="flex min-h-0 flex-1 gap-3">
            <div className="min-w-0 flex-1">
              <MarkdownEditor
                key={editorKey}
                initial={open.content}
                language={JSON_LANG}
                onChange={(buffer) => act({ type: "edit", buffer })}
                onSave={requestSave}
              />
            </div>
            <aside className="w-80 shrink-0 overflow-auto text-sm">
              <h3 className="mb-1 text-xs uppercase tracking-wide text-[var(--color-muted)]">validation</h3>
              {parsed?.ok ? (
                <p className="mb-2 text-[var(--color-ok)]">JSON parses.</p>
              ) : (
                <p className="mb-2 break-words font-mono text-xs text-[var(--color-err)]">{parsed?.error}</p>
              )}
              <h4 className="mb-1 text-xs text-[var(--color-muted)]">server ({META_LABEL[file.meta.as]})</h4>
              {file.meta.errors.length === 0 ? (
                <p className="text-[var(--color-ok)]">valid</p>
              ) : (
                <ul className="list-disc space-y-1 pl-4 text-[var(--color-err)]">
                  {file.meta.errors.map((e, i) => (
                    <li key={i} className="break-words">
                      {e}
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          </div>
        </>
      )}
      {doc?.phase.kind === "confirming" && (
        <Modal title="Save agenthook.config.json?" onClose={() => act({ type: "cancel" })}>
          <p className="mb-2 text-sm text-[var(--color-muted)]">The receiver reads its config at boot — this takes effect on restart.</p>
          {sensitive.length > 0 && (
            <div className="mb-2 rounded border border-[var(--color-warn)] bg-[var(--color-warn)]/10 px-3 py-2 text-sm text-[var(--color-warn)]">
              <p className="mb-1 font-semibold">Sensitive fields change:</p>
              <ul className="mb-2 font-mono text-xs">
                {sensitive.map((c) => (
                  <li key={c.path}>
                    {c.path}: {c.from} → {c.to}
                  </li>
                ))}
              </ul>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I understand these sensitive fields change
              </label>
            </div>
          )}
          <DiffLegend />
          <DiffView a={doc.open.content} b={doc.buffer} language={JSON_LANG} />
          <div className="mt-3 flex justify-end gap-2">
            <button className="rounded border border-[var(--color-border)] px-3 py-1" onClick={() => act({ type: "cancel" })}>
              Cancel
            </button>
            <button
              className="rounded border border-[var(--color-accent)] px-3 py-1 text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={sensitive.length > 0 && !ack}
              onClick={() => put("confirm")}
            >
              Save
            </button>
          </div>
        </Modal>
      )}
      {diff && doc?.phase.kind === "conflict" && (
        <Modal title="agenthook.config.json changed on disk" onClose={() => setDiff(false)}>
          <DiffLegend />
          {doc.phase.content === null ? (
            <p className="text-sm">Loading the on-disk version…</p>
          ) : (
            <DiffView a={doc.phase.content} b={doc.buffer} language={JSON_LANG} />
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button className="rounded border border-[var(--color-border)] px-3 py-1" onClick={() => setDiff(false)}>
              Close
            </button>
            <button className="rounded border border-[var(--color-warn)] px-3 py-1 text-[var(--color-warn)]" onClick={overwrite}>
              Overwrite
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div role="alert" className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded border border-[var(--color-err)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-err)] shadow">
          {toast}
          <button aria-label="dismiss" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
