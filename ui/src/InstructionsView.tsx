import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { InstructionsView as InstructionsBody, ProfileView } from "./contract";
import { baseName, discardPrompt, formatBytes, groupFiles, initialFile, instructionFileUrl, instructionsUrl, isDirty } from "./instructions";
import type { InstructionsEvent } from "./instructions";
import { profileLabel } from "./format";
import { MarkdownEditor } from "./MarkdownEditor";
import { DiffView } from "./DiffView";
import { DiffLegend, Modal, useConfirm } from "./Modal";
import { PromptPreview } from "./PromptPreview";
import { classifySaveResponse, freshSave, liveEffectNote, saveErrorText, saveReducer, saveRequest } from "./save";
import type { SaveAction, SaveState } from "./save";
import { EmptyState, FullAutoShield, Pill, Segmented } from "./components";
import { useT } from "./i18n/react";

type ListState = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; body: InstructionsBody };
type FileState = { kind: "none" } | { kind: "loading"; path: string } | { kind: "error"; path: string; status: number } | { kind: "ok"; doc: SaveState };
type Side = "none" | "preview" | "agent";
type Toast = { kind: "error" | "ok"; text: string };

/** `localStorage` key for the last file opened in a profile, so re-opening the tab lands there. */
const lastFileKey = (profile: string) => `ah.instructions.last:${profile}`;


/**
 * Per-profile standing-instruction files and a CodeMirror editor over one of them. Saves go
 * through a diff-first confirm (`save.ts` holds the state machine). External edits arrive as SSE
 * `instructions` events through `eventSink` — the parent forwards them off the existing
 * /api/stream, no polling.
 */
export default function InstructionsView(props: {
  profiles: ProfileView[];
  eventSink: React.RefObject<((ev: InstructionsEvent) => void) | null>;
  onDirtyChange: (dirty: boolean) => void;
  /** The profile to open on (the dashboard's ⋯ menu); falls back to the first one. */
  initialProfile?: string;
}) {
  const { t, lang } = useT();
  const [picked, setPicked] = useState(props.initialProfile ?? props.profiles[0]?.name ?? "");
  const profile = props.profiles.some((p) => p.name === picked) ? picked : (props.profiles[0]?.name ?? "");
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [listNonce, setListNonce] = useState(0);
  const [file, setFileState] = useState<FileState>({ kind: "none" });
  // Remounts the editor on every load: fresh document, fresh undo history.
  const [editorKey, setEditorKey] = useState(0);
  const [side, setSide] = useState<Side>("none");
  const [diff, setDiff] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  // The last successful save, so a glance at the toolbar confirms it landed after the toast fades.
  const [savedAt, setSavedAt] = useState<{ path: string; at: Date } | null>(null);
  const [ask, confirmModal] = useConfirm();
  // Only the latest file load may land. `fileRef` is written with every update (not at render),
  // so async callbacks and chained actions always see the newest state.
  const loadSeq = useRef(0);
  const fileRef = useRef(file);
  const setFile = (f: FileState) => {
    fileRef.current = f;
    setFileState(f);
  };
  /** Apply a save action to the open file; returns the resulting state (null when none is open). */
  const act = (a: SaveAction): SaveState | null => {
    const f = fileRef.current;
    if (f.kind !== "ok") return null;
    const next = saveReducer(f.doc, a);
    if (next !== f.doc) setFile({ kind: "ok", doc: next });
    return next;
  };
  const doc = file.kind === "ok" ? file.doc : null;
  const open = doc?.open ?? null;
  const phase = doc?.phase.kind ?? null;
  const dirty = doc ? isDirty(doc.buffer, doc.open) : false;
  const openFileView = open && list.kind === "ok" ? list.body.files.find((f) => f.path === open.path) : undefined;
  const agentsRunning = openFileView?.agentsRunning || 0;

  useEffect(() => {
    if (!profile) return;
    let live = true;
    fetch(instructionsUrl(profile))
      .then((res) =>
        res.ok
          ? res.json().then((body: InstructionsBody) => live && setList({ kind: "ok", body }))
          : live && setList({ kind: "error", status: res.status }),
      )
      .catch(() => live && setList({ kind: "error", status: 0 }));
    return () => {
      live = false;
    };
  }, [profile, listNonce]);

  /** Load `path` into the editor. `silent` (an external edit on a clean buffer — the `stale`
   *  phase) keeps the current view while fetching, and lands only if still stale: typing
   *  meanwhile has already turned it into the conflict banner. */
  const load = (prof: string, path: string, silent = false) => {
    const seq = ++loadSeq.current;
    if (!silent) setFile({ kind: "loading", path });
    const landable = () => {
      const f = fileRef.current;
      return seq === loadSeq.current && (!silent || (f.kind === "ok" && f.doc.phase.kind === "stale"));
    };
    fetch(instructionFileUrl(prof, path))
      .then((res) => {
        if (!landable()) return;
        if (!res.ok) return setFile({ kind: "error", path, status: res.status });
        return res.json().then((b: { content: string; hash: string }) => {
          if (!landable()) return;
          setFile({ kind: "ok", doc: freshSave({ profile: prof, path, content: b.content, baseHash: b.hash }) });
          setEditorKey((k) => k + 1);
          try {
            localStorage.setItem(lastFileKey(prof), path);
          } catch {
            /* unavailable (private mode, quota) — just skip remembering */
          }
        });
      })
      .catch(() => {
        if (landable()) setFile({ kind: "error", path, status: 0 });
      });
  };

  /** Auto-open once a profile's list first lands. Guarded on `fileRef` (not `file`) so an
   *  SSE-driven re-fetch (same list, new object, bumped `listNonce`) never re-triggers this once
   *  a file is already open. */
  useEffect(() => {
    if (list.kind !== "ok" || fileRef.current.kind !== "none") return;
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(lastFileKey(profile));
    } catch {
      /* unavailable — fall through to the first-existing-file default */
    }
    const path = initialFile(list.body.files, remembered);
    if (path) load(profile, path);
  }, [list, profile]);

  useEffect(() => {
    props.eventSink.current = (ev) => {
      if (ev.profile === profile) setListNonce((n) => n + 1);
      act({ type: "external", ev });
    };
    return () => {
      props.eventSink.current = null;
    };
  });

  const staleHash = doc?.phase.kind === "stale" ? doc.phase.hash : null;
  useEffect(() => {
    if (staleHash !== null && open) load(open.profile, open.path, true);
  }, [staleHash]);

  /** Save button / Mod-s: opens the diff confirm on a dirty buffer, else a no-op. */
  const requestSave = () => act({ type: "save" });

  /** PUT the buffer — `confirm` claims the loaded hash, `overwrite` the conflict's on-disk hash. */
  const put = (type: "confirm" | "overwrite") => {
    const s = act({ type });
    if (s?.phase.kind !== "saving") return;
    const { url, init } = saveRequest({ ...s.open, baseHash: s.phase.base }, s.phase.sent);
    const target = s.open;
    // A different file opened meanwhile (discard confirmed) must not receive this result.
    const settle = (a: SaveAction) => {
      const f = fileRef.current;
      if (f.kind === "ok" && f.doc.open === target) act(a);
    };
    const fail = (status: number) => {
      settle({ type: "failed" });
      setToast({ kind: "error", text: saveErrorText(status, lang) });
    };
    fetch(url, init)
      .then((res) => {
        const kind = classifySaveResponse(res.status);
        if (kind === "error" || kind === "invalid") return fail(res.status);
        return res.json().then((b: { hash: string; content?: string }) => {
          if (kind === "conflict") return settle({ type: "conflict", hash: b.hash, content: b.content ?? "" });
          settle({ type: "saved", hash: b.hash });
          // The file is written whichever file is open now, so the acknowledgement always shows.
          setSavedAt({ path: target.path, at: new Date() });
          setToast({ kind: "ok", text: t("instructions.saved", { name: baseName(target.path) }) });
        });
      })
      .catch(() => fail(0));
  };

  const overwrite = () => {
    ask({ title: t("instructions.overwriteTitle"), body: t("instructions.overwriteBody"), confirmLabel: t("instructions.overwrite"), destructive: true }).then((ok) => ok && put("overwrite"));
  };

  /** Diff on a conflict: the 409 carried the disk content; an SSE-raised one fetches it. */
  const showDiff = () => {
    setDiff(true);
    if (doc?.phase.kind !== "conflict" || doc.phase.content !== null) return;
    const target = doc.open;
    const settle = (a: SaveAction) => {
      const f = fileRef.current;
      if (f.kind === "ok" && f.doc.open === target) act(a);
    };
    fetch(instructionFileUrl(target.profile, target.path))
      .then((res) => {
        if (res.status === 404) return settle({ type: "disk", disk: null });
        if (!res.ok) return setToast({ kind: "error", text: t("instructions.diskLoadFailed", { status: res.status }) });
        return res.json().then((b: { content: string; hash: string }) => settle({ type: "disk", disk: b }));
      })
      .catch(() => setToast({ kind: "error", text: t("instructions.diskLoadNetwork") }));
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
  }, [phase]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    props.onDirtyChange(dirty);
  }, [dirty]);
  const profileName = props.profiles.find((p) => p.name === profile);
  useEffect(() => {
    const name = open ? `${baseName(open.path)} · ` : "";
    document.title = `${dirty ? "● " : ""}${name}${t("instructions.title")} · ${profileName ? profileLabel(profileName) : profile} · agenthook`;
    return () => {
      document.title = "agenthook";
    };
  }, [dirty, open?.path, profileName, profile, t]);
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

  /** Runs `go` now on a clean buffer, else after the discard is confirmed. */
  const unlessDirty = (go: () => void) => {
    if (!dirty) return go();
    ask({ title: t("instructions.unsavedTitle"), body: discardPrompt(lang), confirmLabel: t("instructions.discard"), cancelLabel: t("instructions.keepEditing"), destructive: true }).then((ok) => ok && go());
  };

  const pickProfile = (name: string) => {
    if (name === profile) return;
    unlessDirty(() => {
      loadSeq.current++;
      setPicked(name);
      setList({ kind: "loading" });
      setFile({ kind: "none" });
    });
  };

  const pickFile = (path: string) => {
    if (open?.path === path) return;
    unlessDirty(() => load(profile, path));
  };

  if (!props.profiles.length) return <p className="text-sm text-[var(--color-muted)]">{t("instructions.noProfiles")}</p>;

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-[24rem] flex-col">
      <div className="mb-3 flex min-w-0 items-center gap-3 text-sm">
        <h1 className="shrink-0 text-title font-semibold">{t("instructions.title")}</h1>
        <select
          aria-label={t("instructions.profileLabel")}
          className="shrink-0 border border-[var(--color-border)] rounded px-1.5 py-0.5 bg-transparent"
          value={profile}
          onChange={(e) => pickProfile(e.target.value)}
        >
          {props.profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {profileLabel(p)}
            </option>
          ))}
        </select>
        {list.kind === "ok" && list.body.configPath && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-muted)]" title={list.body.configPath}>
            {list.body.configPath}
          </span>
        )}
      </div>
      {/* Below md the file list folds into one select above the editor, so the editor keeps the width. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row md:gap-4">
        {list.kind === "ok" && list.body.files.length > 0 && (
          <select
            aria-label={t("instructions.fileLabel")}
            className="w-full shrink-0 rounded border border-[var(--color-border)] bg-transparent px-1.5 py-1 font-mono text-sm md:hidden"
            value={open?.path ?? ""}
            onChange={(e) => pickFile(e.target.value)}
          >
            {!open && (
              <option value="" disabled>
                {t("instructions.selectFile")}
              </option>
            )}
            {groupFiles(list.body.files, lang).map((g) => (
              <optgroup key={g.scope} label={g.label}>
                {g.files.map((f) => (
                  <option key={f.path} value={f.path} disabled={!f.exists}>
                    {baseName(f.path)}
                    {!f.exists ? ` · ${t("instructions.missing")}` : f.agentsRunning > 0 ? ` · ${t("instructions.running", { count: f.agentsRunning })}` : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
        <nav className="w-72 shrink-0 overflow-auto text-sm max-lg:w-48 max-md:hidden">
          {list.kind === "loading" && <p className="text-muted">{t("instructions.loadingFiles")}</p>}
          {list.kind === "ok" &&
            groupFiles(list.body.files, lang).map((g) => (
              <section key={g.scope} className="mb-3">
                <h3 className="mb-1 text-xs uppercase tracking-wide text-muted">{g.label}</h3>
                <ul>
                  {g.files.map((f) => (
                    <li key={f.path}>
                      <button
                        // Not `disabled`: a file that isn't created yet stays focusable so keyboard and
                        // screen-reader users reach it and hear why it can't open.
                        className={`w-full rounded px-2 py-1 text-left aria-disabled:cursor-not-allowed aria-disabled:opacity-60 ${open?.path === f.path ? "bg-surface-raised" : ""}`}
                        aria-disabled={!f.exists || undefined}
                        aria-current={open?.path === f.path || undefined}
                        title={f.exists ? f.path : t("instructions.missingTitle", { path: f.path })}
                        onClick={() => f.exists && pickFile(f.path)}
                      >
                        <div className="truncate font-mono">{baseName(f.path)}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted">
                          {f.ids.length ? f.ids.map((id) => <Pill key={id}>{id}</Pill>) : <span>—</span>}
                          <span>· {f.exists ? formatBytes(f.bytes) : t("instructions.missing")}</span>
                          {f.agentsRunning > 0 && <span className="text-status-running">· {t("instructions.running", { count: f.agentsRunning })}</span>}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {list.kind === "error" && (
            <EmptyState title={t("instructions.listError")} hint={list.status === 0 ? t("instructions.requestNetwork") : t("instructions.requestFailed", { status: list.status })} />
          )}
          {list.kind === "ok" && list.body.files.length === 0 && (
            <EmptyState
              title={t("instructions.noFiles")}
              hint={t("instructions.noFilesHint")}
            />
          )}
          {file.kind === "none" && list.kind === "ok" && list.body.files.length > 0 && (
            <EmptyState title={t("instructions.selectFile")} hint={t("instructions.selectFileHint")} />
          )}
          {file.kind === "loading" && <p className="text-sm">{t("instructions.loadingFile", { name: baseName(file.path) })}</p>}
          {file.kind === "error" && (
            <p className="text-sm text-status-failed">
              {file.status === 404
                ? t("instructions.fileGone", { path: file.path })
                : t("instructions.fileFailed", { path: file.path, status: file.status })}
            </p>
          )}
          {open && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 basis-32 truncate font-mono" title={open.path}>
                  {open.path}
                </span>
                {phase === "saving" ? (
                  <span className="shrink-0 text-muted">{t("instructions.saving")}</span>
                ) : (
                  dirty && <span className="shrink-0 font-medium text-fg">{t("instructions.modified")}</span>
                )}
                <Segmented
                  label={t("instructions.sidePanel")}
                  value={side}
                  options={[
                    { value: "none", label: t("instructions.tab.editor") },
                    { value: "preview", label: t("instructions.tab.preview") },
                    { value: "agent", label: <><span className="lg:hidden">{t("instructions.tab.agent")}</span><span className="max-lg:hidden">{t("instructions.tab.agentLong")}</span></> },
                  ]}
                  onChange={setSide}
                />
                <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
                  <InlineLiveEffect agentsRunning={agentsRunning} />
                  {!dirty && phase === "editing" && (
                    <span className="text-label text-muted">
                      {savedAt?.path === open.path
                        ? t("instructions.savedAt", { time: savedAt.at.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) })
                        : t("instructions.noChanges")}
                    </span>
                  )}
                  <button
                    className="rounded bg-accent px-2 py-0.5 text-accent-fg disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!dirty || phase !== "editing"}
                    title={t("instructions.saveTitle")}
                    onClick={requestSave}
                  >
                    {t("instructions.save")}
                  </button>
                </span>
              </div>
              {(phase === "conflict" || phase === "deleted") && (
                <div className="mb-2 flex items-center gap-3 rounded border border-status-held bg-status-held-bg px-3 py-1.5 text-sm text-status-held">
                  {phase === "deleted" ? t("instructions.deletedBanner") : t("instructions.changedBanner")}
                  <span className="ml-auto flex gap-2">
                    <button className="rounded border border-border bg-surface px-2 py-0.5 text-fg hover:bg-surface-raised" onClick={() => load(open.profile, open.path)}>
                      {t("instructions.reload")}
                    </button>
                    {phase === "conflict" && (
                      <>
                        <button className="rounded border border-border bg-surface px-2 py-0.5 text-fg hover:bg-surface-raised" onClick={showDiff}>
                          {t("instructions.diff")}
                        </button>
                        <button className="rounded border border-status-failed bg-surface px-2 py-0.5 text-status-failed hover:bg-status-failed-bg" onClick={overwrite}>
                          {t("instructions.overwrite")}
                        </button>
                      </>
                    )}
                  </span>
                </div>
              )}
              {/* Below lg a side panel stacks under the editor instead of squeezing beside it. */}
              <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
                <div className="min-h-0 min-w-0 flex-1">
                  <MarkdownEditor key={editorKey} label={t("instructions.editorLabel", { name: baseName(open.path) })} initial={open.content} onChange={(buffer) => act({ type: "edit", buffer })} onSave={requestSave} />
                </div>
                {side === "preview" && doc && (
                  // react-markdown escapes raw HTML by default; never add rehype-raw here.
                  <div className="md-preview min-h-0 min-w-0 flex-1 overflow-auto rounded border border-border px-4 py-2 text-sm">
                    <Markdown>{doc.buffer}</Markdown>
                  </div>
                )}
                {side === "agent" && doc && list.kind === "ok" && openFileView && (
                  <PromptPreview profile={profile} files={list.body.files} openFile={openFileView} buffer={doc.buffer} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {doc?.phase.kind === "confirming" && (
        <Modal title={t("instructions.saveConfirmTitle", { name: baseName(doc.open.path) })} onClose={() => act({ type: "cancel" })}>
          <ConfirmSave
            agentsRunning={agentsRunning}
            fullAuto={!!props.profiles.find((p) => p.name === profile)?.fullAuto}
            onCancel={() => act({ type: "cancel" })}
            onSave={() => put("confirm")}
          >
            <DiffLegend />
            <DiffView a={doc.open.content} b={doc.buffer} />
          </ConfirmSave>
        </Modal>
      )}
      {diff && doc?.phase.kind === "conflict" && (
        <Modal title={t("instructions.changedTitle", { name: baseName(doc.open.path) })} onClose={() => setDiff(false)}>
          <DiffLegend />
          {doc.phase.content === null ? <p className="text-sm">{t("instructions.loadingDisk")}</p> : <DiffView a={doc.phase.content} b={doc.buffer} />}
          <div className="mt-3 flex justify-end gap-2">
            <button className="rounded border border-[var(--color-border)] px-3 py-1" onClick={() => setDiff(false)}>
              {t("instructions.close")}
            </button>
            <button className="rounded border border-status-failed px-3 py-1 text-status-failed hover:bg-status-failed-bg" onClick={overwrite}>
              {t("instructions.overwrite")}
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div
          role={toast.kind === "error" ? "alert" : "status"}
          className={`fixed bottom-4 right-4 z-50 flex max-w-md items-center gap-3 rounded border bg-[var(--color-bg)] px-3 py-2 text-sm shadow ${toast.kind === "error" ? "border-[var(--color-err)] text-[var(--color-err)]" : "border-success text-fg"}`}
        >
          {toast.text}
          <button aria-label={t("instructions.dismiss")} onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
      {confirmModal}
    </div>
  );
}

/**
 * The save confirm's body. Saving changes what agents run (unsandboxed under fullAuto), so the
 * consequence sits above the diff, and while agents are running on the file the Save needs an
 * explicit acknowledgement first. Mounted per confirm, so the acknowledgement never carries over;
 * an agent starting mid-confirm re-locks Save.
 */
function ConfirmSave(props: { agentsRunning: number; fullAuto: boolean; onCancel: () => void; onSave: () => void; children: React.ReactNode }) {
  const { t, lang } = useT();
  const [ack, setAck] = useState(false);
  const live = props.agentsRunning > 0;
  const locked = live && !ack;
  return (
    <>
      <div className="mb-3 space-y-1 text-sm text-muted">
        {props.fullAuto && (
          <p className="flex items-center gap-1.5 text-fg">
            <FullAutoShield />
            {t("instructions.fullAutoNote")}
          </p>
        )}
        {!live && <p>{liveEffectNote(0, lang).text}</p>}
        <p>{t("instructions.backupNote")}</p>
      </div>
      {props.children}
      {live && (
        <label className="mt-3 flex items-start gap-2 rounded border border-status-running bg-status-running-bg px-3 py-2 text-sm text-fg">
          <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>{t("instructions.runningAck", { count: props.agentsRunning })}</span>
        </label>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button className="rounded border border-[var(--color-border)] px-3 py-1" onClick={props.onCancel}>
          {t("instructions.cancel")}
        </button>
        <button className="rounded bg-accent px-3 py-1 font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-50" disabled={locked} onClick={props.onSave}>
          {t("instructions.saveForNextRun")}
        </button>
      </div>
    </>
  );
}

/** The same note, inline beside Save rather than inside the confirm modal. */
function InlineLiveEffect(props: { agentsRunning: number }) {
  const { lang } = useT();
  const note = liveEffectNote(props.agentsRunning, lang);
  // Running agents are state, so they take the running hue; no warning glyph (nothing is wrong).
  return (
    <span role="status" className={`text-label ${note.warn ? "text-status-running" : "text-muted"}`}>
      {note.text}
    </span>
  );
}
