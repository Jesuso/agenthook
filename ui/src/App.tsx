import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { Snapshot, TicketStatus } from "./contract";
import { formatUp, formatLastEvent, formatAgents, formatRelative, formatCost, profileLabel } from "./format";
import { subscribe } from "./stream";
import { applyEvent } from "./state";
import { sortTickets, filterTickets, STATUS_ORDER } from "./tickets";
import { appendFeed, formatEventDetail } from "./feed";
import type { FeedEntry } from "./feed";
import { initFetchState, startFetch, bufferEvent, resolveFetch, failFetch, isBuffering } from "./snapshotFetch";
import type { FetchState } from "./snapshotFetch";
import { RunPanel } from "./RunPanel";
import { affectsRuns } from "./logview";
import { DISCARD_PROMPT } from "./instructions";
import type { InstructionsEvent } from "./instructions";
import { CONFIG_DISCARD_PROMPT } from "./config";
import type { ConfigSinkEvent } from "./config";

// CodeMirror + react-markdown load only when the Instructions / Config tab is opened.
const InstructionsView = lazy(() => import("./InstructionsView"));
const ConfigView = lazy(() => import("./ConfigView"));

type LoadState = { kind: "loading" } | { kind: "unauthorized" } | { kind: "error"; status: number } | { kind: "ok"; snapshot: Snapshot };

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [connected, setConnected] = useState(false);
  // CLOSED means the EventSource gave up for good (e.g. a 401) — the browser
  // will not retry it, so the "reconnecting…" banner would be a lie.
  const [closed, setClosed] = useState(false);
  // Only the latest fetch's response may land — see snapshotFetch.ts.
  const fetchState = useRef<FetchState>(initFetchState());
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [profileFilter, setProfileFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [showAll, setShowAll] = useState(false);
  // The ticket whose runs/log panel is open. The stream callback reads it via a ref.
  const [open, setOpen] = useState<{ profile: string; ref: string } | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [runsNonce, setRunsNonce] = useState(0);
  // Plain tab state, no router. The Instructions / Config views report their dirty buffer here so
  // a tab switch can confirm before discarding it, and receive their SSE events via the sinks.
  const [tab, setTab] = useState<"dashboard" | "instructions" | "config">("dashboard");
  const instructionsDirty = useRef(false);
  const instructionsSink = useRef<((ev: InstructionsEvent) => void) | null>(null);
  const configDirty = useRef(false);
  const configSink = useRef<((ev: ConfigSinkEvent) => void) | null>(null);

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
        if (isBuffering(fetchState.current)) {
          fetchState.current = bufferEvent(fetchState.current, ev);
          return;
        }
        setState((s) => (s.kind === "ok" ? { kind: "ok", snapshot: applyEvent(s.snapshot, ev) } : s));
      },
    });

    return unsubscribe;
  }, []);

  if (state.kind === "loading") return <Shell>Loading…</Shell>;
  if (state.kind === "unauthorized")
    return <Shell>Unauthorized — open the URL printed by <code className="font-mono">ah ui</code> to exchange its token.</Shell>;
  if (state.kind === "error") return <Shell>Failed to load snapshot (status {state.status}).</Shell>;

  const switchTab = (next: typeof tab) => {
    if (next === tab) return;
    if (tab === "instructions" && instructionsDirty.current && !window.confirm(DISCARD_PROMPT)) return;
    if (tab === "config" && configDirty.current && !window.confirm(CONFIG_DISCARD_PROMPT)) return;
    setTab(next);
  };
  const header = (
    <>
      {!connected && !closed && (
        <div className="mb-3 rounded border border-[var(--color-err)] bg-[var(--color-err)]/10 px-3 py-1.5 text-sm text-[var(--color-err)]">
          disconnected — reconnecting…
        </div>
      )}
      <nav className="mb-4 flex gap-1 border-b border-[var(--color-border)] text-sm">
        {(["dashboard", "instructions", "config"] as const).map((t) => (
          <button
            key={t}
            className={`-mb-px border-b-2 px-3 py-1 capitalize ${t === tab ? "border-[var(--color-accent)]" : "border-transparent text-[var(--color-muted)]"}`}
            onClick={() => switchTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
    </>
  );

  if (tab === "instructions")
    return (
      <Shell>
        {header}
        <Suspense fallback={<p className="text-sm">Loading editor…</p>}>
          <InstructionsView
            profiles={state.snapshot.profiles}
            eventSink={instructionsSink}
            onDirtyChange={(d) => (instructionsDirty.current = d)}
          />
        </Suspense>
      </Shell>
    );

  if (tab === "config")
    return (
      <Shell>
        {header}
        <Suspense fallback={<p className="text-sm">Loading editor…</p>}>
          <ConfigView profiles={state.snapshot.profiles} eventSink={configSink} onDirtyChange={(d) => (configDirty.current = d)} />
        </Suspense>
      </Shell>
    );

  const now = Date.now();
  const filtered = filterTickets(state.snapshot.tickets, {
    profile: profileFilter || null,
    status: (statusFilter || null) as TicketStatus | null,
    showAll,
    now,
  });
  const tickets = sortTickets(filtered);

  return (
    <Shell>
      {header}
      <table className="w-full border-collapse text-sm mb-6">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted)]">
            <th className="px-2 py-1">profile</th>
            <th className="px-2 py-1">status</th>
            <th className="px-2 py-1">tracker</th>
            <th className="px-2 py-1">ingress</th>
            <th className="px-2 py-1">port</th>
            <th className="px-2 py-1">fullAuto</th>
            <th className="px-2 py-1">agents</th>
            <th className="px-2 py-1">queued</th>
            <th className="px-2 py-1">last event</th>
          </tr>
        </thead>
        <tbody>
          {state.snapshot.profiles.map((p) => (
            <tr key={p.name} className="border-b border-[var(--color-border)]">
              <td className="px-2 py-1 font-mono">{profileLabel(p)}</td>
              <td className="px-2 py-1" style={{ color: p.up ? "var(--color-ok)" : "var(--color-err)" }}>
                {formatUp(p)}
              </td>
              <td className="px-2 py-1">{p.tracker ?? "—"}</td>
              <td className="px-2 py-1">{p.ingress ?? "—"}</td>
              <td className="px-2 py-1 font-mono">{p.port ?? "—"}</td>
              <td className="px-2 py-1">
                {p.fullAuto ? (
                  <span className="rounded bg-[var(--color-err)]/20 px-1.5 py-0.5 text-xs font-semibold text-[var(--color-err)]">fullAuto</span>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-2 py-1 font-mono">{formatAgents(p)}</td>
              <td className="px-2 py-1">{p.queued ?? "—"}</td>
              <td className="px-2 py-1 font-mono">{formatLastEvent(p.lastEvent)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="text-base font-semibold mb-2">tickets</h2>
      <div className="flex items-center gap-3 mb-2 text-sm">
        <select
          className="border border-[var(--color-border)] rounded px-1.5 py-0.5 bg-transparent"
          value={profileFilter}
          onChange={(e) => setProfileFilter(e.target.value)}
        >
          <option value="">all profiles</option>
          {state.snapshot.profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {profileLabel(p)}
            </option>
          ))}
        </select>
        <select
          className="border border-[var(--color-border)] rounded px-1.5 py-0.5 bg-transparent"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">all statuses</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          show all
        </label>
        <span className="text-[var(--color-muted)]">
          {tickets.length} shown / {state.snapshot.tickets.length} total
        </span>
      </div>
      <table className="w-full border-collapse text-sm mb-6">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted)]">
            <th className="px-2 py-1">id</th>
            <th className="px-2 py-1">title</th>
            <th className="px-2 py-1">profile</th>
            <th className="px-2 py-1">step</th>
            <th className="px-2 py-1">status</th>
            <th className="px-2 py-1">model</th>
            <th className="px-2 py-1">started</th>
            <th className="px-2 py-1">cost</th>
            <th className="px-2 py-1">held reason</th>
            <th className="px-2 py-1">PR</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => (
            <tr
              key={`${t.profile}\u0000${t.ref}`}
              className={`cursor-pointer border-b border-[var(--color-border)] ${open?.profile === t.profile && open.ref === t.ref ? "bg-[var(--color-border)]" : ""}`}
              onClick={(e) => {
                // Links in the row (tracker, PR) keep their own behavior.
                if ((e.target as HTMLElement).closest("a")) return;
                setOpen({ profile: t.profile, ref: t.ref });
              }}
            >
              <td className="px-2 py-1 font-mono">
                {t.trackerUrl ? (
                  <a href={t.trackerUrl} target="_blank" rel="noopener noreferrer">
                    {t.displayId}
                  </a>
                ) : (
                  t.displayId
                )}
              </td>
              <td className="px-2 py-1">{t.title ?? "—"}</td>
              <td className="px-2 py-1 font-mono">{t.profile}</td>
              <td className="px-2 py-1">{t.step ?? "—"}</td>
              <td className="px-2 py-1">{t.status}</td>
              <td className="px-2 py-1">{t.model ?? "—"}</td>
              <td className="px-2 py-1">{formatRelative(t.startedAt, now)}</td>
              <td className="px-2 py-1">{formatCost(t.costUsd)}</td>
              <td className="px-2 py-1">{t.heldReason ?? "—"}</td>
              <td className="px-2 py-1">
                {t.prUrl ? (
                  <a href={t.prUrl} target="_blank" rel="noopener noreferrer">
                    PR
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="text-base font-semibold mb-2">events</h2>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted)]">
            <th className="px-2 py-1">ts</th>
            <th className="px-2 py-1">profile</th>
            <th className="px-2 py-1">ref</th>
            <th className="px-2 py-1">step</th>
            <th className="px-2 py-1">event</th>
            <th className="px-2 py-1">detail</th>
          </tr>
        </thead>
        <tbody>
          {feed.map((f, i) => (
            <tr key={i} className="border-b border-[var(--color-border)]">
              <td className="px-2 py-1 font-mono">{String(f.event.ts ?? "—")}</td>
              <td className="px-2 py-1 font-mono">{f.profile}</td>
              <td className="px-2 py-1 font-mono">{String(f.event.ref ?? "—")}</td>
              <td className="px-2 py-1">{String(f.event.step ?? "—")}</td>
              <td className="px-2 py-1">{String(f.event.event ?? "—")}</td>
              <td className="px-2 py-1">{formatEventDetail(f.event)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <RunPanel
          profile={open.profile}
          ticketRef={open.ref}
          label={state.snapshot.tickets.find((t) => t.profile === open.profile && t.ref === open.ref)?.displayId ?? open.ref}
          runsNonce={runsNonce}
          onClose={() => setOpen(null)}
        />
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-fg)] p-4 font-sans">
      <h1 className="text-lg font-semibold mb-4">agenthook</h1>
      {children}
    </div>
  );
}
