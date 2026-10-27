import { Suspense, lazy, useEffect, useReducer, useRef, useState } from "react";
import type { ProfileView, Snapshot } from "./contract";
import { subscribe } from "./stream";
import { applyEvent, clearRemovedProfile } from "./state";
import { appendFeed, isHiddenFeedEvent } from "./feed";
import { epicChangedRefetches } from "./epics";
import type { FeedEntry } from "./feed";
import { initFetchState, startFetch, bufferEvent, resolveFetch, failFetch, isBuffering } from "./snapshotFetch";
import type { FetchState } from "./snapshotFetch";
import { TicketDrawer } from "./TicketDrawer";
import { useDeferredDismiss } from "./deferredDismiss";
import { isUndoKey } from "./shortcuts";
import { affectsRuns } from "./logview";
import { discardPrompt } from "./instructions";
import type { InstructionsEvent } from "./instructions";
import { configDiscardPrompt, RESTART_IDLE, dismissRequest, queueToggleRequest, releaseOutcome, releaseRequest, restartRequest, restartText, retryOutcome, retryRequest } from "./config";
import type { ReleaseOutcome } from "./config";
import type { ConfigSinkEvent } from "./config";
import { RemoveProfile } from "./RemoveProfile";
import { pendingText } from "./remove";
import { queueToggleText, restartsReducer, rowActions } from "./profileActions";
import { AppBar } from "./AppBar";
import type { ProfileNav } from "./AppBar";
import { HomePage } from "./HomePage";
import { HOME, hashFor, parseHash } from "./route";
import { useLeaveGuard } from "./leaveGuard";
import type { Route, View } from "./route";
import { connectionState } from "./connection";
import type { ConnectionState } from "./connection";
import { LiveContext } from "./components";
import type { MenuItem } from "./components";
import { I18nProvider, rich, useT } from "./i18n/react";
import { Overview } from "./Overview";

// CodeMirror + react-markdown load only when the Instructions / Config tab is opened.
const InstructionsView = lazy(() => import("./InstructionsView"));
const ConfigView = lazy(() => import("./ConfigView"));
const StatsView = lazy(() => import("./StatsView"));
const EpicsView = lazy(() => import("./EpicsView"));

type LoadState = { kind: "loading" } | { kind: "unauthorized" } | { kind: "error"; status: number } | { kind: "ok"; snapshot: Snapshot };

/** The dashboard under the language provider: a reading-panel language change re-renders it in place. */
export default function App() {
  return (
    <I18nProvider>
      <Dashboard />
    </I18nProvider>
  );
}

function Dashboard() {
  const { t, lang } = useT();
  // The stream / key / fetch callbacks below are set up once; they read the current language through this.
  const tRef = useRef(t);
  tRef.current = t;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [connected, setConnected] = useState(false);
  // CLOSED means the EventSource gave up for good (e.g. a 401) — the browser
  // will not retry it, so the app bar's dot says "disconnected", not "reconnecting".
  const [closed, setClosed] = useState(false);
  // Only the latest fetch's response may land — see snapshotFetch.ts.
  const fetchState = useRef<FetchState>(initFetchState());
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [epicFilter, setEpicFilter] = useState<string>("");
  const [showAll, setShowAll] = useState(false);
  // The ticket whose runs/log panel is open. The stream callback reads it via a ref.
  const [open, setOpen] = useState<{ profile: string; ref: string } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [runsNonce, setRunsNonce] = useState(0);
  // Bumped per `ticket` SSE event of the routed profile: the Epics view refetches off it (debounced).
  const [ticketsNonce, setTicketsNonce] = useState(0);
  // Hash routing, no router lib: `#/` Home, `#/p/<key>[/<view>]` a profile (route.ts). The
  // Instructions / Config views report their dirty buffer here so leaving them (a tab, Home, the
  // back button) can confirm before discarding it, and receive their SSE events via the sinks.
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const routeRef = useRef(route);
  routeRef.current = route;
  const instructionsDirty = useRef(false);
  const instructionsSink = useRef<((ev: InstructionsEvent) => void) | null>(null);
  const configDirty = useRef(false);
  const configSink = useRef<((ev: ConfigSinkEvent) => void) | null>(null);
  // Remove…: the profile whose modal is open, the decommissions pending per state key (→ label,
  // for the "Removed" toast on its profile_removed), and the one toast.
  const [removing, setRemoving] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<Record<string, string>>({});
  const pendingRemovalRef = useRef(pendingRemoval);
  pendingRemovalRef.current = pendingRemoval;
  const [toast, setToast] = useState<{ text: string; hint: string | null; undo?: () => void } | null>(null);
  const dismissal = useDeferredDismiss((d) => {
    const { url, init } = dismissRequest(d.profile, d.ref);
    fetch(url, { ...init, keepalive: true })
      .then(async (res) => {
        if (res.ok) return; // the row flips to idle off the stream
        const why = await res.json().then((b: { error?: string }) => b.error, () => undefined);
        const tr = tRef.current;
        setToast({ text: tr("app.dismissFailed", { error: why ?? tr("remove.error.statusN", { status: res.status }) }), hint: null });
      })
      .catch(() => setToast({ text: tRef.current("app.dismissUnreachable"), hint: null }));
  });
  // Restart when idle from a row's ⋯ menu: per-state-key restartReducer state, fed by the POST
  // reply, the profile's restart feed events and snapshot/profile updates (no polling).
  const [restarts, dispatchRestarts] = useReducer(restartsReducer, {});
  const snapshotProfiles = state.kind === "ok" ? state.snapshot.profiles : null;
  const snapshotProfilesRef = useRef(snapshotProfiles);
  snapshotProfilesRef.current = snapshotProfiles;

  useEffect(() => {
    if (snapshotProfiles) dispatchRestarts({ type: "profiles", profiles: snapshotProfiles });
  }, [snapshotProfiles]);

  useEffect(() => {
    // A finished or failed restart becomes a toast and leaves the row.
    for (const [key, s] of Object.entries(restarts)) {
      if (s.kind !== "up" && s.kind !== "error") continue;
      const label = snapshotProfilesRef.current?.find((p) => p.name === key)?.label ?? key;
      setToast({ text: `${label}: ${restartText(s, t("restart.restarted"), lang)}`, hint: null });
      dispatchRestarts({ type: "one", profile: key, action: { type: "reset" } });
    }
  }, [restarts]);

  // Leaving a view with an unsaved buffer asks first, in the in-app modal (leaveGuard.tsx).
  const leaveModal = useLeaveGuard({
    route: () => routeRef.current,
    prompt: (cur) => {
      if (cur.kind !== "profile") return null;
      if (cur.view === "instructions") return instructionsDirty.current ? discardPrompt(lang) : null;
      return cur.view === "config" && configDirty.current ? configDiscardPrompt(lang) : null;
    },
    go: (next) => {
      setStatusFilter("");
      setEpicFilter("");
      setRoute(next);
    },
  });

  // Ctrl/⌘+Z brings back the last dismissed row (while it is still undoable) and puts focus on it,
  // so a keyboard d is as reversible as a click. Text fields keep their own undo.
  const undoLastRef = useRef(dismissal.undoLast);
  undoLastRef.current = dismissal.undoLast;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isUndoKey(e)) return;
      const d = undoLastRef.current();
      if (!d) return;
      e.preventDefault();
      setToast({ text: tRef.current("app.dismissUndone"), hint: null });
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-needs-row="${CSS.escape(d.ref)}"] [data-needs-open]`)?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    // A webhook hint is a command to copy: it stays until dismissed.
    if (!toast || toast.hint) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const fetchSnapshot = () => {
      const { state: next, gen } = startFetch(fetchState.current);
      fetchState.current = next;
      fetch("/api/snapshot")
        .then((res) => {
          if (res.status === 401) {
            fetchState.current = failFetch(fetchState.current, gen);
            return setState({ kind: "unauthorized" });
          }
          if (!res.ok) {
            fetchState.current = failFetch(fetchState.current, gen);
            return setState({ kind: "error", status: res.status });
          }
          return res.json().then((snapshot: Snapshot) => {
            const { state: next, snapshot: resolved } = resolveFetch(fetchState.current, gen, snapshot);
            fetchState.current = next;
            if (resolved) setState({ kind: "ok", snapshot: resolved });
          });
        })
        .catch(() => {
          fetchState.current = failFetch(fetchState.current, gen);
          setState({ kind: "error", status: 0 });
        });
    };

    // First paint never depends on the stream connecting.
    fetchSnapshot();

    const unsubscribe = subscribe({
      onOpen: () => {
        setConnected(true);
        setClosed(false);
        fetchSnapshot();
      },
      onError: () => setConnected(false),
      onClosed: () => {
        setConnected(false);
        setClosed(true);
        fetchSnapshot();
      },
      onEvent: (ev) => {
        // The feed is not part of Snapshot, so it bypasses the fetch-in-flight
        // buffer entirely — a re-fetch or reconnect can never drop or clear it.
        // Instruction edits aren't part of Snapshot either — straight to the open view, if any.
        if (ev.type === "instructions") {
          instructionsSink.current?.(ev);
          return;
        }
        // Config edits likewise; feed events also reach the Config view (its restart banner).
        if (ev.type === "config") {
          configSink.current?.(ev);
          return;
        }
        if (ev.type === "event") {
          configSink.current?.(ev);
          dispatchRestarts({ type: "one", profile: ev.profile, action: { type: "event", event: ev.event } });
          if (!isHiddenFeedEvent(ev.event.event)) setFeed((f) => appendFeed(f, ev));
          const o = openRef.current;
          if (o && affectsRuns(ev, o.profile, o.ref)) setRunsNonce((n) => n + 1);
          if (epicChangedRefetches(routeRef.current, ev.profile, ev.event)) setTicketsNonce((n) => n + 1);
          return;
        }
        // Navigate away from a removed profile whether or not the snapshot is mid-fetch.
        if (ev.type === "profile_removed") {
          setOpen(clearRemovedProfile({ open: openRef.current, profileFilter: "" }, ev.name).open);
          const here = routeRef.current;
          if (here.kind === "profile" && here.profile === ev.name) window.location.hash = hashFor(HOME);
          setRemoving((r) => (r === ev.name ? null : r));
          const label = pendingRemovalRef.current[ev.name];
          if (label !== undefined) {
            setPendingRemoval(({ [ev.name]: _, ...rest }) => rest);
            setToast({ text: tRef.current("app.removed", { label }), hint: null });
          }
        }
        if (ev.type === "ticket" || ev.type === "ticket_removed") {
          const here = routeRef.current;
          const profile = ev.type === "ticket" ? ev.ticket.profile : ev.profile;
          if (here.kind === "profile" && here.view === "epics" && here.profile === profile) setTicketsNonce((n) => n + 1);
        }
        if (isBuffering(fetchState.current)) {
          fetchState.current = bufferEvent(fetchState.current, ev);
          return;
        }
        setState((s) => (s.kind === "ok" ? { kind: "ok", snapshot: applyEvent(s.snapshot, ev) } : s));
      },
    });

    return unsubscribe;
  }, []);

  const connection = connectionState(connected, closed);
  if (state.kind === "loading") return <Shell connection={connection}>{t("app.loading")}</Shell>;
  if (state.kind === "unauthorized")
    return (
      <Shell connection={connection}>
        {rich(t("app.unauthorized"), { cmd: <code className="font-mono">ah ui</code> })}
      </Shell>
    );
  if (state.kind === "error") return <Shell connection={connection}>{t("app.snapshotError", { status: state.status })}</Shell>;

  const go = (next: Route) => {
    window.location.hash = hashFor(next);
  };
  const now = Date.now();
  const snapshot = state.snapshot;
  const requestRestart = (p: ProfileView) => {
    dispatchRestarts({ type: "one", profile: p.name, action: { type: "request", pid: p.pid } });
    const { url, init } = restartRequest(p.name);
    const respond = (status: number, body: any) => dispatchRestarts({ type: "one", profile: p.name, action: { type: "response", status, body, lang } });
    fetch(url, init)
      .then((res) => res.json().then((b) => respond(res.status, b), () => respond(res.status, null)))
      .catch(() => respond(0, null));
  };
  const toggleQueue = (cmd: "pause" | "resume", p: ProfileView) => {
    const { url, init } = queueToggleRequest(cmd, p.name);
    const report = (status: number, body: any) => setToast({ text: queueToggleText(cmd, p.label, status, body, lang), hint: null });
    fetch(url, init)
      .then((res) => res.json().then((b) => report(res.status, b), () => report(res.status, null)))
      .catch(() => report(0, null));
  };
  const displayIdFor = (profile: string, ref: string) => snapshot.tickets.find((x) => x.profile === profile && x.ref === ref)?.displayId ?? null;
  /** POST /api/release for a held ticket, toasting the outcome (Overview and the epic page share it). */
  const release = (r: { profile: string; ref: string }, comment: string): Promise<ReleaseOutcome> => {
    const { url, init } = releaseRequest(r.profile, r.ref, comment);
    const label = displayIdFor(r.profile, r.ref) ?? r.ref;
    const settle = (status: number, body: any) => {
      const out = releaseOutcome(label, status, body, lang);
      if (out.ok) setToast({ text: out.text, hint: null });
      return out;
    };
    return fetch(url, init)
      .then((res) => res.json().then((b) => settle(res.status, b), () => settle(res.status, null)))
      .catch(() => settle(0, null));
  };
  /** Dismiss a failed ticket, toasting it with Undo (Overview and the epic page share it). */
  const dismiss = (d: { profile: string; ref: string }) => {
    dismissal.dismiss(d);
    const id = displayIdFor(d.profile, d.ref) ?? d.ref;
    setToast({ text: t("app.dismissed", { id }), hint: null, undo: () => dismissal.undo(d) });
  };
  /** POST /api/retry for a failed ticket, toasting the outcome. */
  const retry = (r: { profile: string; ref: string }): Promise<ReleaseOutcome> => {
    const { url, init } = retryRequest(r.profile, r.ref);
    const label = displayIdFor(r.profile, r.ref) ?? r.ref;
    const settle = (status: number, body: any) => {
      const out = retryOutcome(label, status, body, lang);
      if (out.ok) setToast({ text: out.text, hint: null });
      return out;
    };
    return fetch(url, init)
      .then((res) => res.json().then((b) => settle(res.status, b), () => settle(res.status, null)))
      .catch(() => settle(0, null));
  };
  // The ⋯ menu: Home cards and the profile header share it. Pending states come from App's reducers.
  const menuItems = (p: ProfileView): MenuItem[] => {
    const pending = pendingRemoval[p.name] !== undefined;
    const actions = rowActions(p, restarts[p.name] ?? RESTART_IDLE, pending);
    return [
      { label: t("menu.openConfig"), onSelect: () => go({ kind: "profile", profile: p.name, view: "config" }) },
      { label: t("menu.openInstructions"), onSelect: () => go({ kind: "profile", profile: p.name, view: "instructions" }) },
      {
        label: t("menu.copyConfigPath"),
        disabled: !p.configPath,
        onSelect: () =>
          navigator.clipboard.writeText(p.configPath!).then(
            () => setToast({ text: t("app.copiedPath"), hint: null }),
            () => {},
          ),
      },
      { label: t("menu.restartWhenIdle"), disabled: actions.restartDisabled, onSelect: () => requestRestart(p) },
      actions.toggle === "pause"
        ? { label: t("menu.pause"), disabled: actions.toggleDisabled, onSelect: () => toggleQueue("pause", p) }
        : { label: t("menu.resume"), disabled: actions.toggleDisabled, onSelect: () => toggleQueue("resume", p) },
      { label: t("menu.remove"), danger: true, disabled: pending, onSelect: () => setRemoving(p.name) },
    ];
  };
  // The one status line under a profile: a removal pending, else the restart progress.
  const noteFor = (p: ProfileView) => (pendingRemoval[p.name] !== undefined ? pendingText(p, lang) : restartText(restarts[p.name] ?? RESTART_IDLE, undefined, lang) ?? "");

  let nav: ProfileNav | undefined;
  let page: React.ReactNode;
  if (route.kind === "home") {
    page = <HomePage snapshot={snapshot} now={now} menuItems={menuItems} note={noteFor} />;
  } else {
    const profile = snapshot.profiles.find((p) => p.name === route.profile);
    nav = {
      profile: route.profile,
      profiles: snapshot.profiles,
      view: route.view,
      onView: (view: View) => go({ kind: "profile", profile: route.profile, view }),
      onProfile: (name) => go({ kind: "profile", profile: name, view: route.view }),
      onHome: () => go(HOME),
      now,
    };
    if (!profile) {
      page = (
        <p className="text-body text-muted">
          {rich(t("app.noProfile"), {
            name: <code className="font-mono">{route.profile}</code>,
            back: (
              <a className="text-accent underline" href={hashFor(HOME)}>
                {t("app.backHome")}
              </a>
            ),
          })}
        </p>
      );
    } else if (route.view === "instructions") {
      page = (
        <Suspense fallback={<p className="text-sm">{t("app.loadingEditor")}</p>}>
          <InstructionsView
            key={profile.name}
            profiles={[profile]}
            initialProfile={profile.name}
            eventSink={instructionsSink}
            onDirtyChange={(d) => (instructionsDirty.current = d)}
          />
        </Suspense>
      );
    } else if (route.view === "stats") {
      page = (
        <Suspense fallback={<p className="text-sm">{t("app.loadingStats")}</p>}>
          <StatsView key={profile.name} profile={profile} feed={feed.filter((f) => f.profile === profile.name)} />
        </Suspense>
      );
    } else if (route.view === "epics") {
      page = (
        <Suspense fallback={<p className="text-sm">{t("app.loadingEpics")}</p>}>
          <EpicsView
            key={profile.name}
            profile={profile}
            epic={route.epic}
            rows={snapshot.tickets.filter((x) => x.profile === profile.name)}
            ticketsNonce={ticketsNonce}
            onOpen={setOpen}
            onRelease={release}
            onRetry={retry}
            onDismiss={dismiss}
            dismissing={dismissal.pending}
          />
        </Suspense>
      );
    } else if (route.view === "config") {
      page = (
        <Suspense fallback={<p className="text-sm">{t("app.loadingEditor")}</p>}>
          <ConfigView key={profile.name} profiles={[profile]} initialProfile={profile.name} eventSink={configSink} onDirtyChange={(d) => (configDirty.current = d)} />
        </Suspense>
      );
    } else {
      page = (
        <Overview
          profile={profile}
          snapshot={snapshot}
          now={now}
          feed={feed.filter((f) => f.profile === profile.name)}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          epicFilter={epicFilter}
          setEpicFilter={setEpicFilter}
          showAll={showAll}
          setShowAll={setShowAll}
          open={open}
          onOpen={setOpen}
          displayIdFor={displayIdFor}
          menuItems={menuItems(profile)}
          note={noteFor(profile)}
          onRelease={release}
          onRetry={retry}
          dismissing={dismissal.pending}
          onDismiss={dismiss}
        />
      );
    }
  }

  return (
    <Shell connection={connection} nav={nav}>
      {page}
      {open && (
        <TicketDrawer
          key={`${open.profile}\u0000${open.ref}`}
          profile={open.profile}
          ticketRef={open.ref}
          ticket={snapshot.tickets.find((x) => x.profile === open.profile && x.ref === open.ref)}
          runsNonce={runsNonce}
          onClose={() => setOpen(null)}
          onRelease={release}
        />
      )}
      {removing && (
        <RemoveProfile
          profile={removing}
          onClose={() => setRemoving(null)}
          onArchived={(r) => {
            setRemoving(null);
            setToast({ text: t("app.archived", { path: r.archivedTo }), hint: r.webhookHint });
          }}
          onPending={() => {
            const label = snapshot.profiles.find((p) => p.name === removing)?.label ?? removing;
            setPendingRemoval((m) => ({ ...m, [removing]: label }));
            setRemoving(null);
          }}
        />
      )}
      {toast && (
        <div role="status" data-toast className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-surface-raised px-3 py-2 text-body shadow-lg">
          <div>
            <div>{toast.text}</div>
            {toast.hint && (
              <div className="mt-1">
                {rich(t("app.webhooksHint"), { cmd: <code className="font-mono">{toast.hint}</code> })}
              </div>
            )}
          </div>
          {toast.undo && (
            <button
              type="button"
              data-toast-undo
              className="rounded-md border border-border px-2 py-0.5 text-label font-medium hover:bg-surface-raised"
              onClick={() => {
                toast.undo!();
                setToast(null);
              }}
            >
              {t("app.undo")} <kbd className="font-mono text-meta text-muted">{/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘Z" : "Ctrl+Z"}</kbd>
            </button>
          )}
          <button type="button" aria-label={t("app.closeNotification")} onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
      {leaveModal}
    </Shell>
  );
}

/** The app bar over the page; `nav` absent (Home, loading / error screens) → no profile controls. */
function Shell({ children, ...bar }: { children: React.ReactNode; connection: ConnectionState; nav?: ProfileNav }) {
  const { t } = useT();
  return (
    <div className="min-h-screen bg-bg text-fg font-sans">
      {/* The router owns the hash, so the skip link focuses <main> itself instead of navigating. */}
      <a
        href="#main"
        data-skip-link
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-1 focus:text-label focus:text-fg"
      >
        {t("shell.skip")}
      </a>
      <AppBar {...bar} />
      <main id="main" tabIndex={-1} className="p-4 focus:outline-none">
        {/* Time labels tick only while the stream is live; down, they hold their last reading (#579). */}
        <LiveContext.Provider value={bar.connection === "connected"}>{children}</LiveContext.Provider>
      </main>
    </div>
  );
}
