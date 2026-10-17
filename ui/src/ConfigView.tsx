import { useEffect, useReducer, useRef, useState } from "react";
import { json } from "@codemirror/lang-json";
import type { ConfigView as ConfigBody, ProfileView } from "./contract";
import { profileLabel } from "./format";
import { isDirty } from "./instructions";
import { MarkdownEditor } from "./MarkdownEditor";
import { DiffView } from "./DiffView";
import { ConfirmContext, DiffLegend, Modal, useConfirm } from "./Modal";
import { BasicsForm, ForgeForm, IngressForm, IntegrationsForm, PipelineForm, ReposForm, TrackerForm } from "./ConfigForms";
import type { StagesState } from "./ConfigForms";
import { clientErrors, discoverUrl, readSteps, stageKeysFor, stageSource, stepErrors } from "./configEdit";
import { layoutPipeline } from "./pipelineGraph";
import { PipelineGraph } from "./PipelineGraph";
import { classifySaveResponse, freshSave, saveErrorText, saveReducer } from "./save";
import type { SaveAction, SaveState } from "./save";
import {
  CONFIG_DISCARD_PROMPT,
  RESTART_IDLE,
  bannerStatus,
  configEventAsFile,
  configSaveRequest,
  configUrl,
  moveTarget,
  parseCheck,
  restartReducer,
  restartRequest,
  restartText,
  sensitiveDiff,
  sensitiveLabel,
} from "./config";
import type { ConfigSinkEvent, SensitiveChange } from "./config";

// The server's view of the file as of the last load / accepted save / 422 — the local parse check
// is live, this is not.
type Meta = { errors: string[]; literalSecrets: string[]; as: "load" | "save" | "rejected" };
type FileState = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; doc: SaveState; meta: Meta };
type Pane = "raw" | "basics" | "pipeline" | "tracker" | "forge" | "ingress" | "integrations" | "repos";

const PANES: readonly Pane[] = ["basics", "pipeline", "tracker", "forge", "ingress", "integrations", "repos", "raw"];

const JSON_LANG = json();
const OVERWRITE_TITLE = "Overwrite the on-disk config with your buffer?";
const OVERWRITE_BODY = "The on-disk changes will be replaced (the previous content is kept as a backup).";
const META_LABEL: Record<Meta["as"], string> = { load: "as of last load", save: "as of last save", rejected: "save rejected" };

/**
 * The profile's raw `agenthook.config.json` in a JSON CodeMirror editor. Saves reuse the
 * Instructions flow (`save.ts`): diff → confirm (plus an explicit ack when SENSITIVE_FIELDS
 * change) → guarded `PUT /api/config`. A 200 offers "Restart when idle" (`POST /api/restart`),
 * whose banner follows `restartReducer` off SSE only. `eventSink` carries `config` events
 * (external edits) and feed `event`s (the restart lifecycle) from the parent's /api/stream.
 * Basics / Pipeline / Tracker / Forge / Ingress / Integrations form tabs edit the same buffer through
 * `configEdit.ts` text edits; the stage pickers fetch `GET /api/discover` on first form-tab open per
 * profile and on Refresh only (no polling). Tabs read Basics · Pipeline · Tracker · Forge · Ingress ·
 * Integrations · Raw; a parseable config opens on Pipeline (graph expanded), an unparseable one falls
 * back to Raw.
 * Clicking a step in the graph opens that step's card.
 * When the loaded label differs from the state key, "Move state dir to match name" sends the same
 * restart with `moveTo` (`rename --move`); once the snapshot lists the new key, the view follows it.
 */
export default function ConfigView(props: {
  profiles: ProfileView[];
  eventSink: React.RefObject<((ev: ConfigSinkEvent) => void) | null>;
  onDirtyChange: (dirty: boolean) => void;
  /** The profile to open on (the dashboard's ⋯ menu); falls back to the first one. */
  initialProfile?: string;
}) {
  const [picked, setPicked] = useState(props.initialProfile ?? props.profiles[0]?.name ?? "");
  // A requested state-dir move (old key → label). The old key vanishes from the snapshot when the
  // dir moves, so follow to the new one instead of falling back to the first profile.
  const [moving, setMoving] = useState<{ from: string; to: string } | null>(null);
  const [moveConfirm, setMoveConfirm] = useState(false);
  const listed = (n: string) => props.profiles.some((p) => p.name === n);
  const current = moving && picked === moving.from && !listed(moving.from) && listed(moving.to) ? moving.to : picked;
  const profile = listed(current) ? current : (props.profiles[0]?.name ?? "");
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
  // Every "are you sure?" here (and in the forms, via ConfirmContext) is this one in-app modal.
  const [ask, confirmModal] = useConfirm();
  const [pane, setPane] = useState<Pane>("pipeline");
  // The validation banner's full error-list overlay; closed on every profile switch.
  const [bannerOpen, setBannerOpen] = useState(false);
  // The graph panel follows the pane — expanded on Pipeline, collapsed elsewhere — reset on every
  // pane switch; the ▾/▸ toggle holds until the next one.
  const [graphOpen, setGraphOpen] = useState(true);
  // A graph step click: the Pipeline form opens + scrolls to that card (`nonce` re-fires a repeat click).
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  // Discover for `profile` (null = not fetched yet for the open profile); only the latest fetch lands.
  const [stages, setStages] = useState<(StagesState & { profile: string }) | null>(null);
  const discoverSeq = useRef(0);
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
  const checks = parsed?.ok ? clientErrors(parsed.raw) : [];
  const perStep = parsed?.ok && file.kind === "ok" ? stepErrors(parsed.raw, file.meta.errors) : undefined;

  const fetchStages = (prof: string) => {
    const seq = ++discoverSeq.current;
    setStages({ profile: prof, source: { kind: "loading" }, body: null });
    const land = (status: number, body: any) => {
      if (seq === discoverSeq.current) setStages({ profile: prof, source: stageSource(status, body), body: status === 200 ? body : null });
    };
    fetch(discoverUrl(prof))
      .then((res) =>
        res
          .json()
          .catch(() => null)
          .then((body) => land(res.status, body)),
      )
      .catch(() => land(0, null));
  };

  // A form tab's first open for a profile fetches its stages once; Refresh re-fetches.
  useEffect(() => {
    if (pane !== "raw" && profile && stages?.profile !== profile) fetchStages(profile);
  }, [pane, profile]);

  // Forms need a parsed buffer: an unparseable one (e.g. reloaded from disk) falls back to Raw.
  useEffect(() => {
    if (parsed && !parsed.ok && pane !== "raw") setPane("raw");
  }, [parsed?.ok]);

  const switchPane = (next: Pane) => {
    if (next === pane) return;
    // The raw editor is uncontrolled: remount it so it seeds from the buffer the forms edited.
    if (next === "raw") setEditorKey((k) => k + 1);
    setPane(next);
    setGraphOpen(next === "pipeline");
    setFocus(null);
  };

  /** A step node in the graph: show the Pipeline form (the graph only renders on a parsed buffer) open at that step. */
  const selectStep = (id: string) => {
    switchPane("pipeline");
    setFocus((f) => ({ id, nonce: (f?.nonce ?? 0) + 1 }));
  };

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
    if (current !== picked) setPicked(current);
  }, [current]);

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
    const body = (
      <>
        <p>{OVERWRITE_BODY}</p>
        {changes.length > 0 && (
          <>
            <p className="mt-2 font-semibold">Sensitive fields change:</p>
            <ul className="font-mono text-xs">
              {changes.map((c) => (
                <li key={c.path}>
                  {sensitiveLabel(c.path)}: {c.from} → {c.to}
                </li>
              ))}
            </ul>
          </>
        )}
      </>
    );
    ask({ title: OVERWRITE_TITLE, body, confirmLabel: "Overwrite", destructive: true }).then((ok) => ok && put("overwrite"));
  };

  /** Throw the edits away: the buffer goes back to the loaded/saved text (a conflict then reloads). */
  const revert = () => {
    ask({ title: "Revert unsaved changes", body: CONFIG_DISCARD_PROMPT, confirmLabel: "Discard changes", destructive: true }).then((ok) => {
      if (!ok) return;
      const f = fileRef.current;
      // The raw editor is uncontrolled: remount it so it shows the reverted text.
      if (f.kind === "ok" && act({ type: "revert" }) !== f.doc) setEditorKey((k) => k + 1);
    });
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

  /** "Restart when idle"; `moveTo` also moves the state dir to that key (the move confirm). */
  const requestRestart = (moveTo?: string) => {
    const prof = profile;
    dispatchRestart({ type: "request", pid: profileView?.pid ?? null });
    if (moveTo !== undefined) setMoving({ from: prof, to: moveTo });
    const { url, init } = restartRequest(prof, moveTo);
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
    if (name === profile) return;
    const go = () => {
      loadSeq.current++;
      setPicked(name);
      setSavedNote(false);
      setMoving(null);
      setBannerOpen(false);
      dispatchRestart({ type: "reset" });
    };
    if (!dirty) return go();
    ask({ title: "Unsaved changes", body: CONFIG_DISCARD_PROMPT, confirmLabel: "Discard", cancelLabel: "Keep editing", destructive: true }).then((ok) => ok && go());
  };

  if (!props.profiles.length) return <p className="text-sm text-[var(--color-muted)]">No profiles.</p>;

  const sensitive: SensitiveChange[] = doc?.phase.kind === "confirming" ? sensitiveDiff(doc.open.content, doc.buffer) : [];
  const receiverUp = profileView?.up ?? false;
  const restartBusy = restart.kind === "requesting" || restart.kind === "pending" || restart.kind === "restarting";
  const restartLine = restartText(restart);
  const loadedRaw = open ? parseCheck(open.content) : null;
  const moveTo = loadedRaw?.ok ? moveTarget(loadedRaw.raw, profile) : null;
  // The Raw editor needs a bounded height to scroll internally; the form panes scroll with the page.
  const showRaw = pane === "raw" || !parsed?.ok;

  return (
    <div className={showRaw ? "flex h-[calc(100vh-8rem)] min-h-[24rem] flex-col" : "flex flex-col"}>
      <div className="mb-3 flex items-center gap-3 text-sm">
        <select
          className="border border-[var(--color-border)] rounded px-1.5 py-0.5 bg-transparent"
          value={profile}
          onChange={(e) => pickProfile(e.target.value)}
        >
          {props.profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {profileLabel(p)}
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
          dirty && <span className="shrink-0 text-status-held">● modified</span>
        )}
        {open && (
          <button
            data-revert
            className="ml-auto shrink-0 rounded border border-[var(--color-border)] px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!dirty || (phase !== "editing" && phase !== "conflict")}
            title="Discard your unsaved changes"
            onClick={revert}
          >
            Revert
          </button>
        )}
        {open && (
          <button
            className="shrink-0 rounded border border-[var(--color-border)] px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-50"
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
        <p className="text-sm text-status-failed">
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
                    restart.kind === "error" ? "text-status-failed" : restart.kind === "up" ? "text-status-done" : "text-[var(--color-muted)]"
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
                  onClick={() => requestRestart()}
                >
                  Restart when idle
                </button>
                <button aria-label="dismiss" onClick={() => setSavedNote(false)}>
                  ×
                </button>
              </span>
            </div>
          )}
          {moving ? (
            <div className="mb-2 flex items-center gap-3 rounded border border-[var(--color-accent)] bg-[var(--color-accent)]/10 px-3 py-1.5 text-sm">
              <span>
                {restart.kind !== "up" ? "Moving" : profile === moving.to ? "Moved" : "Move failed (see receiver.log):"} state dir{" "}
                <span className="font-mono">~/.agenthook/{moving.from}/</span> → <span className="font-mono">~/.agenthook/{moving.to}/</span>
              </span>
              {restartLine && (
                <span
                  className={
                    restart.kind === "error" ? "text-status-failed" : restart.kind === "up" ? "text-status-done" : "text-[var(--color-muted)]"
                  }
                >
                  {restartLine}
                </span>
              )}
              {!restartBusy && (
                <button className="ml-auto" aria-label="dismiss" onClick={() => setMoving(null)}>
                  ×
                </button>
              )}
            </div>
          ) : (
            moveTo &&
            !dirty && (
              <div className="mb-2 flex items-center gap-3 rounded border border-[var(--color-border)] px-3 py-1.5 text-sm">
                <span>
                  Label <span className="font-mono">{moveTo}</span> differs from the state key <span className="font-mono">{profile}</span>.
                </span>
                {receiverUp ? (
                  <button
                    className="ml-auto shrink-0 rounded border border-[var(--color-accent)] px-2 py-0.5 text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={restartBusy}
                    onClick={() => setMoveConfirm(true)}
                  >
                    Move state dir to match name
                  </button>
                ) : (
                  <span className="text-[var(--color-muted)]">
                    receiver not running — run <span className="font-mono">ah rename {moveTo} --move</span> to move it
                  </span>
                )}
              </div>
            )
          )}
          {(phase === "conflict" || phase === "deleted") && (
            <div className="mb-2 flex items-center gap-3 rounded border border-status-held bg-status-held-bg px-3 py-1.5 text-sm text-status-held">
              {phase === "deleted" ? "deleted on disk" : "changed on disk"} — your edits are based on an older version.
              <span className="ml-auto flex gap-2">
                <button className="rounded border border-status-held px-2 py-0.5" onClick={() => load(open.profile)}>
                  Reload
                </button>
                {phase === "conflict" && (
                  <>
                    <button className="rounded border border-status-held px-2 py-0.5" onClick={showDiff}>
                      Diff
                    </button>
                    <button className="rounded border border-status-held px-2 py-0.5" onClick={overwrite}>
                      Overwrite
                    </button>
                  </>
                )}
              </span>
            </div>
          )}
          {file.meta.literalSecrets.length > 0 && (
            <div className="mb-2 rounded border border-status-held bg-status-held-bg px-3 py-1.5 text-sm text-status-held">
              ⚠ Literal secret{file.meta.literalSecrets.length === 1 ? "" : "s"} in{" "}
              <span className="font-mono">{file.meta.literalSecrets.join(", ")}</span> — prefer a <span className="font-mono">{"${VAR}"}</span> ref
              (saving is still allowed).
            </div>
          )}
          {(() => {
            const banner = bannerStatus(parsed && !parsed.ok ? parsed.error : null, checks, file.meta.errors);
            return (
              <div className="relative mb-2">
                <div
                  data-config-banner
                  className={`flex h-8 items-center gap-2 rounded border px-3 text-sm ${
                    banner.ok ? "border-status-done bg-status-done-bg text-status-done" : "border-status-failed bg-status-failed-bg text-status-failed"
                  }`}
                >
                  {banner.ok ? (
                    <span className="truncate">✓ valid (server: {META_LABEL[file.meta.as]})</span>
                  ) : (
                    <>
                      <span className="truncate font-mono text-xs" title={banner.fullFirst}>
                        {banner.first}
                      </span>
                      {(banner.moreCount > 0 || banner.fullFirst !== banner.first) && (
                        <button
                          type="button"
                          data-config-banner-toggle
                          className="ml-auto shrink-0 whitespace-nowrap underline"
                          onClick={() => setBannerOpen((o) => !o)}
                        >
                          {banner.moreCount > 0 ? `+${banner.moreCount} more` : "full text"}
                        </button>
                      )}
                    </>
                  )}
                </div>
                {!banner.ok && bannerOpen && (
                  <div
                    data-config-banner-overlay
                    className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-auto rounded border border-status-failed bg-surface-raised px-3 py-2 text-sm shadow-lg"
                  >
                    {parsed && !parsed.ok && <p className="mb-1 break-words font-mono text-xs text-status-failed">{parsed.error}</p>}
                    {checks.length > 0 && (
                      <>
                        <h4 className="mb-1 text-xs text-[var(--color-muted)]">config checks (the server decides on save)</h4>
                        <ul className="mb-2 list-disc space-y-1 pl-4 text-status-held">
                          {checks.map((e, i) => (
                            <li key={i} className="break-words">
                              {e}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {file.meta.errors.length > 0 && (
                      <>
                        <h4 className="mb-1 text-xs text-[var(--color-muted)]">server ({META_LABEL[file.meta.as]})</h4>
                        <ul className="list-disc space-y-1 pl-4 text-status-failed">
                          {file.meta.errors.map((e, i) => (
                            <li key={i} className="break-words">
                              {e}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
          <div className="mb-2 flex gap-1 border-b border-[var(--color-border)] text-sm">
            {PANES.map((t) => (
              <button
                key={t}
                data-config-pane={t}
                className={`-mb-px border-b-2 px-3 py-0.5 capitalize disabled:cursor-not-allowed disabled:opacity-50 ${t === pane ? "border-[var(--color-accent)]" : "border-transparent text-[var(--color-muted)]"}`}
                disabled={t !== "raw" && !parsed?.ok}
                title={t !== "raw" && !parsed?.ok ? "fix the JSON in Raw first" : undefined}
                onClick={() => switchPane(t)}
              >
                {t}
              </button>
            ))}
            {!parsed?.ok && <span className="self-center px-2 text-xs text-[var(--color-muted)]">fix the JSON in Raw first</span>}
          </div>
          <div className="mb-2 rounded border border-[var(--color-border)]">
            <button
              className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs uppercase tracking-wide text-[var(--color-muted)]"
              onClick={() => setGraphOpen((o) => !o)}
            >
              <span>{graphOpen ? "▾" : "▸"}</span>
              Pipeline graph
            </button>
            {graphOpen && (
              <div className="border-t border-[var(--color-border)] p-2">
                {parsed?.ok ? (
                  <PipelineGraph
                    layout={layoutPipeline(
                      readSteps(parsed.raw),
                      stageKeysFor(stages?.profile === profile ? stages.body : null, (parsed.raw as any)?.tracker?.type),
                      stages?.profile === profile ? stages.body?.stages : null,
                    )}
                    onSelectStep={selectStep}
                  />
                ) : (
                  <p className="text-sm text-[var(--color-muted)]">fix the JSON to see the graph</p>
                )}
              </div>
            )}
          </div>
          <div className={showRaw ? "flex min-h-0 flex-1" : "flex flex-col"}>
            <div data-config-pane-host className={showRaw ? "min-w-0 flex-1 overflow-auto" : "min-w-0"}>
              <ConfirmContext.Provider value={ask}>
                {pane === "raw" || !parsed?.ok ? (
                  <MarkdownEditor
                    key={editorKey}
                    initial={doc.buffer}
                    language={JSON_LANG}
                    onChange={(buffer) => act({ type: "edit", buffer })}
                    onSave={requestSave}
                  />
                ) : pane === "basics" ? (
                  <BasicsForm text={doc.buffer} raw={parsed.raw} stateKey={profile} onEdit={(buffer) => act({ type: "edit", buffer })} />
                ) : pane === "tracker" ? (
                  <TrackerForm text={doc.buffer} raw={parsed.raw} onEdit={(buffer) => act({ type: "edit", buffer })} />
                ) : pane === "forge" ? (
                  <ForgeForm text={doc.buffer} raw={parsed.raw} onEdit={(buffer) => act({ type: "edit", buffer })} />
                ) : pane === "ingress" ? (
                  <IngressForm text={doc.buffer} raw={parsed.raw} onEdit={(buffer) => act({ type: "edit", buffer })} />
                ) : pane === "integrations" ? (
                  <IntegrationsForm text={doc.buffer} raw={parsed.raw} onEdit={(buffer) => act({ type: "edit", buffer })} />
                ) : pane === "repos" ? (
                  <ReposForm text={doc.buffer} raw={parsed.raw} onEdit={(buffer) => act({ type: "edit", buffer })} />
                ) : (
                  <PipelineForm
                    text={doc.buffer}
                    raw={parsed.raw}
                    stages={stages?.profile === profile ? stages : null}
                    onRefresh={() => fetchStages(profile)}
                    onEdit={(buffer) => act({ type: "edit", buffer })}
                    errors={perStep}
                    focus={focus}
                  />
                )}
              </ConfirmContext.Provider>
            </div>
          </div>
        </>
      )}
      {doc?.phase.kind === "confirming" && (
        <Modal title="Save agenthook.config.json?" onClose={() => act({ type: "cancel" })}>
          <p className="mb-2 text-sm text-[var(--color-muted)]">The receiver reads its config at boot — this takes effect on restart.</p>
          {sensitive.length > 0 && (
            <div className="mb-2 rounded border border-status-held bg-status-held-bg px-3 py-2 text-sm text-status-held">
              <p className="mb-1 font-semibold">Sensitive fields change:</p>
              <ul className="mb-2 font-mono text-xs">
                {sensitive.map((c) => (
                  <li key={c.path}>
                    {sensitiveLabel(c.path)}: {c.from} → {c.to}
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
      {moveConfirm && moveTo && (
        <Modal title="Move the state dir to match the name?" onClose={() => setMoveConfirm(false)}>
          <div className="space-y-2 text-sm">
            <p>
              Moves <span className="font-mono">~/.agenthook/{profile}/</span> → <span className="font-mono">~/.agenthook/{moveTo}/</span> with all its
              history (dedup, queue, held items, logs).
            </p>
            <p>
              Applied when the receiver is idle: new runs pause, running agents finish, then the dir moves, <span className="font-mono">stateId</span> is
              removed from the config, and the receiver restarts on <span className="font-mono">{moveTo}</span>. If the move fails, it restarts on{" "}
              <span className="font-mono">{profile}</span> instead.
            </p>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button className="rounded border border-[var(--color-border)] px-3 py-1" onClick={() => setMoveConfirm(false)}>
              Cancel
            </button>
            <button
              className="rounded border border-[var(--color-accent)] px-3 py-1 text-[var(--color-accent)]"
              onClick={() => {
                setMoveConfirm(false);
                requestRestart(moveTo);
              }}
            >
              Move when idle
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
            <button className="rounded border border-status-held px-3 py-1 text-status-held" onClick={overwrite}>
              Overwrite
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div role="alert" className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded border border-status-failed bg-[var(--color-bg)] px-3 py-2 text-sm text-status-failed shadow">
          {toast}
          <button aria-label="dismiss" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
      {confirmModal}
    </div>
  );
}
