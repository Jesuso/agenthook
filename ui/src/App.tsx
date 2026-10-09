import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { ProfileView, Snapshot } from "./contract";
import { formatUp, formatLastEvent, formatAgents, formatCost, formatDate, profileLabel, profileBadge } from "./format";
import { subscribe } from "./stream";
import { applyEvent, clearRemovedProfile } from "./state";
import { summarize } from "./summary";
import { appendFeed, readRailOpen, writeRailOpen } from "./feed";
import type { FeedEntry } from "./feed";
import { ActivityRail } from "./ActivityRail";
import { initFetchState, startFetch, bufferEvent, resolveFetch, failFetch, isBuffering } from "./snapshotFetch";
import type { FetchState } from "./snapshotFetch";
import { TicketDrawer } from "./TicketDrawer";
import { TicketsTable } from "./TicketsTable";
import { affectsRuns } from "./logview";
import { DISCARD_PROMPT } from "./instructions";
import type { InstructionsEvent } from "./instructions";
import { CONFIG_DISCARD_PROMPT } from "./config";
import type { ConfigSinkEvent } from "./config";
import { RemoveProfile } from "./RemoveProfile";
import { pendingText } from "./remove";
import { AppBar } from "./AppBar";
import type { Tab } from "./AppBar";
import { connectionState } from "./connection";
import type { ConnectionState } from "./connection";
import { Menu, Pill } from "./components";

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
  const [profileFilter, setProfileFilter] = useState<string>("");
  const profileFilterRef = useRef(profileFilter);
  profileFilterRef.current = profileFilter;
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [showAll, setShowAll] = useState(false);
  // The ticket whose runs/log panel is open. The stream callback reads it via a ref.
  const [open, setOpen] = useState<{ profile: string; ref: string } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [runsNonce, setRunsNonce] = useState(0);
  // Plain tab state, no router. The Instructions / Config views report their dirty buffer here so
  // a tab switch can confirm before discarding it, and receive their SSE events via the sinks.
  const [tab, setTab] = useState<Tab>("dashboard");
  // The profile a tab opens on when reached from a profile row's ⋯ menu (else the view's first).
  const [tabProfile, setTabProfile] = useState<string | undefined>(undefined);
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
          setFeed((f) => appendFeed(f, ev));
          const o = openRef.current;
          if (o && affectsRuns(ev, o.profile, o.ref)) setRunsNonce((n) => n + 1);
          return;
        }
        // Navigate away from a removed profile whether or not the snapshot is mid-fetch.
        if (ev.type === "profile_removed") {
          const picks = clearRemovedProfile({ open: openRef.current, profileFilter: profileFilterRef.current }, ev.name);
          setOpen(picks.open);
          setProfileFilter(picks.profileFilter);
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

  const switchTab = (next: Tab, profile?: string) => {
    if (next === tab) return;
    if (tab === "instructions" && instructionsDirty.current && !window.confirm(DISCARD_PROMPT)) return;
    if (tab === "config" && configDirty.current && !window.confirm(CONFIG_DISCARD_PROMPT)) return;
    setTabProfile(profile);
    setTab(next);
  };
  const nav = { connection, tab, onTab: (t: Tab) => switchTab(t) };

  if (tab === "instructions")
    return (
      <Shell {...nav}>
        <Suspense fallback={<p className="text-sm">Loading editor…</p>}>
          <InstructionsView
            profiles={state.snapshot.profiles}
            initialProfile={tabProfile}
            eventSink={instructionsSink}
            onDirtyChange={(d) => (instructionsDirty.current = d)}
          />
        </Suspense>
      </Shell>
    );

  if (tab === "config")
    return (
      <Shell {...nav}>
        <Suspense fallback={<p className="text-sm">Loading editor…</p>}>
          <ConfigView
            profiles={state.snapshot.profiles}
            initialProfile={tabProfile}
            eventSink={configSink}
            onDirtyChange={(d) => (configDirty.current = d)}
          />
        </Suspense>
      </Shell>
    );

  const now = Date.now();
  const summary = summarize(state.snapshot, now);
  const needsYouActive = statusFilter === "needs-you";
  const needsYouTone = state.snapshot.tickets.some((t) => t.status === "failed") ? "text-status-failed" : "text-status-held";
  const toggleRail = () => {
    const next = !railOpen;
    setRailOpen(next);
    writeRailOpen(next);
  };
  const displayIdFor = (profile: string, ref: string) => state.snapshot.tickets.find((t) => t.profile === profile && t.ref === ref)?.displayId ?? null;

  return (
    <Shell {...nav}>
      <div className="xl:flex xl:items-start xl:gap-4">
      <div className="min-w-0 flex-1">
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
          onClick={() => {
            if (needsYouActive) return setStatusFilter("");
            setStatusFilter("needs-you");
            setProfileFilter("");
          }}
        >
          <div className="text-label uppercase tracking-wide text-muted">needs you</div>
          <div className={`text-title font-semibold font-mono ${summary.needsYou > 0 ? needsYouTone : ""}`}>{summary.needsYou}</div>
        </button>
        <SummaryTile label="queued">
          <span className="font-mono">{summary.queued}</span>
        </SummaryTile>
        <SummaryTile label="cost today (approx.)" title="sum of run_end costs in each profile's last 256 KB of events">
          <span className="font-mono">{formatCost(summary.costToday)}</span>
        </SummaryTile>
        <SummaryTile label="profiles">
          <span className="text-status-done">{summary.up} up</span>
          <span className="text-muted"> · </span>
          <span className={summary.down > 0 ? "text-status-failed" : "text-muted"}>{summary.down} down</span>
        </SummaryTile>
      </div>

      <div className="mb-6 xl:hidden">
        <ActivityRail feed={feed} displayIdFor={displayIdFor} open={railOpen} onToggle={toggleRail} onOpen={setOpen} variant="panel" />
      </div>

      <h2 className="text-base font-semibold mb-2">profiles</h2>
      <table className="mb-6 w-full border-collapse text-body">
        <thead>
          <tr className="border-b border-border text-left text-label text-muted">
            <th className="px-2 py-1 font-medium">profile</th>
            <th className="px-2 py-1 font-medium whitespace-nowrap">status</th>
            <th className="px-2 py-1 font-medium max-lg:hidden">tracker</th>
            <th className="px-2 py-1 font-medium max-lg:hidden">ingress</th>
            <th className="px-2 py-1 font-medium whitespace-nowrap">agents</th>
            <th className="px-2 py-1 font-medium whitespace-nowrap">queued</th>
            <th className="px-2 py-1 font-medium min-w-48 max-lg:min-w-36">last event</th>
            <th className="px-2 py-1" />
          </tr>
        </thead>
        <tbody>
          {state.snapshot.profiles.map((p) => {
            const up = formatUp(p);
            const pending = pendingRemoval[p.name] !== undefined;
            const displayId = p.lastEvent ? state.snapshot.tickets.find((t) => t.profile === p.name && t.ref === p.lastEvent?.ref)?.displayId ?? null : null;
            const lastEvent = formatLastEvent(p.lastEvent, displayId, now);
            return (
              <tr key={p.name} data-profile-row={p.name} className="border-b border-border-subtle">
                <td className="px-2 py-1 min-w-0">
                  <ProfileNameCell p={p} />
                </td>
                <td className="px-2 py-1 whitespace-nowrap">
                  <span title={up.title} className={`inline-flex items-center gap-1.5 ${p.up ? "text-success" : "text-status-failed"}`}>
                    <span aria-hidden="true" className="size-2 rounded-full bg-current" />
                    {up.text}
                  </span>
                </td>
                <td className="px-2 py-1 max-lg:hidden">{p.tracker ? <Pill>{p.tracker}</Pill> : <span className="text-muted">—</span>}</td>
                <td className="px-2 py-1 max-lg:hidden">{p.ingress ? <Pill>{p.ingress}</Pill> : <span className="text-muted">—</span>}</td>
                <td className="px-2 py-1 whitespace-nowrap">
                  <AgentsBar p={p} />
                </td>
                <td className="px-2 py-1 font-mono whitespace-nowrap">{p.queued ?? <span className="text-muted">—</span>}</td>
                <td className="px-2 py-1 min-w-48 max-lg:min-w-36" title={lastEvent.title}>
                  {lastEvent.text}
                </td>
                <td className="px-2 py-1 text-right whitespace-nowrap">
                  {pending && <span className="mr-2 text-label text-status-held">{pendingText(p)}</span>}
                  <Menu
                    label="profile actions"
                    items={[
                      { label: "Open config", onSelect: () => switchTab("config", p.name) },
                      { label: "Open instructions", onSelect: () => switchTab("instructions", p.name) },
                      {
                        label: "Copy config path",
                        disabled: !p.configPath,
                        onSelect: () =>
                          navigator.clipboard.writeText(p.configPath!).then(
                            () => setToast({ text: "Copied config path", hint: null }),
                            () => {},
                          ),
                      },
                      { label: "Remove…", danger: true, disabled: pending, onSelect: () => setRemoving(p.name) },
                    ]}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <TicketsTable
        tickets={state.snapshot.tickets}
        profiles={state.snapshot.profiles}
        now={now}
        profileFilter={profileFilter}
        onProfileFilter={setProfileFilter}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        showAll={showAll}
        onShowAll={setShowAll}
        open={open}
        onOpen={setOpen}
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
      {open && (
        <TicketDrawer
          key={`${open.profile}\u0000${open.ref}`}
          profile={open.profile}
          ticketRef={open.ref}
          ticket={state.snapshot.tickets.find((t) => t.profile === open.profile && t.ref === open.ref)}
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
            const label = state.snapshot.profiles.find((p) => p.name === removing)?.label ?? removing;
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

/** The agents cell: a mini bar filled to active / maxConcurrent, plus that text; grey when down. */
function AgentsBar({ p }: { p: ProfileView }) {
  const max = p.maxConcurrent ?? 0;
  const fill = p.up && p.active !== null && max > 0 ? Math.min(1, p.active / max) : 0;
  return (
    <span className={`inline-flex items-center gap-2 ${p.up ? "" : "text-muted"}`}>
      <span aria-hidden="true" className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-raised">
        <span className="block h-full rounded-full bg-status-running" style={{ width: `${fill * 100}%` }} />
      </span>
      <span className="font-mono text-label whitespace-nowrap">{formatAgents(p)}</span>
    </span>
  );
}

/** fullAuto: an amber shield — agents on this profile skip every permission prompt. */
function FullAutoShield() {
  const text = "fullAuto: agents run with --dangerously-skip-permissions";
  return (
    <span title={text} aria-label={text} role="img" className="inline-flex text-status-held">
      <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden="true">
        <path d="M8 1 2.5 3v4.2c0 3.4 2.3 6.4 5.5 7.8 3.2-1.4 5.5-4.4 5.5-7.8V3L8 1Z" />
      </svg>
    </span>
  );
}

/** The app bar over the page; `onTab` absent (loading / error screens) → no tabs. */
function Shell({ children, ...bar }: { children: React.ReactNode; connection: ConnectionState; tab?: Tab; onTab?: (t: Tab) => void }) {
  return (
    <div className="min-h-screen bg-bg text-fg font-sans">
      <AppBar {...bar} />
      <main className="p-4">{children}</main>
    </div>
  );
}
