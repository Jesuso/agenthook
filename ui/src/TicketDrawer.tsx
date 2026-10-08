import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LogFrame, RunView, TicketRow, TicketStatus } from "./contract";
import { formatCost, formatDuration, formatRelative, ticketTitle } from "./format";
import { prNumber } from "./tickets";
import {
  applyFrame,
  chunkRanges,
  emptyLog,
  formatOutcome,
  isAtBottom,
  lineAt,
  lineCount,
  liveIndicator,
  logStreamUrl,
  logText,
  outcomeTone,
  readWrap,
  runDurationMs,
  runsUrl,
  visibleRange,
  writeWrap,
} from "./logview";
import type { LogBuffer, StreamStatus } from "./logview";
import { IconButton, Pill, StatusBadge } from "./components";

const LINE_H = 18;
const FRAME_TYPES: LogFrame["type"][] = ["init", "append", "reset"];

// Full class strings so Tailwind's scanner sees every one.
const DOT_TEXT: Record<TicketStatus, string> = {
  running: "text-status-running",
  queued: "text-status-queued",
  held: "text-status-held",
  failed: "text-status-failed",
  done: "text-status-done",
  idle: "text-status-idle",
  interrupted: "text-status-interrupted",
  stalled: "text-status-stalled",
};

type RunsState = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; runs: RunView[] };

/**
 * Right-hand drawer for one ticket over a backdrop (Esc / backdrop click / × close it): a header
 * from its `TicketRow` (undefined once it's filtered out of the snapshot — `profile`/`ticketRef`
 * still name it), its runs (refetched when `runsNonce` bumps — the parent bumps it on a
 * run_start/run_end for this ref off the existing /api/stream, no polling) and a live-tailed log
 * of the selected run. The newest run is selected until the user picks one. The parent keys it
 * by ticket, so a different ticket starts fresh.
 */
export function TicketDrawer(props: { profile: string; ticketRef: string; ticket: TicketRow | undefined; runsNonce: number; onClose: () => void }) {
  const { profile, ticketRef, ticket, runsNonce } = props;
  const [runs, setRuns] = useState<RunsState>({ kind: "loading" });
  const [picked, setPicked] = useState<string | null>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    let live = true;
    fetch(runsUrl(profile, ticketRef))
      .then((res) => (res.ok ? res.json().then((b: { runs: RunView[] }) => live && setRuns({ kind: "ok", runs: b.runs })) : live && setRuns({ kind: "error", status: res.status })))
      .catch(() => live && setRuns({ kind: "error", status: 0 }));
    return () => {
      live = false;
    };
  }, [profile, ticketRef, runsNonce]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose.current();
    };
    window.addEventListener("keydown", onKey);
    dialog.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const list = runs.kind === "ok" ? runs.runs : [];
  // A user's pick sticks while that run is still listed; otherwise follow the newest.
  const selected = list.find((r) => r.run === picked) ?? list[0] ?? null;
  const now = Date.now();
  const label = ticket?.displayId ?? ticketRef;
  const pr = prNumber(ticket?.prUrl ?? null);

  return (
    <div className="fixed inset-0 z-40 bg-black/40" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <aside
        ref={dialog}
        tabIndex={-1}
        data-drawer
        role="dialog"
        aria-modal="true"
        aria-label={`Ticket ${label}`}
        className="fixed inset-y-0 right-0 flex w-full flex-col border-l border-border bg-surface shadow-xl outline-none md:w-[720px]"
      >
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-3">
          {ticket?.trackerUrl ? (
            <a className="shrink-0 font-mono text-accent hover:underline" href={ticket.trackerUrl} target="_blank" rel="noopener noreferrer">
              {label} ↗
            </a>
          ) : (
            <span className="shrink-0 font-mono">{label}</span>
          )}
          <h2 className="min-w-0 flex-1 basis-40 truncate text-title font-semibold" title={ticket?.title ?? undefined}>
            {ticket ? (
              ticketTitle(ticket).unknown ? (
                <>
                  {label} <span className="text-muted">{ticketTitle(ticket).text}</span>
                </>
              ) : (
                ticketTitle(ticket).text
              )
            ) : (
              <span className="text-muted">—</span>
            )}
          </h2>
          {ticket && <StatusBadge status={ticket.status} />}
          <span className="font-mono text-label text-muted">{profile}</span>
          {ticket?.prUrl && pr && (
            <a className="text-label text-accent hover:underline" href={ticket.prUrl} target="_blank" rel="noopener noreferrer">
              PR #{pr}
            </a>
          )}
          {ticket && (
            <span className="text-label text-muted" title="total cost: the sum of run_end costs still in the events tail (an approximation)">
              {formatCost(ticket.costUsd)}
            </span>
          )}
          <IconButton label="Close" onClick={props.onClose}>
            ×
          </IconButton>
        </header>
        <div className="flex min-h-0 flex-1 flex-col p-4">
          {runs.kind === "loading" && <p className="text-label text-muted">Loading runs…</p>}
          {runs.kind === "error" && <p className="text-label text-status-failed">Failed to load runs (status {runs.status}).</p>}
          {runs.kind === "ok" && list.length === 0 && <p className="text-label text-muted">No run logs for this ticket.</p>}
          {list.length > 0 && (
            <div className="mb-3 max-h-48 shrink-0 overflow-auto rounded-md border border-border">
              <table className="w-full border-collapse text-label">
                <thead>
                  <tr className="border-b border-border text-left text-muted">
                    <th className="px-2 py-1 font-medium">step</th>
                    <th className="px-2 py-1 font-medium">started</th>
                    <th className="px-2 py-1 font-medium">duration</th>
                    <th className="px-2 py-1 font-medium">outcome</th>
                    <th className="px-2 py-1 font-medium">cost</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const on = r.run === selected?.run;
                    return (
                      <tr
                        key={r.run}
                        aria-selected={on}
                        className={`cursor-pointer border-b border-border-subtle last:border-b-0 ${on ? "bg-surface-raised" : "hover:bg-surface-raised"}`}
                        onClick={() => setPicked(r.run)}
                      >
                        <td className={`border-l-2 px-2 py-1 ${on ? "border-l-accent font-medium" : "border-l-transparent"}`}>{r.step}</td>
                        <td className="px-2 py-1" title={r.startedAt}>
                          {formatRelative(r.startedAt, now)}
                        </td>
                        <td className="px-2 py-1 font-mono">{formatDuration(runDurationMs(r, now))}</td>
                        <td className="px-2 py-1">
                          <Pill tone={outcomeTone(r)}>{formatOutcome(r)}</Pill>
                        </td>
                        <td className="px-2 py-1 font-mono">{formatCost(r.costUsd ?? 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {selected && <LogView key={selected.run} profile={profile} run={selected.run} running={selected.running} />}
        </div>
      </aside>
    </div>
  );
}

/**
 * Monospace log tail. Unwrapped, it's hand-windowed at a fixed line height: only the visible lines
 * (+ overscan) are in the DOM. Wrapped lines have variable height, so wrap mode renders the buffer
 * as memoized `CHUNK_LINES`-line `<pre>` chunks instead — an append re-renders only the last one,
 * and `content-visibility:auto` skips laying out the off-screen ones.
 */
function LogView({ profile, run, running }: { profile: string; run: string; running: boolean }) {
  const buf = useRef(emptyLog());
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [following, setFollowing] = useState(true);
  const [, setVersion] = useState(0);
  // Bumped on init/reset: the buffer is mutated in place, so chunks need it to know it was replaced.
  const [gen, setGen] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [everOpened, setEverOpened] = useState(false);
  const [wrap, setWrap] = useState(readWrap);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);

  useEffect(() => {
    buf.current = emptyLog();
    follow.current = true;
    const es = new EventSource(logStreamUrl(profile, run));
    es.addEventListener("open", () => {
      setStatus("live");
      setEverOpened(true);
    });
    es.addEventListener("error", () => setStatus(es.readyState === EventSource.CLOSED ? "closed" : "connecting"));
    for (const type of FRAME_TYPES) {
      es.addEventListener(type, (ev: MessageEvent) => {
        try {
          applyFrame(buf.current, { type, ...JSON.parse(ev.data) } as LogFrame);
        } catch {
          return; /* ignore an unparseable frame */
        }
        if (type !== "append") setGen((g) => g + 1);
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
    // Content can change height without a render — a chunk's real size replacing its
    // content-visibility estimate, a rewrap on resize — so re-stick to the bottom then too.
    const stick = new ResizeObserver(() => {
      if (follow.current) el.scrollTop = el.scrollHeight;
    });
    if (content.current) stick.observe(content.current);
    return () => {
      ro.disconnect();
      stick.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const total = lineCount(buf.current);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  });

  const setFollow = (on: boolean) => {
    follow.current = on;
    setFollowing(on);
  };
  const jumpToEnd = () => {
    setFollow(true);
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(logText(buf.current));
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  };

  const partialOnly = buf.current.truncated || buf.current.dropped > 0;
  const live = liveIndicator(status, running, everOpened);

  let body;
  if (wrap) {
    body = chunkRanges(total, undefined, buf.current.dropped).map((c) => (
      <LogChunk key={c.key} buf={buf.current} gen={gen} first={c.start + buf.current.dropped} count={c.end - c.start} tail={c.end === total ? buf.current.partial : ""} />
    ));
  } else {
    const { start, end } = visibleRange(scrollTop, height, LINE_H, total);
    const rows = [];
    for (let i = start; i < end; i++) {
      rows.push(
        <div key={i} className="absolute left-0 whitespace-pre px-2" style={{ top: i * LINE_H, height: LINE_H }}>
          {lineAt(buf.current, i)}
        </div>,
      );
    }
    body = (
      <div className="relative" style={{ height: total * LINE_H }}>
        {rows}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted">
        <span className={`inline-flex items-center gap-1.5 ${DOT_TEXT[live.tone]}`} data-live={live.label}>
          <span aria-hidden="true" className={`size-1.5 rounded-full bg-current ${live.pulse ? "animate-status-pulse" : ""}`} />
          {live.label}
        </span>
        <span className="truncate font-mono text-meta" title={run}>
          {run}
        </span>
        <span>{total} lines</span>
        {partialOnly && <span>(earlier output not shown)</span>}
        <span className="ml-auto flex items-center gap-2">
          {!following && (
            <button type="button" className="rounded-md border border-border px-2 text-fg hover:bg-surface-raised" onClick={jumpToEnd}>
              Jump to end ↓
            </button>
          )}
          <label className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(e) => {
                setWrap(e.target.checked);
                writeWrap(e.target.checked);
              }}
            />
            wrap
          </label>
          <button
            type="button"
            className="rounded-md border border-border px-2 text-fg hover:bg-surface-raised"
            title={partialOnly ? "copies the loaded portion only — earlier output isn't loaded" : "copy the log"}
            onClick={copy}
          >
            {copied === "ok" ? "Copied" : copied === "fail" ? "Copy failed" : "Copy"}
          </button>
        </span>
      </div>
      <div
        ref={box}
        className="relative min-h-0 flex-1 overflow-auto rounded-md border border-border bg-bg font-mono text-label"
        style={{ lineHeight: `${LINE_H}px` }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
          if (atBottom !== follow.current) setFollow(atBottom);
          setScrollTop(el.scrollTop);
        }}
      >
        <div ref={content}>{body}</div>
      </div>
    </div>
  );
}

/**
 * One wrap-mode chunk: `count` lines from absolute line `first` (buffer index + `buf.dropped`, so
 * a cap drop leaves later chunks' props — and render — untouched). Memoized on its props: the
 * buffer is mutated in place, so `gen` (bumped on init/reset) and `tail` (the partial line, last
 * chunk only) are what change when its content does. The trailing "\n" lets a final empty line render.
 */
const LogChunk = memo(function LogChunk({ buf, first, count }: { buf: LogBuffer; gen: number; first: number; count: number; tail: string }) {
  let text = "";
  const start = first - buf.dropped;
  for (let i = start; i < start + count; i++) text += lineAt(buf, i) + "\n";
  return (
    <pre
      className="m-0 px-2 font-mono whitespace-pre-wrap break-words"
      style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${count * LINE_H}px` }}
    >
      {text}
    </pre>
  );
});
