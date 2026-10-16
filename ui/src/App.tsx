import { Suspense, lazy, useEffect, useReducer, useRef, useState } from "react";
import type { ProfileView, Snapshot } from "./contract";
import { formatCost, formatDate, profileLabel, profileBadge } from "./format";
import { subscribe } from "./stream";
import { applyEvent, clearRemovedProfile } from "./state";
import { scopeToProfile, summarize } from "./summary";
import { appendFeed, isHiddenFeedEvent, readRailOpen, writeRailOpen } from "./feed";
import type { FeedEntry } from "./feed";
import { ActivityRail } from "./ActivityRail";
import { initFetchState, startFetch, bufferEvent, resolveFetch, failFetch, isBuffering } from "./snapshotFetch";
import type { FetchState } from "./snapshotFetch";
import { TicketDrawer } from "./TicketDrawer";
import { TicketsTable } from "./TicketsTable";
import { affectsRuns } from "./logview";
import { DISCARD_PROMPT } from "./instructions";
import type { InstructionsEvent } from "./instructions";
import { CONFIG_DISCARD_PROMPT, RESTART_IDLE, dismissRequest, queueToggleRequest, restartRequest, restartText } from "./config";
import type { ConfigSinkEvent } from "./config";
import { RemoveProfile } from "./RemoveProfile";
import { pendingText } from "./remove";
import { queueToggleText, restartsReducer, rowActions } from "./profileActions";
import { AppBar } from "./AppBar";
import type { ProfileNav } from "./AppBar";
import { HomePage } from "./HomePage";
import { HOME, hashFor, parseHash, sameRoute } from "./route";
import type { Route, View } from "./route";
import { connectionState } from "./connection";
import type { ConnectionState } from "./connection";
import { FullAutoShield, Menu, Pill } from "./components";
import type { MenuItem } from "./components";

// CodeMirror + react-markdown load only when the Instructions / Config tab is opened.
const InstructionsView = lazy(() => import("./InstructionsView"));
const ConfigView = lazy(() => import("./ConfigView"));

type LoadState = { kind: "loading" } | { kind: "unauthorized" } | { kind: "error"; status: number } | { kind: "ok"; snapshot: Snapshot };

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [connected, setConnected] = useState(false);
  // CLOSED means the EventSource gave up for good (e.g. a 401) — the browser
  // will not retry it, so the app bar's dot says "disconnected", not "reconnecting".
  const [closed, setClosed] = useState(false);
  // Only the latest fetch's response may land — see snapshotFetch.ts.
  const fetchState = useRef<FetchState>(initFetchState());
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [railOpen, setRailOpen] = useState<boolean>(() => readRailOpen());
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [showAll, setShowAll] = useState(false);
  // The ticket whose runs/log panel is open. The stream callback reads it via a ref.
  const [open, setOpen] = useState<{ profile: string; ref: string } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [runsNonce, setRunsNonce] = useState(0);
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
  const [toast, setToast] = useState<{ text: string; hint: string | null } | null>(null);
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
      setToast({ text: `${label}: ${restartText(s, "restarted")}`, hint: null });
      dispatchRestarts({ type: "one", profile: key, action: { type: "reset" } });
    }
  }, [restarts]);

  useEffect(() => {
    // Every navigation (link, tab, back/forward) arrives as a hashchange. Leaving a view with an
    // unsaved buffer asks first; declining puts the old hash back without adding a history entry.
    const onHash = () => {
      const next = parseHash(window.location.hash);
      const cur = routeRef.current;
      if (sameRoute(cur, next)) return;
      if (cur.kind === "profile") {
        const dirty = cur.view === "instructions" ? instructionsDirty.current : cur.view === "config" ? configDirty.current : false;
        if (dirty && !window.confirm(cur.view === "instructions" ? DISCARD_PROMPT : CONFIG_DISCARD_PROMPT)) {
          window.history.replaceState(null, "", hashFor(cur));
          return;
        }
      }
      setStatusFilter("");
      setRoute(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    // A webhook hint is a command to copy: it stays until dismissed.
    if (!toast || toast.hint) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
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
            setToast({ text: `Removed ${label}`, hint: null });
          }
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
  if (state.kind === "loading") return <Shell connection={connection}>Loading…</Shell>;
  if (state.kind === "unauthorized")
    return (
      <Shell connection={connection}>
        Unauthorized — open the URL printed by <code className="font-mono">ah ui</code> to exchange its token.
      </Shell>
    );
  if (state.kind === "error") return <Shell connection={connection}>Failed to load snapshot (status {state.status}).</Shell>;

  const go = (next: Route) => {
    window.location.hash = hashFor(next);
  };
  const now = Date.now();
  const snapshot = state.snapshot;
  const requestRestart = (p: ProfileView) => {
    dispatchRestarts({ type: "one", profile: p.name, action: { type: "request", pid: p.pid } });
    const { url, init } = restartRequest(p.name);
    const respond = (status: number, body: any) => dispatchRestarts({ type: "one", profile: p.name, action: { type: "response", status, body } });
    fetch(url, init)
      .then((res) => res.json().then((b) => respond(res.status, b), () => respond(res.status, null)))
      .catch(() => respond(0, null));
  };
  const toggleQueue = (cmd: "pause" | "resume", p: ProfileView) => {
    const { url, init } = queueToggleRequest(cmd, p.name);
    const report = (status: number, body: any) => setToast({ text: queueToggleText(cmd, p.label, status, body), hint: null });
    fetch(url, init)
      .then((res) => res.json().then((b) => report(res.status, b), () => report(res.status, null)))
      .catch(() => report(0, null));
  };
  const displayIdFor = (profile: string, ref: string) => snapshot.tickets.find((t) => t.profile === profile && t.ref === ref)?.displayId ?? null;
  // The ⋯ menu: Home cards and the profile header share it. Pending states come from App's reducers.
  const menuItems = (p: ProfileView): MenuItem[] => {
    const pending = pendingRemoval[p.name] !== undefined;
    const actions = rowActions(p, restarts[p.name] ?? RESTART_IDLE, pending);
    return [
      { label: "Open config", onSelect: () => go({ kind: "profile", profile: p.name, view: "config" }) },
      { label: "Open instructions", onSelect: () => go({ kind: "profile", profile: p.name, view: "instructions" }) },
      {
        label: "Copy config path",
        disabled: !p.configPath,
        onSelect: () =>
          navigator.clipboard.writeText(p.configPath!).then(
            () => setToast({ text: "Copied config path", hint: null }),
            () => {},
          ),
      },
      { label: "Restart when idle", disabled: actions.restartDisabled, onSelect: () => requestRestart(p) },
      actions.toggle === "pause"
        ? { label: "Pause new runs", disabled: actions.toggleDisabled, onSelect: () => toggleQueue("pause", p) }
        : { label: "Resume", disabled: actions.toggleDisabled, onSelect: () => toggleQueue("resume", p) },
      { label: "Remove…", danger: true, disabled: pending, onSelect: () => setRemoving(p.name) },
    ];
  };
  // The one status line under a profile: a removal pending, else the restart progress.
  const noteFor = (p: ProfileView) => (pendingRemoval[p.name] !== undefined ? pendingText(p) : restartText(restarts[p.name] ?? RESTART_IDLE) ?? "");

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
    };
    if (!profile) {
      page = (
        <p className="text-body text-muted">
          No profile named <code className="font-mono">{route.profile}</code>. <a className="text-accent underline" href={hashFor(HOME)}>Back to Home</a>
        </p>
      );
    } else if (route.view === "instructions") {
      page = (
        <Suspense fallback={<p className="text-sm">Loading editor…</p>}>
          <InstructionsView
            key={profile.name}
            profiles={[profile]}
            initialProfile={profile.name}
            eventSink={instructionsSink}
            onDirtyChange={(d) => (instructionsDirty.current = d)}
          />
        </Suspense>
      );
    } else if (route.view === "config") {
      page = (
        <Suspense fallback={<p className="text-sm">Loading editor…</p>}>
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
          railOpen={railOpen}
          toggleRail={() => {
            const next = !railOpen;
            setRailOpen(next);
            writeRailOpen(next);
          }}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          showAll={showAll}
          setShowAll={setShowAll}
          open={open}
          setOpen={setOpen}
          displayIdFor={displayIdFor}
          menuItems={menuItems(profile)}
          note={noteFor(profile)}
          onDismiss={(t) => {
            const { url, init } = dismissRequest(t.profile, t.ref);
            fetch(url, init)
              .then(async (res) => {
                if (res.ok) return; // the row flips to idle off the stream
                const why = await res.json().then((b: { error?: string }) => b.error, () => undefined);
                setToast({ text: `Dismiss failed: ${why ?? `status ${res.status}`}`, hint: null });
              })
              .catch(() => setToast({ text: "Dismiss failed: dashboard unreachable", hint: null }));
          }}
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
          ticket={snapshot.tickets.find((t) => t.profile === open.profile && t.ref === open.ref)}
          runsNonce={runsNonce}
          onClose={() => setOpen(null)}
        />
      )}
      {removing && (
        <RemoveProfile
          profile={removing}
          onClose={() => setRemoving(null)}
          onArchived={(r) => {
            setRemoving(null);
            setToast({ text: `Archived to ${r.archivedTo}`, hint: r.webhookHint });
          }}
          onPending={() => {
            const label = snapshot.profiles.find((p) => p.name === removing)?.label ?? removing;
            setPendingRemoval((m) => ({ ...m, [removing]: label }));
            setRemoving(null);
          }}
        />
      )}
      {toast && (
        <div role="status" className="fixed bottom-4 right-4 z-50 flex items-start gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm shadow">
          <div>
            <div>{toast.text}</div>
            {toast.hint && (
              <div className="mt-1">
                Webhooks: run <code className="font-mono">{toast.hint}</code> (or skip if it never registered).
              </div>
            )}
          </div>
          <button aria-label="dismiss" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}
    </Shell>
  );
}

type OverviewProps = {
  profile: ProfileView;
  snapshot: Snapshot;
  now: number;
  feed: FeedEntry[];
  railOpen: boolean;
  toggleRail: () => void;
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  open: { profile: string; ref: string } | null;
  setOpen: (v: { profile: string; ref: string } | null) => void;
  displayIdFor: (profile: string, ref: string) => string | null;
  menuItems: MenuItem[];
  note: string;
  onDismiss: (t: { profile: string; ref: string }) => void;
};

/**
 * One profile's dashboard. Step 1 of the profile-focused UI keeps today's content (summary strip,
 * tickets table, activity rail) scoped to this profile; the Needs-you / Now / Progress zones replace it.
 */
function Overview(props: OverviewProps) {
  const { profile, snapshot, now, feed, railOpen, toggleRail, statusFilter, setStatusFilter, open, setOpen, displayIdFor } = props;
  const scoped = scopeToProfile(snapshot, profile.name);
  const summary = summarize(scoped, now);
  const needsYouActive = statusFilter === "needs-you";
  const needsYouTone = scoped.tickets.some((t) => t.status === "failed") ? "text-status-failed" : "text-status-held";
  return (
    <div className="xl:flex xl:items-start xl:gap-4">
      <div className="min-w-0 flex-1">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-title font-semibold">
            <ProfileNameCell p={profile} />
          </h1>
          <div className="ml-auto flex items-center gap-2">
            {props.note && <span className="text-label text-status-held">{props.note}</span>}
            <Menu label="profile actions" items={props.menuItems} />
          </div>
        </div>
        <div className="mb-4 flex flex-wrap gap-2" data-summary>
          <SummaryTile label="agents running">
            <span className="font-mono">
              {summary.active} <span className="text-muted">/ {summary.capacity}</span>
            </span>
          </SummaryTile>
          <button
            type="button"
            aria-pressed={needsYouActive}
            title={needsYouActive ? "show all statuses" : "show only held + failed tickets"}
            className={`min-w-32 rounded-lg border bg-surface px-3 py-2 text-left hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent ${
              needsYouActive ? "border-accent" : "border-border"
            }`}
            onClick={() => setStatusFilter(needsYouActive ? "" : "needs-you")}
          >
            <div className="text-label uppercase tracking-wide text-muted">needs you</div>
            <div className={`text-title font-semibold font-mono ${summary.needsYou > 0 ? needsYouTone : ""}`}>{summary.needsYou}</div>
          </button>
          <SummaryTile label="queued">
            <span className="font-mono">{summary.queued}</span>
          </SummaryTile>
          <SummaryTile label="cost today (approx.)" title="sum of run_end costs in the profile's last 256 KB of events">
            <span className="font-mono">{formatCost(summary.costToday)}</span>
          </SummaryTile>
        </div>

        <div className="mb-6 xl:hidden">
          <ActivityRail feed={feed} displayIdFor={displayIdFor} open={railOpen} onToggle={toggleRail} onOpen={setOpen} variant="panel" />
        </div>

        <TicketsTable
          tickets={scoped.tickets}
          profiles={scoped.profiles}
          now={now}
          profileFilter={profile.name}
          onProfileFilter={() => {}}
          lockProfile
          statusFilter={statusFilter}
          onStatusFilter={setStatusFilter}
          showAll={props.showAll}
          onShowAll={props.setShowAll}
          open={open}
          onOpen={setOpen}
          onDismiss={props.onDismiss}
        />
      </div>

      {railOpen ? (
        <aside
          data-activity-rail-wrap
          className="hidden xl:sticky xl:top-11 xl:block xl:h-[calc(100vh-2.75rem)] xl:w-90 xl:shrink-0 xl:rounded-lg xl:border xl:border-border xl:bg-surface"
        >
          <ActivityRail feed={feed} displayIdFor={displayIdFor} open={true} onToggle={toggleRail} onOpen={setOpen} variant="rail" />
        </aside>
      ) : (
        <aside data-activity-rail-wrap className="hidden xl:sticky xl:top-11 xl:block xl:shrink-0">
          <button
            type="button"
            data-activity-toggle
            aria-expanded={false}
            onClick={toggleRail}
            className="rounded-md border border-border bg-surface px-2 py-2 text-label text-muted hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
          >
            Activity <span className="font-mono">{feed.length}</span>
          </button>
        </aside>
      )}
    </div>
  );
}

/** One summary-strip tile: a small uppercase label over a value. */
function SummaryTile({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div title={title} className="min-w-32 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="text-label uppercase tracking-wide text-muted">{label}</div>
      <div className="text-title font-semibold">{children}</div>
    </div>
  );
}

/** A profile's name cell: label, fullAuto shield, ghost/config-missing badge, and the visible (tildified) config path. */
export function ProfileNameCell({ p }: { p: ProfileView }) {
  const badge = profileBadge(p);
  return (
    <>
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <span className="font-mono" title={p.configPath ?? undefined}>
          {profileLabel(p)}
        </span>
        {p.fullAuto && <FullAutoShield />}
        {p.paused === true && (
          <Pill tone="held" title="operator pause: no new runs start; running agents finish (a restart clears it)">
            paused
          </Pill>
        )}
        {badge && (
          <Pill tone={badge.kind === "missing" ? "held" : "neutral"} title={badge.title}>
            {badge.text}
          </Pill>
        )}
        {badge?.kind === "ghost" && (
          <span className="text-label text-muted" title={badge.title}>
            created {formatDate(p.createdAt)}
          </span>
        )}
      </div>
      {p.configPath && (
        <div className="block max-w-[40ch] truncate font-mono text-label text-muted max-lg:max-w-[24ch]" title={p.configPath}>
          {p.configPath}
        </div>
      )}
    </>
  );
}

/** The app bar over the page; `nav` absent (Home, loading / error screens) → no profile controls. */
function Shell({ children, ...bar }: { children: React.ReactNode; connection: ConnectionState; nav?: ProfileNav }) {
  return (
    <div className="min-h-screen bg-bg text-fg font-sans">
      <AppBar {...bar} />
      <main className="p-4">{children}</main>
    </div>
  );
}
