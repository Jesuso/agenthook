import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { InstructionsView as InstructionsBody, ProfileView } from "./contract";
import { DISCARD_PROMPT, baseName, externalChange, formatBytes, groupFiles, instructionFileUrl, instructionsUrl, isDirty } from "./instructions";
import type { InstructionsEvent, OpenFile } from "./instructions";
import { MarkdownEditor } from "./MarkdownEditor";

type ListState = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; body: InstructionsBody };
type FileState = { kind: "none" } | { kind: "loading"; path: string } | { kind: "error"; path: string; status: number } | { kind: "ok"; file: OpenFile };

/**
 * Per-profile standing-instruction files and a CodeMirror editor over one of them. Edits stay
 * in a local buffer (no save yet). External edits arrive as SSE `instructions` events through
 * `eventSink` — the parent forwards them off the existing /api/stream, no polling.
 */
export default function InstructionsView(props: {
  profiles: ProfileView[];
  eventSink: React.RefObject<((ev: InstructionsEvent) => void) | null>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [picked, setPicked] = useState(props.profiles[0]?.name ?? "");
  const profile = props.profiles.some((p) => p.name === picked) ? picked : (props.profiles[0]?.name ?? "");
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [listNonce, setListNonce] = useState(0);
  const [file, setFile] = useState<FileState>({ kind: "none" });
  const [buffer, setBuffer] = useState("");
  // Remounts the editor on every load: fresh document, fresh undo history.
  const [editorKey, setEditorKey] = useState(0);
  const [banner, setBanner] = useState<"changed" | "deleted" | null>(null);
  const [preview, setPreview] = useState(false);
  // Only the latest file load may land; async callbacks read the live buffer via refs.
  const loadSeq = useRef(0);
  const open = file.kind === "ok" ? file.file : null;
  const openRef = useRef(open);
  openRef.current = open;
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  const dirty = open ? isDirty(buffer, open) : false;

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

  /** Load `path` into the editor. `silent` (an external edit on a clean buffer) keeps the current
   *  view while fetching, and turns into the banner if the user started typing meanwhile. */
  const load = (prof: string, path: string, silent = false) => {
    const seq = ++loadSeq.current;
    if (!silent) {
      setFile({ kind: "loading", path });
      setBanner(null);
    }
    const stillClean = () => !silent || !openRef.current || !isDirty(bufferRef.current, openRef.current);
    fetch(instructionFileUrl(prof, path))
      .then((res) => {
        if (seq !== loadSeq.current) return;
        if (!stillClean()) return setBanner("changed");
        if (!res.ok) return setFile({ kind: "error", path, status: res.status });
        return res.json().then((b: { content: string; hash: string }) => {
          if (seq !== loadSeq.current) return;
          if (!stillClean()) return setBanner("changed");
          setFile({ kind: "ok", file: { profile: prof, path, content: b.content, baseHash: b.hash } });
          setBuffer(b.content);
          setBanner(null);
          setEditorKey((k) => k + 1);
        });
      })
      .catch(() => {
        if (seq !== loadSeq.current) return;
        if (!stillClean()) return setBanner("changed");
        setFile({ kind: "error", path, status: 0 });
      });
  };

  useEffect(() => {
    props.eventSink.current = (ev) => {
      if (ev.profile === profile) setListNonce((n) => n + 1);
      const action = externalChange(open, ev, buffer);
      if (action === "reload" && open) load(open.profile, open.path, true);
      else if (action === "banner") setBanner(ev.hash === null ? "deleted" : "changed");
    };
    return () => {
      props.eventSink.current = null;
    };
  });

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

  const confirmDiscard = () => !dirty || window.confirm(DISCARD_PROMPT);

  const pickProfile = (name: string) => {
    if (name === profile || !confirmDiscard()) return;
    loadSeq.current++;
    setPicked(name);
    setList({ kind: "loading" });
    setFile({ kind: "none" });
    setBanner(null);
  };

  const pickFile = (path: string) => {
    if (open?.path === path || !confirmDiscard()) return;
    load(profile, path);
  };

  if (!props.profiles.length) return <p className="text-sm text-[var(--color-muted)]">No profiles.</p>;

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
        {list.kind === "ok" && list.body.configPath && (
          <span className="truncate font-mono text-xs text-[var(--color-muted)]" title={list.body.configPath}>
            {list.body.configPath}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1 gap-4">
        <nav className="w-72 shrink-0 overflow-auto text-sm">
          {list.kind === "loading" && <p>Loading files…</p>}
          {list.kind === "error" && <p>Failed to load instruction files (status {list.status}).</p>}
          {list.kind === "ok" && list.body.files.length === 0 && (
            <p className="text-[var(--color-muted)]">No instruction files published — the receiver is down or predates the editor.</p>
          )}
          {list.kind === "ok" &&
            groupFiles(list.body.files).map((g) => (
              <section key={g.scope} className="mb-3">
                <h3 className="mb-1 text-xs uppercase tracking-wide text-[var(--color-muted)]">{g.label}</h3>
                <ul>
                  {g.files.map((f) => (
                    <li key={f.path}>
                      <button
                        className={`w-full rounded px-2 py-1 text-left disabled:cursor-not-allowed disabled:opacity-60 ${open?.path === f.path ? "bg-[var(--color-border)]" : ""}`}
                        disabled={!f.exists}
                        title={f.path}
                        onClick={() => pickFile(f.path)}
                      >
                        <div className="truncate font-mono">{baseName(f.path)}</div>
                        <div className="text-xs text-[var(--color-muted)]">
                          {f.ids.join(", ") || "—"} ·{" "}
                          {f.exists ? formatBytes(f.bytes) : <span className="text-[var(--color-err)]">missing</span>}
                          {f.agentsRunning > 0 && (
                            <>
                              {" · "}
                              <span className="text-[var(--color-warn)]">{f.agentsRunning} running</span>
                            </>
                          )}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          {file.kind === "none" && <p className="text-sm text-[var(--color-muted)]">Select a file.</p>}
          {file.kind === "loading" && <p className="text-sm">Loading {baseName(file.path)}…</p>}
          {file.kind === "error" && (
            <p className="text-sm text-[var(--color-err)]">
              {file.status === 404
                ? `Can't open ${file.path}: it's gone, no longer allowlisted, a symlink, or over 256 KB.`
                : `Failed to load ${file.path} (status ${file.status}).`}
            </p>
          )}
          {open && (
            <>
              <div className="mb-2 flex items-center gap-3 text-sm">
                <span className="truncate font-mono" title={open.path}>
                  {open.path}
                </span>
                {dirty && <span className="shrink-0 text-[var(--color-warn)]">● modified — not saved (saving isn't available yet)</span>}
                <button className="ml-auto shrink-0 rounded border border-[var(--color-border)] px-2 py-0.5" onClick={() => setPreview((v) => !v)}>
                  {preview ? "hide preview" : "preview"}
                </button>
              </div>
              {banner && (
                <div className="mb-2 flex items-center gap-3 rounded border border-[var(--color-warn)] bg-[var(--color-warn)]/10 px-3 py-1.5 text-sm text-[var(--color-warn)]">
                  {banner === "deleted" ? "deleted on disk" : "changed on disk"} — your edits are based on an older version.
                  <button className="ml-auto rounded border border-[var(--color-warn)] px-2 py-0.5" onClick={() => load(open.profile, open.path)}>
                    Reload
                  </button>
                </div>
              )}
              <div className="flex min-h-0 flex-1 gap-3">
                <div className="min-w-0 flex-1">
                  <MarkdownEditor key={editorKey} initial={open.content} onChange={setBuffer} />
                </div>
                {preview && (
                  // react-markdown escapes raw HTML by default; never add rehype-raw here.
                  <div className="md-preview min-w-0 flex-1 overflow-auto rounded border border-[var(--color-border)] px-4 py-2 text-sm">
                    <Markdown>{buffer}</Markdown>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
