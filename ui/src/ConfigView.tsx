import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { MessageKey } from "./i18n";
import { rich, useT } from "./i18n/react";
import { json } from "@codemirror/lang-json";
import type { ConfigView as ConfigBody, ProfileView } from "./contract";
import { profileLabel } from "./format";
import { isDirty } from "./instructions";
import { MarkdownEditor } from "./MarkdownEditor";
import { DiffView } from "./DiffView";
import { ConfirmContext, DiffLegend, Modal, useConfirm } from "./Modal";
import { BasicsForm, ForgeForm, IngressForm, IntegrationsForm, PipelineForm, ReposForm, TrackerForm } from "./ConfigForms";
import type { CardHooks, StagesState } from "./ConfigForms";
import { cardFor, clientErrors, discoverUrl, readSteps, stageKeysFor, stageSource, stepErrors } from "./configEdit";
import type { CardList } from "./configEdit";
import { layoutPipeline } from "./pipelineGraph";
import { PipelineGraph } from "./PipelineGraph";
import { overflowEdges, revealScrollLeft } from "./scrollRow";
import { classifySaveResponse, freshSave, saveErrorText, saveReducer } from "./save";
import type { SaveAction, SaveState } from "./save";
import {
  RESTART_IDLE,
  bannerStatus,
  configDiscardPrompt,
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
// The form pane each card list renders on.
const CARD_PANE: Record<CardList, Pane> = { sinks: "integrations", repos: "repos", steps: "pipeline" };
type Pristine = Record<CardList, ReadonlySet<number>>;
const NO_PRISTINE: Pristine = { sinks: new Set(), repos: new Set(), steps: new Set() };

const JSON_LANG = json();
const META_LABEL: Record<Meta["as"], MessageKey> = { load: "configView.meta.load", save: "configView.meta.save", rejected: "configView.meta.rejected" };
const PANE_LABEL: Record<Pane, MessageKey> = {
  basics: "configView.pane.basics",
  pipeline: "configView.pane.pipeline",
  tracker: "configView.pane.tracker",
  forge: "configView.pane.forge",
  ingress: "configView.pane.ingress",
  integrations: "configView.pane.integrations",
  repos: "configView.pane.repos",
  raw: "configView.pane.raw",
};
const MONO = (text: string) => <span className="font-mono">{text}</span>;
// Below `sm` (phones): a 40px touch target; desktop keeps the compact size.
const TOUCH = "min-h-10 min-w-10 sm:min-h-0 sm:min-w-0";
// How far a revealed tab stays clear of the row's edge fade.
const TAB_FADE_PX = 32;

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
  const { t, lang } = useT();
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
  // Just-added, untouched cards (`CardHooks`): their errors are an amber "incomplete" hint. Cleared on
  // every load (profile switch, reload), Revert, and any Save attempt (blocked or not).
  const [pristine, setPristine] = useState<Pristine>(NO_PRISTINE);
  const clearPristine = () => setPristine(NO_PRISTINE);
  const cardHooks: CardHooks = {
    pristine,
    onAdded: (list, i) => setPristine((p) => ({ ...p, [list]: new Set([...p[list], i]) })),
    onTouched: (list, i) => setPristine((p) => ({ ...p, [list]: new Set([...p[list]].filter((k) => k !== i)) })),
    onShifted: (list) => setPristine((p) => (p[list].size ? { ...p, [list]: new Set() } : p)),
  };
  // The graph panel follows the pane — expanded on Pipeline, collapsed elsewhere — reset on every
  // pane switch; the ▾/▸ toggle holds until the next one.
  const [graphOpen, setGraphOpen] = useState(true);
  // A graph step click: the Pipeline form opens + scrolls to that card (`nonce` re-fires a repeat click).
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  // The tab strip scrolls sideways when it doesn't fit (phones): which edges get a fade.
  const tabRow = useRef<HTMLDivElement>(null);
  const [tabEdges, setTabEdges] = useState({ start: false, end: false });
  const measureTabs = () => {
    const row = tabRow.current;
    if (!row) return;
    const next = overflowEdges(row);
    setTabEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  };
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
  const parsed = doc ? parseCheck(doc.buffer, lang) : null;
  const checks = parsed?.ok ? clientErrors(parsed.raw) : [];
  const perStep = parsed?.ok && file.kind === "ok" ? stepErrors(parsed.raw, file.meta.errors) : undefined;

  const fetchStages = (prof: string) => {
    const seq = ++discoverSeq.current;
    setStages({ profile: prof, source: { kind: "loading" }, body: null });
    const land = (status: number, body: any) => {
      if (seq === discoverSeq.current) setStages({ profile: prof, source: stageSource(status, body, lang), body: status === 200 ? body : null });
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

  // Keep the active tab in view (horizontal only — the page itself never scrolls for it, so a graph
  // click's scroll to a step card holds), then re-read the edge fades. Also on load and resize.
  const tabsShown = file.kind === "ok";
  useLayoutEffect(() => {
    const row = tabRow.current;
    const tab = row?.querySelector<HTMLElement>(`[data-config-pane="${pane}"]`);
    if (row && tab) {
      const r = row.getBoundingClientRect();
      const t = tab.getBoundingClientRect();
      const start = t.left - r.left + row.scrollLeft;
      const left = revealScrollLeft(row, { start, end: start + t.width }, TAB_FADE_PX);
      if (left !== row.scrollLeft) row.scrollLeft = left;
    }
    measureTabs();
  }, [pane, tabsShown]);
  useEffect(() => {
    window.addEventListener("resize", measureTabs);
    return () => window.removeEventListener("resize", measureTabs);
  }, []);

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
          clearPristine();
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

  /**
   * Save button / Mod-s: opens the diff confirm on a dirty buffer that parses and passes the client
   * checks. Every attempt ends the "incomplete" grace of just-added cards; one the client checks
   * block opens nothing and sends nothing. Server errors alone never block (the client may not
   * mirror the rule, and blocking would stop the user fixing it).
   */
  const requestSave = () => {
    const f = fileRef.current;
    if (f.kind !== "ok") return;
    const p = parseCheck(f.doc.buffer);
    if (!p.ok) return;
    clearPristine();
    if (clientErrors(p.raw).length === 0) act({ type: "save" });
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
      setToast(saveErrorText(status, lang));
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
    const changes = sensitiveDiff(doc.phase.content ?? doc.open.content, doc.buffer, lang);
    const body = (
      <>
        <p>{t("configView.overwriteBody")}</p>
        {changes.length > 0 && (
          <>
            <p className="mt-2 font-semibold">{t("configView.sensitiveChange")}</p>
            <ul className="break-all font-mono text-xs">
              {changes.map((c) => (
                <li key={c.path}>
                  {sensitiveLabel(c.path, lang)}: {c.from} → {c.to}
                </li>
              ))}
            </ul>
          </>
        )}
      </>
    );
    ask({ title: t("configView.overwriteTitle"), body, confirmLabel: t("configView.overwrite"), destructive: true }).then((ok) => ok && put("overwrite"));
  };

  /** Throw the edits away: the buffer goes back to the loaded/saved text (a conflict then reloads). */
  const revert = () => {
    ask({ title: t("configView.revertTitle"), body: configDiscardPrompt(lang), confirmLabel: t("configView.discardChanges"), destructive: true }).then((ok) => {
      if (!ok) return;
      const f = fileRef.current;
      clearPristine();
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
        if (!res.ok) return setToast(t("configView.diskLoadFailed", { status: res.status }));
        return res.json().then((b: ConfigBody) => settle({ type: "disk", disk: { content: b.text, hash: b.hash } }));
      })
      .catch(() => setToast(t("configView.diskLoadNetwork")));
  };

  /** "Restart when idle"; `moveTo` also moves the state dir to that key (the move confirm). */
  const requestRestart = (moveTo?: string) => {
    const prof = profile;
    dispatchRestart({ type: "request", pid: profileView?.pid ?? null });
    if (moveTo !== undefined) setMoving({ from: prof, to: moveTo });
    const { url, init } = restartRequest(prof, moveTo);
    const settle = (status: number, body: any) => {
      if (profileRef.current === prof) dispatchRestart({ type: "response", status, body, lang });
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
    ask({ title: t("leave.title"), body: configDiscardPrompt(lang), confirmLabel: t("leave.discard"), cancelLabel: t("configView.keepEditing"), destructive: true }).then((ok) => ok && go());
  };

  if (!props.profiles.length) return <p className="text-sm text-[var(--color-muted)]">{t("configView.noProfiles")}</p>;

  const sensitive: SensitiveChange[] = doc?.phase.kind === "confirming" ? sensitiveDiff(doc.open.content, doc.buffer, lang) : [];
  const receiverUp = profileView?.up ?? false;
  const restartBusy = restart.kind === "requesting" || restart.kind === "pending" || restart.kind === "restarting";
  const restartLine = restartText(restart, undefined, lang);
  const loadedRaw = open ? parseCheck(open.content) : null;
  const moveTo = loadedRaw?.ok ? moveTarget(loadedRaw.raw, profile) : null;
  // The Raw editor needs a bounded height to scroll internally; the form panes scroll with the page.
  const showRaw = pane === "raw" || !parsed?.ok;
  const saveBlocked = checks.length > 0;
  /** The card a problem sits on, if that card is rendered on the open pane. */
  const shownCard = (e: string) => {
    const c = parsed?.ok && !showRaw ? cardFor(e, parsed.raw) : null;
    return c && CARD_PANE[c.list] === pane ? c : null;
  };

  return (
    <div className={showRaw ? "flex h-[calc(100vh-8rem)] min-h-[24rem] min-w-0 flex-col" : "flex min-w-0 flex-col"}>
      {/* Below `sm` the path drops to its own row under the select + actions; desktop is one row. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm sm:flex-nowrap">
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
          <span data-config-path className="order-last w-full min-w-0 truncate font-mono text-xs text-[var(--color-muted)] sm:order-none sm:w-auto" title={open.path}>
            {open.path}
          </span>
        )}
        {phase === "saving" ? (
          <span className="shrink-0 text-[var(--color-muted)]">{t("configView.saving")}</span>
        ) : (
          dirty && <span className="shrink-0 text-status-held">{t("configView.modified")}</span>
        )}
        {open && (
          <button
            data-revert
            className="ml-auto shrink-0 rounded border border-[var(--color-border)] px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!dirty || (phase !== "editing" && phase !== "conflict")}
            title={t("configView.revertHint")}
            onClick={revert}
          >
            {t("configView.revert")}
          </button>
        )}
        {open && (
          // Client checks block with aria-disabled, not `disabled`: the click still lands, as a Save attempt.
          <button
            data-save
            className="shrink-0 rounded border border-[var(--color-border)] px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            disabled={!dirty || phase !== "editing" || !parsed?.ok}
            aria-disabled={saveBlocked || undefined}
            title={
              parsed && !parsed.ok
                ? t("configView.fixJson")
                : saveBlocked
                  ? t("configView.fixProblems", { count: checks.length })
                  : t("configView.saveHint")
            }
            onClick={requestSave}
          >
            {t("configView.save")}
          </button>
        )}
      </div>
      {file.kind === "loading" && <p className="text-sm">{t("configView.loading")}</p>}
      {file.kind === "error" && (
        <p className="text-sm text-status-failed">
          {file.status === 404 ? t("configView.noPath") : t("configView.loadFailed", { status: file.status })}
        </p>
      )}
      {file.kind === "ok" && open && doc && (
        <>
          {savedNote && (
            <div className="mb-2 flex flex-wrap items-center gap-3 rounded border border-[var(--color-accent)] bg-[var(--color-accent)]/10 px-3 py-1.5 text-sm sm:flex-nowrap">
              <span>{t("configView.saved")}</span>
              {restartLine && (
                <span
                  className={
                    restart.kind === "error" ? "text-status-failed" : restart.kind === "up" ? "text-status-done" : "text-[var(--color-muted)]"
                  }
                >
                  {restartLine}
                </span>
              )}
              {!receiverUp && !restartBusy && <span className="text-[var(--color-muted)]">{t("configView.notRunningApply")}</span>}
              <span className="ml-auto flex gap-2">
                <button
                  className="rounded border border-[var(--color-accent)] px-2 py-0.5 text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!receiverUp || restartBusy}
                  onClick={() => requestRestart()}
                >
                  {t("configView.restartIdle")}
                </button>
                <button aria-label={t("configView.dismiss")} onClick={() => setSavedNote(false)}>
                  ×
                </button>
              </span>
            </div>
          )}
          {moving ? (
            <div className="mb-2 flex flex-wrap items-center gap-3 rounded border border-[var(--color-accent)] bg-[var(--color-accent)]/10 px-3 py-1.5 text-sm sm:flex-nowrap">
              <span>
                {rich(t(restart.kind !== "up" ? "configView.moving" : profile === moving.to ? "configView.moved" : "configView.moveFailed"), {
                  from: MONO(`~/.agenthook/${moving.from}/`),
                  to: MONO(`~/.agenthook/${moving.to}/`),
                })}
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
                <button className="ml-auto" aria-label={t("configView.dismiss")} onClick={() => setMoving(null)}>
                  ×
                </button>
              )}
            </div>
          ) : (
            moveTo &&
            !dirty && (
              <div className="mb-2 flex flex-wrap items-center gap-3 rounded border border-[var(--color-border)] px-3 py-1.5 text-sm sm:flex-nowrap">
                <span>{rich(t("configView.labelDiffers"), { label: MONO(moveTo), key: MONO(profile) })}</span>
                {receiverUp ? (
                  <button
                    className="ml-auto shrink-0 rounded border border-[var(--color-accent)] px-2 py-0.5 text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={restartBusy}
                    onClick={() => setMoveConfirm(true)}
                  >
                    {t("configView.moveButton")}
                  </button>
                ) : (
                  <span className="text-[var(--color-muted)]">{rich(t("configView.moveNotRunning"), { cmd: MONO(`ah rename ${moveTo} --move`) })}</span>
                )}
              </div>
            )
          )}
          {(phase === "conflict" || phase === "deleted") && (
            <div className="mb-2 flex flex-wrap items-center gap-3 rounded border border-status-held bg-status-held-bg px-3 py-1.5 text-sm text-status-held sm:flex-nowrap">
              {t(phase === "deleted" ? "configView.deletedOnDisk" : "configView.changedOnDisk")}
              <span className="ml-auto flex gap-2">
                <button className="rounded border border-status-held px-2 py-0.5" onClick={() => load(open.profile)}>
                  {t("configView.reload")}
                </button>
                {phase === "conflict" && (
                  <>
                    <button className="rounded border border-status-held px-2 py-0.5" onClick={showDiff}>
                      {t("configView.diff")}
                    </button>
                    <button className="rounded border border-status-held px-2 py-0.5" onClick={overwrite}>
                      {t("configView.overwrite")}
                    </button>
                  </>
                )}
              </span>
            </div>
          )}
          {file.meta.literalSecrets.length > 0 && (
            <div className="mb-2 break-words rounded border border-status-held bg-status-held-bg px-3 py-1.5 text-sm text-status-held">
              {rich(t("configView.literalSecrets", { count: file.meta.literalSecrets.length }), {
                paths: MONO(file.meta.literalSecrets.join(", ")),
                ref: MONO("${VAR}"),
              })}
            </div>
          )}
          {(() => {
            const banner = bannerStatus(
              parsed && !parsed.ok ? parsed.error : null,
              checks,
              file.meta.errors,
              {
                onCard: (e) => shownCard(e) !== null,
                incomplete: (e) => {
                  const c = parsed?.ok ? cardFor(e, parsed.raw) : null;
                  return c !== null && pristine[c.list].has(c.index);
                },
              },
              lang,
            );
            const tone = banner.ok ? "ok" : banner.amber ? "held" : "failed";
            return (
              <div className="relative mb-2">
                <div
                  data-config-banner
                  data-tone={tone}
                  className={`flex h-8 items-center gap-2 rounded border px-3 text-sm ${
                    tone === "ok"
                      ? "border-status-done bg-status-done-bg text-status-done"
                      : tone === "held"
                        ? "border-status-held bg-status-held-bg text-status-held"
                        : "border-status-failed bg-status-failed-bg text-status-failed"
                  }`}
                >
                  {banner.ok ? (
                    <span className="truncate">{t("configView.valid", { meta: t(META_LABEL[file.meta.as]) })}</span>
                  ) : (
                    <>
                      <span className={`truncate text-xs ${banner.summary ? "" : "font-mono"}`} title={banner.fullFirst}>
                        {banner.first}
                      </span>
                      {(banner.moreCount > 0 || banner.fullFirst !== banner.first || banner.summary) && (
                        <button
                          type="button"
                          data-config-banner-toggle
                          className="ml-auto shrink-0 whitespace-nowrap underline"
                          onClick={() => setBannerOpen((o) => !o)}
                        >
                          {banner.moreCount > 0 ? t("configView.more", { count: banner.moreCount }) : banner.summary ? t("configView.list") : t("configView.fullText")}
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
                        <h4 className="mb-1 text-xs text-[var(--color-muted)]">{t("configView.checks")}</h4>
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
                        <h4 className="mb-1 text-xs text-[var(--color-muted)]">{t("configView.server", { meta: t(META_LABEL[file.meta.as]) })}</h4>
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
          {/* Scrolls sideways when it doesn't fit (never wraps); a fade marks each side with hidden tabs.
              The baseline is an inset shadow, not a border the tabs overlap with -mb-px — that 1px
              would overflow the scroll box vertically. */}
          <div className="relative mb-2">
            <div
              ref={tabRow}
              data-config-tabs
              onScroll={measureTabs}
              className="flex flex-nowrap gap-1 overflow-x-auto text-sm shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:thin]"
            >
              {PANES.map((p) => (
                <button
                  key={p}
                  data-config-pane={p}
                  className={`${TOUCH} shrink-0 border-b-2 px-3 py-0.5 capitalize disabled:cursor-not-allowed disabled:opacity-50 ${p === pane ? "border-[var(--color-accent)]" : "border-transparent text-[var(--color-muted)]"}`}
                  disabled={p !== "raw" && !parsed?.ok}
                  title={p !== "raw" && !parsed?.ok ? t("configView.fixInRaw") : undefined}
                  onClick={() => switchPane(p)}
                >
                  {t(PANE_LABEL[p])}
                </button>
              ))}
            </div>
            {tabEdges.start && <span data-tab-fade="start" className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-linear-to-r from-[var(--color-bg)] to-transparent" />}
            {tabEdges.end && <span data-tab-fade="end" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-[var(--color-bg)] to-transparent" />}
          </div>
          {!parsed?.ok && <p className="-mt-1 mb-2 text-xs text-[var(--color-muted)]">{t("configView.fixInRaw")}</p>}
          <div className="mb-2 rounded border border-[var(--color-border)]">
            <button
              className="flex min-h-10 w-full items-center gap-2 px-2 py-1 text-left text-xs uppercase tracking-wide text-[var(--color-muted)] sm:min-h-0"
              onClick={() => setGraphOpen((o) => !o)}
            >
              <span>{graphOpen ? "▾" : "▸"}</span>
              {t("configView.graph")}
            </button>
            {graphOpen && (
              // Height-capped on phones so the form below stays reachable; the graph scrolls inside.
              <div data-config-graph className="max-h-64 overflow-auto border-t border-[var(--color-border)] p-2 sm:max-h-none sm:overflow-visible">
                {parsed?.ok ? (
                  <PipelineGraph
                    layout={layoutPipeline(
                      readSteps(parsed.raw),
                      stageKeysFor(stages?.profile === profile ? stages.body : null, (parsed.raw as any)?.tracker?.type),
                      stages?.profile === profile ? stages.body?.stages : null,
                      (parsed.raw as any)?.agent,
                      lang,
                    )}
                    onSelectStep={selectStep}
                  />
                ) : (
                  <p className="text-sm text-[var(--color-muted)]">{t("configView.graphFix")}</p>
                )}
              </div>
            )}
          </div>
          <div className={showRaw ? "flex min-h-0 min-w-0 flex-1" : "flex min-w-0 flex-col"}>
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
                  <IntegrationsForm text={doc.buffer} raw={parsed.raw} onEdit={(buffer) => act({ type: "edit", buffer })} cards={cardHooks} />
                ) : pane === "repos" ? (
                  <ReposForm text={doc.buffer} raw={parsed.raw} onEdit={(buffer) => act({ type: "edit", buffer })} cards={cardHooks} />
                ) : (
                  <PipelineForm
                    text={doc.buffer}
                    raw={parsed.raw}
                    stages={stages?.profile === profile ? stages : null}
                    onRefresh={() => fetchStages(profile)}
                    onEdit={(buffer) => act({ type: "edit", buffer })}
                    errors={perStep}
                    focus={focus}
                    cards={cardHooks}
                  />
                )}
              </ConfirmContext.Provider>
            </div>
          </div>
        </>
      )}
      {doc?.phase.kind === "confirming" && (
        <Modal title={t("configView.saveTitle")} onClose={() => act({ type: "cancel" })}>
          <p className="mb-2 text-sm text-[var(--color-muted)]">{t("configView.saveBody")}</p>
          {sensitive.length > 0 && (
            <div className="mb-2 rounded border border-status-held bg-status-held-bg px-3 py-2 text-sm text-status-held">
              <p className="mb-1 font-semibold">{t("configView.sensitiveChange")}</p>
              <ul className="mb-2 break-all font-mono text-xs">
                {sensitive.map((c) => (
                  <li key={c.path}>
                    {sensitiveLabel(c.path, lang)}: {c.from} → {c.to}
                  </li>
                ))}
              </ul>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                {t("configView.ack")}
              </label>
            </div>
          )}
          <DiffLegend />
          <DiffView a={doc.open.content} b={doc.buffer} language={JSON_LANG} />
          <div className="mt-3 flex justify-end gap-2">
            <button className="rounded border border-[var(--color-border)] px-3 py-1" onClick={() => act({ type: "cancel" })}>
              {t("configView.cancel")}
            </button>
            <button
              className="rounded border border-[var(--color-accent)] px-3 py-1 text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={sensitive.length > 0 && !ack}
              onClick={() => put("confirm")}
            >
              {t("configView.save")}
            </button>
          </div>
        </Modal>
      )}
      {moveConfirm && moveTo && (
        <Modal title={t("configView.moveTitle")} onClose={() => setMoveConfirm(false)}>
          <div className="space-y-2 text-sm">
            <p>{rich(t("configView.moveBody"), { from: MONO(`~/.agenthook/${profile}/`), to: MONO(`~/.agenthook/${moveTo}/`) })}</p>
            <p>{rich(t("configView.moveApplied"), { stateId: MONO("stateId"), to: MONO(moveTo), from: MONO(profile) })}</p>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button className="rounded border border-[var(--color-border)] px-3 py-1" onClick={() => setMoveConfirm(false)}>
              {t("configView.cancel")}
            </button>
            <button
              className="rounded border border-[var(--color-accent)] px-3 py-1 text-[var(--color-accent)]"
              onClick={() => {
                setMoveConfirm(false);
                requestRestart(moveTo);
              }}
            >
              {t("configView.moveWhenIdle")}
            </button>
          </div>
        </Modal>
      )}
      {diff && doc?.phase.kind === "conflict" && (
        <Modal title={t("configView.diffTitle")} onClose={() => setDiff(false)}>
          <DiffLegend />
          {doc.phase.content === null ? (
            <p className="text-sm">{t("configView.diffLoading")}</p>
          ) : (
            <DiffView a={doc.phase.content} b={doc.buffer} language={JSON_LANG} />
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button className="rounded border border-[var(--color-border)] px-3 py-1" onClick={() => setDiff(false)}>
              {t("configView.close")}
            </button>
            <button className="rounded border border-status-held px-3 py-1 text-status-held" onClick={overwrite}>
              {t("configView.overwrite")}
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div role="alert" className="fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded border border-status-failed bg-[var(--color-bg)] px-3 py-2 text-sm text-status-failed shadow">
          {toast}
          <button aria-label={t("configView.dismiss")} onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
      {confirmModal}
    </div>
  );
}
