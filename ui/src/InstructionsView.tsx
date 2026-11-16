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
import { EmptyState, Pill, ProfileMark, Segmented } from "./components";
import { useT } from "./i18n/react";

type ListState = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; body: InstructionsBody };
type FileState = { kind: "none" } | { kind: "loading"; path: string } | { kind: "error"; path: string; status: number } | { kind: "ok"; doc: SaveState };
type Side = "none" | "preview" | "agent";

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
  // The app bar picks the profile; this page edits the one it was given.
  const shown = props.profiles.find((p) => p.name === props.initialProfile) ?? props.profiles[0];
  const profile = shown?.name ?? "";
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [listNonce, setListNonce] = useState(0);
  const [file, setFileState] = useState<FileState>({ kind: "none" });
  // Remounts the editor on every load: fresh document, fresh undo history.
  const [editorKey, setEditorKey] = useState(0);
  // One view at a time: the editor to write, the rendered file or the agent's prompt to read. A wide
  // window opens on what the agent receives; the choice after that is the human's.
  const [side, setSide] = useState<Side>(() => (typeof window !== "undefined" && window.matchMedia?.("(min-width: 1536px)").matches ? "agent" : "none"));
  // When the open file was last saved from here (cleared by the next edit or another file).
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [diff, setDiff] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
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
    setSavedAt(null);
    setCopied(false);
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
      setToast(saveErrorText(status, lang));
    };
    fetch(url, init)
      .then((res) => {
        const kind = classifySaveResponse(res.status);
        if (kind === "error" || kind === "invalid") return fail(res.status);
        return res.json().then((b: { hash: string; content?: string }) =>
          settle(kind === "ok" ? (setSavedAt(Date.now()), { type: "saved", hash: b.hash }) : { type: "conflict", hash: b.hash, content: b.content ?? "" }),
        );
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
        if (!res.ok) return setToast(t("instructions.diskLoadFailed", { status: res.status }));
        return res.json().then((b: { content: string; hash: string }) => settle({ type: "disk", disk: b }));
      })
      .catch(() => setToast(t("instructions.diskLoadNetwork")));
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

  const [copied, setCopied] = useState(false);
  const copyBuffer = () => {
    if (!doc) return;
    navigator.clipboard?.writeText(doc.buffer).then(() => setCopied(true), () => setToast(t("instructions.copyFailed")));
  };

  const pickFile = (path: string) => {
    if (open?.path === path) return;
    unlessDirty(() => load(profile, path));
  };

  if (!props.profiles.length) return <p className="text-sm text-[var(--color-muted)]">{t("instructions.noProfiles")}</p>;

  return (
    <div className="flex h-[calc(100vh-8rem)] min-h-[24rem] flex-col max-md:h-auto sm:px-2 2xl:px-4">
      <div className="mb-3 flex min-w-0 items-center gap-3 text-sm" data-instructions-head>
        <ProfileMark p={shown} />
        <h1 className="shrink-0 text-title font-semibold">
          {t("instructions.title")} <span className="font-normal text-muted">· {profileLabel(shown)}</span>
        </h1>
        {list.kind === "ok" && list.body.configPath && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-muted)] max-sm:hidden" title={list.body.configPath}>
            {list.body.configPath}
          </span>
        )}
      </div>
      {/* Narrow, the file list sits above the editor instead of squeezing it. */}
      <div className="flex min-h-0 flex-1 gap-4 max-md:flex-col">
        <nav className="w-72 shrink-0 overflow-auto text-sm max-lg:w-48 max-md:max-h-40 max-md:w-full">
          {list.kind === "loading" && <p className="text-muted">{t("instructions.loadingFiles")}</p>}
          {list.kind === "ok" &&
            groupFiles(list.body.files, lang).map((g) => (
              <section key={g.scope} className="mb-3">
                <h3 className="mb-1 text-xs uppercase tracking-wide text-muted">{g.label}</h3>
                <ul>
                  {g.files.map((f) => (
                    <li key={f.path}>
                      <button
                        className={`w-full rounded px-2 py-1 text-left disabled:cursor-not-allowed disabled:opacity-60 ${open?.path === f.path ? "bg-surface-raised" : ""}`}
                        disabled={!f.exists}
                        title={f.path}
                        onClick={() => pickFile(f.path)}
                      >
                        <div className="truncate font-mono">{baseName(f.path)}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted">
                          {f.ids.length ? f.ids.map((id) => <Pill key={id}>{id}</Pill>) : <span>—</span>}
                          <span>· {f.exists ? formatBytes(f.bytes) : <span className="text-status-failed">{t("instructions.missing")}</span>}</span>
                          {f.agentsRunning > 0 && <span className="text-status-held">· {t("instructions.running", { count: f.agentsRunning })}</span>}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          {list.kind === "error" && (
            <EmptyState title={t("instructions.listError")} hint={t("instructions.requestFailed", { status: list.status })} />
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
                {/* The name first: a long folder is what gets cut, not the file. */}
                <span className="flex min-w-0 flex-1 basis-32 items-baseline gap-2 font-mono" title={open.path} data-open-path>
                  <span className="shrink-0">{baseName(open.path)}</span>
                  <span className="min-w-0 truncate text-xs text-muted max-sm:hidden">{open.path.slice(0, open.path.length - baseName(open.path).length)}</span>
                </span>
                {phase === "saving" ? (
                  <span className="shrink-0 text-muted">{t("instructions.saving")}</span>
                ) : (
                  dirty && <span className="shrink-0 text-status-held">{t("instructions.modified")}</span>
                )}
                <Segmented
                  label={t("instructions.viewLabel")}
                  tone="neutral"
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
                    <span role="status" data-save-status className={`text-label ${savedAt ? "text-success" : "text-muted"}`}>
                      {savedAt ? t("instructions.savedAt", { time: new Date(savedAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) }) : t("instructions.noChanges")}
                    </span>
                  )}
                  <button
                    className="rounded border border-accent bg-accent px-2 py-0.5 text-accent-fg disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted"
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
                    {phase === "deleted" && (
                      <button className="rounded border border-status-held px-2 py-0.5" data-copy-buffer onClick={copyBuffer}>
                        {copied ? t("instructions.copied") : t("instructions.copyText")}
                      </button>
                    )}
                    {/* Reload drops what was typed here, so it asks first like any other way out. */}
                    <button className="rounded border border-status-held px-2 py-0.5" data-reload onClick={() => unlessDirty(() => load(open.profile, open.path))}>
                      {t("instructions.reload")}
                    </button>
                    {phase === "conflict" && (
                      <>
                        <button className="rounded border border-status-held px-2 py-0.5" onClick={showDiff}>
                          {t("instructions.diff")}
                        </button>
                        <button className="rounded border border-status-held px-2 py-0.5" onClick={overwrite}>
                          {t("instructions.overwrite")}
                        </button>
                      </>
                    )}
                  </span>
                </div>
              )}
              <div className="flex min-h-0 flex-1 gap-3 max-md:h-[70vh] max-md:flex-none">
                {/* The editor stays mounted (its undo history lives there); the reading views replace it on screen. */}
                <div className={`min-w-0 flex-1 ${side === "none" ? "" : "hidden"}`} data-editor-pane>
                  <MarkdownEditor key={editorKey} initial={open.content} onChange={(buffer) => (setSavedAt(null), act({ type: "edit", buffer }))} onSave={requestSave} />
                </div>
                {side === "preview" && doc && (
                  // react-markdown escapes raw HTML by default; never add rehype-raw here.
                  <div className="md-preview enter-fade min-w-0 flex-1 overflow-auto rounded border border-border px-4 py-2 text-sm">
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
          <LiveEffect agentsRunning={agentsRunning} />
          <DiffLegend />
          <DiffView a={doc.open.content} b={doc.buffer} />
          <div className="mt-3 flex justify-end gap-2">
            <button className="rounded border border-[var(--color-border)] px-3 py-1" onClick={() => act({ type: "cancel" })}>
              {t("instructions.cancel")}
            </button>
            <button className="rounded border border-[var(--color-accent)] px-3 py-1 text-[var(--color-accent)]" onClick={() => put("confirm")}>
              {t("instructions.save")}
            </button>
          </div>
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
            <button className="rounded border border-[var(--color-warn)] px-3 py-1 text-[var(--color-warn)]" onClick={overwrite}>
              {t("instructions.overwrite")}
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div role="alert" className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded border border-[var(--color-err)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-err)] shadow">
          {toast}
          <button aria-label={t("instructions.dismiss")} onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
      {confirmModal}
    </div>
  );
}

function LiveEffect(props: { agentsRunning: number }) {
  const { lang } = useT();
  const note = liveEffectNote(props.agentsRunning, lang);
  return <p className={`mb-2 text-sm ${note.warn ? "text-[var(--color-warn)]" : "text-[var(--color-muted)]"}`}>{note.warn ? `⚠ ${note.text}` : note.text}</p>;
}

/** The same note, inline beside Save rather than inside the confirm modal. */
function InlineLiveEffect(props: { agentsRunning: number }) {
  const { lang } = useT();
  const note = liveEffectNote(props.agentsRunning, lang);
  return <span className={`text-label ${note.warn ? "text-status-held" : "text-muted"}`}>{note.warn ? `⚠ ${note.text}` : note.text}</span>;
}
