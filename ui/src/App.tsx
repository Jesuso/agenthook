import { useEffect, useState } from "react";
import type { Snapshot } from "./contract";
import { formatUp, formatLastEvent } from "./format";

type LoadState = { kind: "loading" } | { kind: "unauthorized" } | { kind: "error"; status: number } | { kind: "ok"; snapshot: Snapshot };

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/snapshot")
      .then((res) => {
        if (cancelled) return;
        if (res.status === 401) return setState({ kind: "unauthorized" });
        if (!res.ok) return setState({ kind: "error", status: res.status });
        return res.json().then((snapshot: Snapshot) => !cancelled && setState({ kind: "ok", snapshot }));
      })
      .catch(() => !cancelled && setState({ kind: "error", status: 0 }));
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") return <Shell>Loading…</Shell>;
  if (state.kind === "unauthorized")
    return <Shell>Unauthorized — open the URL printed by <code className="font-mono">ah ui</code> to exchange its token.</Shell>;
  if (state.kind === "error") return <Shell>Failed to load snapshot (status {state.status}).</Shell>;

  return (
    <Shell>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted)]">
            <th className="px-2 py-1">profile</th>
            <th className="px-2 py-1">status</th>
            <th className="px-2 py-1">pid</th>
            <th className="px-2 py-1">tracker</th>
            <th className="px-2 py-1">ingress</th>
            <th className="px-2 py-1">fullAuto</th>
            <th className="px-2 py-1">active</th>
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
              <td className="px-2 py-1 font-mono">{p.pid ?? "—"}</td>
              <td className="px-2 py-1">{p.tracker ?? "—"}</td>
              <td className="px-2 py-1">{p.ingress ?? "—"}</td>
              <td className="px-2 py-1">{p.fullAuto ? "yes" : "no"}</td>
              <td className="px-2 py-1">{p.active ?? "—"}</td>
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
