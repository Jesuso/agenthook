import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "./contract";
import { formatUp, formatLastEvent, formatAgents } from "./format";
import { subscribe } from "./stream";
import { applyEvent } from "./state";
import { initFetchState, startFetch, bufferEvent, resolveFetch, failFetch, isBuffering } from "./snapshotFetch";
import type { FetchState } from "./snapshotFetch";

type LoadState = { kind: "loading" } | { kind: "unauthorized" } | { kind: "error"; status: number } | { kind: "ok"; snapshot: Snapshot };

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [connected, setConnected] = useState(false);
  // CLOSED means the EventSource gave up for good (e.g. a 401) — the browser
  // will not retry it, so the "reconnecting…" banner would be a lie.
  const [closed, setClosed] = useState(false);
  // Only the latest fetch's response may land — see snapshotFetch.ts.
  const fetchState = useRef<FetchState>(initFetchState());

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

  return (
    <Shell>
      {!connected && !closed && (
        <div className="mb-3 rounded border border-[var(--color-err)] bg-[var(--color-err)]/10 px-3 py-1.5 text-sm text-[var(--color-err)]">
          disconnected — reconnecting…
        </div>
      )}
      <table className="w-full border-collapse text-sm">
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
              <td className="px-2 py-1 font-mono">{p.name}</td>
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
