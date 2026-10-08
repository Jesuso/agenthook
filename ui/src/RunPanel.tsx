import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LogFrame, RunView } from "./contract";
import { formatCost, formatRelative } from "./format";
import { applyFrame, emptyLog, formatOutcome, isAtBottom, lineAt, lineCount, logStreamUrl, runsUrl, visibleRange } from "./logview";

const LINE_H = 18;
const FRAME_TYPES: LogFrame["type"][] = ["init", "append", "reset"];

type RunsState = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; runs: RunView[] };

/**
 * Side panel for one ticket: its runs (refetched when `runsNonce` bumps — the parent bumps
 * it on a run_start/run_end for this ref off the existing /api/stream, no polling) and a
 * live-tailed log of the selected run.
 */
export function RunPanel(props: { profile: string; ticketRef: string; label: string; runsNonce: number; onClose: () => void }) {
  const { profile, ticketRef, runsNonce } = props;
  const [runs, setRuns] = useState<RunsState>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(runsUrl(profile, ticketRef))
      .then((res) => (res.ok ? res.json().then((b: { runs: RunView[] }) => live && setRuns({ kind: "ok", runs: b.runs })) : live && setRuns({ kind: "error", status: res.status })))
      .catch(() => live && setRuns({ kind: "error", status: 0 }));
    return () => {
      live = false;
    };
  }, [profile, ticketRef, runsNonce]);

  useEffect(() => setSelected(null), [profile, ticketRef]);

  const now = Date.now();
  return (
    <aside className="fixed inset-y-0 right-0 z-10 flex w-[min(960px,75vw)] flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)] p-4 shadow-xl">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-base font-semibold">
          <span className="font-mono">{props.label}</span> <span className="text-[var(--color-muted)]">· {profile}</span>
        </h2>
        <button className="ml-auto rounded border border-[var(--color-border)] px-2 py-0.5 text-sm" onClick={props.onClose}>
          close
        </button>
      </div>
      {runs.kind === "loading" && <p className="text-sm">Loading runs…</p>}
      {runs.kind === "error" && <p className="text-sm">Failed to load runs (status {runs.status}).</p>}
      {runs.kind === "ok" && runs.runs.length === 0 && <p className="text-sm text-[var(--color-muted)]">No run logs for this ticket.</p>}
      {runs.kind === "ok" && runs.runs.length > 0 && (
        <div className="mb-3 max-h-48 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted)]">
                <th className="px-2 py-1">step</th>
                <th className="px-2 py-1">started</th>
                <th className="px-2 py-1">outcome</th>
                <th className="px-2 py-1">cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.runs.map((r) => (
                <tr
                  key={r.run}
                  className={`cursor-pointer border-b border-[var(--color-border)] ${r.run === selected ? "bg-[var(--color-border)]" : ""}`}
                  onClick={() => setSelected(r.run)}
                >
                  <td className="px-2 py-1">{r.step}</td>
                  <td className="px-2 py-1" title={r.startedAt}>
                    {formatRelative(r.startedAt, now)}
                  </td>
                  <td className="px-2 py-1">{formatOutcome(r)}</td>
                  <td className="px-2 py-1">{formatCost(r.costUsd ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && <LogView key={selected} profile={profile} run={selected} />}
    </aside>
  );
}

/** Monospace, hand-windowed log tail: only the visible lines (+ overscan) are in the DOM. */
function LogView({ profile, run }: { profile: string; run: string }) {
  const buf = useRef(emptyLog());
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [, setVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [status, setStatus] = useState<"connecting" | "live" | "closed">("connecting");

  useEffect(() => {
    buf.current = emptyLog();
    follow.current = true;
    const es = new EventSource(logStreamUrl(profile, run));
    es.addEventListener("open", () => setStatus("live"));
    es.addEventListener("error", () => setStatus(es.readyState === EventSource.CLOSED ? "closed" : "connecting"));
    for (const type of FRAME_TYPES) {
      es.addEventListener(type, (ev: MessageEvent) => {
        try {
          applyFrame(buf.current, { type, ...JSON.parse(ev.data) } as LogFrame);
        } catch {
          return; /* ignore an unparseable frame */
        }
        setVersion((v) => v + 1);
      });
    }
    return () => es.close();
  }, [profile, run]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = lineCount(buf.current);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  });

  const { start, end } = visibleRange(scrollTop, height, LINE_H, total);
  const rows = [];
  for (let i = start; i < end; i++) {
    rows.push(
      <div key={i} className="absolute left-0 whitespace-pre px-2" style={{ top: i * LINE_H, height: LINE_H }}>
        {lineAt(buf.current, i)}
      </div>,
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex gap-3 text-xs text-[var(--color-muted)]">
        <span className="font-mono">{run}</span>
        <span>{status}</span>
        <span>{total} lines</span>
        {(buf.current.truncated || buf.current.dropped > 0) && <span>(earlier output not shown)</span>}
        {!follow.current && <span>paused — scroll to the bottom to follow</span>}
      </div>
      <div
        ref={box}
        className="relative min-h-0 flex-1 overflow-auto rounded border border-[var(--color-border)] font-mono text-xs"
        style={{ lineHeight: `${LINE_H}px` }}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
          setScrollTop(el.scrollTop);
        }}
      >
        <div className="relative" style={{ height: total * LINE_H }}>
          {rows}
        </div>
      </div>
    </div>
  );
}
