import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { LogFrame, RunView, TicketRow, TicketStatus } from "./contract";
import type { ReleaseOutcome } from "./config";
import { formatDuration, formatRelative, formatTicketSpend, ticketTitle } from "./format";
import { prNumber } from "./tickets";
import { AnswerOptions } from "./AnswerOptions";
import {
  applyFrame,
  chunkRanges,
  emptyLog,
  formatOutcome,
  formatRunCost,
  isAtBottom,
  lineAt,
  lineCount,
  liveIndicator,
  logStreamUrl,
  logText,
  outcomeTone,
  readLogView,
  readWrap,
  runDurationMs,
  runsUrl,
  visibleRange,
  writeLogView,
  writeWrap,
} from "./logview";
import { chronological, isBounce, stepOrder, storyBlocks, timeScale } from "./runlog";
import type { StoryBlock } from "./runlog";
import type { LogBuffer, StreamStatus } from "./logview";
import { IconButton, Pill, SpeakButton, StatusBadge } from "./components";
import { useT } from "./i18n/react";
import { summaryRequest, summaryText } from "./ticketSummary";

const LINE_H = 18;
const FRAME_TYPES: LogFrame["type"][] = ["init", "append", "reset"];

// Full class strings so Tailwind's scanner sees every one.
const DOT_TEXT: Record<TicketStatus, string> = {
  running: "text-status-running",
  queued: "text-status-queued",
  held: "text-status-held",
  failed: "text-status-failed",
  done: "text-status-done",
  cancelled: "text-status-cancelled",
  idle: "text-status-idle",
  interrupted: "text-status-interrupted",
  stalled: "text-status-stalled",
};

const RUN_BG: Record<TicketStatus, string> = {
  running: "bg-status-running",
  queued: "bg-status-queued",
  held: "bg-status-held",
  failed: "bg-status-failed",
  done: "bg-status-done",
  cancelled: "bg-status-cancelled",
  idle: "bg-status-idle",
  interrupted: "bg-status-interrupted",
  stalled: "bg-status-stalled",
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** When a run ended for drawing: its end, now while it runs, its start when the end aged out. */
function runEndMs(r: RunView, now: number): number {
  return Date.parse(r.startedAt) + (runDurationMs(r, now) ?? 0);
}

type RunsState = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; runs: RunView[] };

/**
 * Right-hand drawer for one ticket over a backdrop (Esc / backdrop click / × close it): a header
 * from its `TicketRow` (undefined once it's filtered out of the snapshot — `profile`/`ticketRef`
 * still name it), its runs (refetched when `runsNonce` bumps — the parent bumps it on a
 * run_start/run_end for this ref off the existing /api/stream, no polling) and a live-tailed log
 * of the selected run. The newest run is selected until the user picks one. The parent keys it
 * by ticket, so a different ticket starts fresh.
 */
export function TicketDrawer(props: { profile: string; ticketRef: string; ticket: TicketRow | undefined; runsNonce: number; onClose: () => void; onRelease?: (t: { profile: string; ref: string }, comment: string) => Promise<ReleaseOutcome> }) {
  const { profile, ticketRef, ticket, runsNonce, onRelease } = props;
  const { t, lang } = useT();
  const [runs, setRuns] = useState<RunsState>({ kind: "loading" });
  const [picked, setPicked] = useState<string | null>(null);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const sendAnswer = async (comment: string) => {
    if (!onRelease) return;
    setAnswerBusy(true);
    setAnswerError(null);
    const out = await onRelease({ profile, ref: ticketRef }, comment);
    if (!out.ok) {
      setAnswerBusy(false);
      setAnswerError(out.error);
    }
  };
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    if (ticket?.status !== "held") {
      setAnswerBusy(false);
      setAnswerError(null);
    }
  }, [ticket?.status]);

  // The summary shows the regex extract at once, then the receiver's summary in the UI language
  // once it arrives (cached there). Any failure keeps the extract, with no error shown.
  const [localized, setLocalized] = useState<{ lang: string; text: string } | null>(null);
  const hasSummary = !!ticket?.summary;
  useEffect(() => {
    if (!hasSummary) return;
    let live = true;
    const { url, init } = summaryRequest(profile, ticketRef, lang);
    fetch(url, init)
      .then((res) => res.json().then((b) => summaryText(res.status, b), () => null))
      .catch(() => null)
      .then((text) => {
        if (live && text) setLocalized({ lang, text });
      });
    return () => {
      live = false;
    };
  }, [profile, ticketRef, lang, hasSummary]);
  const summary = localized?.lang === lang ? localized.text : ticket?.summary;

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
    // Focus moves into the drawer and back to whatever opened it (the row's title) on close.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.addEventListener("keydown", onKey);
    dialog.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const list = runs.kind === "ok" ? runs.runs : [];
  // A user's pick sticks while that run is still listed; otherwise follow the newest.
  const selected = list.find((r) => r.run === picked) ?? list[0] ?? null;
  const now = Date.now();
  const label = ticket?.displayId ?? ticketRef;
  const pr = prNumber(ticket?.prUrl ?? null);
  const seq = chronological(list);
  const order = stepOrder(list);
  const span = timeScale(seq.map((r) => ({ start: Date.parse(r.startedAt), end: Math.max(runEndMs(r, now), Date.parse(r.startedAt) + 1000) })));

  return (
    <div className="fixed inset-0 z-40 bg-black/40" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <aside
        ref={dialog}
        tabIndex={-1}
        data-drawer
        role="dialog"
        aria-modal="true"
        aria-label={t("drawer.aria", { id: label })}
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
              ticketTitle(ticket, lang).unknown ? (
                <>
                  {label} <span className="text-muted">{ticketTitle(ticket, lang).text}</span>
                </>
              ) : (
                ticketTitle(ticket, lang).text
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
            <span className="text-label text-muted" title={t("drawer.costTitle")}>
              {formatTicketSpend(ticket)}
            </span>
          )}
          <IconButton label={t("drawer.close")} onClick={props.onClose}>
            ×
          </IconButton>
        </header>
        {/* Why it needs you, in full: the Needs-you row only has room for one truncated line. */}
        {ticket && (ticket.status === "failed" ? ticket.failReason : ticket.status === "held" ? ticket.heldReason : null) && (
          <div data-drawer-reason className={`border-b border-border-subtle px-4 py-3 text-body ${ticket.status === "failed" ? "bg-status-failed-bg" : "bg-status-held-bg"}`}>
            <p className={`font-semibold ${ticket.status === "failed" ? "text-status-failed" : "text-status-held"}`}>{ticket.status === "failed" ? t("drawer.whyFailed") : t("drawer.agentAsks")}</p>
            {ticket.plain && (
              <p data-drawer-plain className="mb-1 text-body text-fg">
                {ticket.plain}<SpeakButton text={ticket.plain} label={t("drawer.readReason")} className="ml-1 align-middle" />
              </p>
            )}
            <p className="max-h-40 overflow-y-auto font-mono text-label break-words whitespace-pre-wrap text-fg">{ticket.status === "failed" ? ticket.failReason : ticket.heldReason}</p>
            {ticket.status === "held" && ticket.options && ticket.options.length > 0 && onRelease && (
              <div data-drawer-answer className="mt-2">
                <AnswerOptions options={ticket.options} busy={answerBusy} onSend={sendAnswer} />
                {answerError && (
                  <p role="alert" className="mt-1 text-label text-status-failed">
                    {answerError}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
        {ticket?.summary && summary && (
          <p data-drawer-summary className="border-b border-border-subtle px-4 py-3 text-body text-muted">
            {summary}<SpeakButton text={summary} label={t("drawer.readSummary")} className="ml-1 align-middle" />
          </p>
        )}
        <div data-drawer-runs className="flex min-h-0 flex-1 flex-col p-4">
          {runs.kind === "loading" && <p className="text-label text-muted">{t("drawer.loadingRuns")}</p>}
          {runs.kind === "error" && <p className="text-label text-status-failed">{t("drawer.runsError", { status: runs.status })}</p>}
          {runs.kind === "ok" && list.length === 0 && <p className="text-label text-muted">{t("drawer.noRuns")}</p>}
          {list.length > 0 && (
            <section aria-label={t("drawer.runsByStep")} className="mb-3 shrink-0 rounded-md border border-border bg-bg px-3 pt-2 pb-1.5">
              <div className="relative">
                {order.map((s) => (
                  <div key={s} className="grid grid-cols-[72px_minmax(0,1fr)] items-center border-b border-border-subtle last:border-b-0">
                    <span className="truncate text-label text-muted">{s}</span>
                    <div className="relative h-[30px]">
                      {seq
                        .filter((r) => r.step === s)
                        .map((r) => {
                          const on = r.run === selected?.run;
                          const a = Date.parse(r.startedAt);
                          return (
                            <button
                              key={r.run}
                              type="button"
                              aria-pressed={on}
                              aria-label={`${r.step} ${formatOutcome(r, lang)}, ${formatRelative(r.startedAt, now, lang)}, ${formatDuration(runDurationMs(r, now))}`}
                              title={`${r.step} · ${formatOutcome(r, lang)} · ${formatDuration(runDurationMs(r, now))} · ${formatRunCost(r, lang)}`}
                              onClick={() => setPicked(r.run)}
                              className={`absolute top-1/2 h-3.5 min-w-2 -translate-y-1/2 rounded-sm ${RUN_BG[outcomeTone(r)]} ${r.running ? "animate-status-pulse" : ""} ${on ? "z-10 ring-2 ring-fg ring-offset-2 ring-offset-bg" : "opacity-60 hover:opacity-100"}`}
                              style={{ left: `${span.x(a)}%`, width: `${span.x(runEndMs(r, now)) - span.x(a)}%` }}
                            />
                          );
                        })}
                    </div>
                  </div>
                ))}
                <svg aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 left-[72px] h-full w-[calc(100%-72px)]" viewBox={`0 0 100 ${order.length}`} preserveAspectRatio="none">
                  {seq.slice(0, -1).map((r, i) => {
                    const n = seq[i + 1];
                    const x1 = span.x(runEndMs(r, now));
                    const x2 = span.x(Date.parse(n.startedAt));
                    const y1 = order.indexOf(r.step) + 0.5;
                    const y2 = order.indexOf(n.step) + 0.5;
                    const xm = (x1 + x2) / 2;
                    return (
                      <path
                        key={r.run}
                        d={`M${x1} ${y1} C${xm + 1.5} ${y1} ${xm - 1.5} ${y2} ${x2} ${y2}`}
                        fill="none"
                        vectorEffect="non-scaling-stroke"
                        strokeWidth={isBounce(r) ? 1.5 : 1}
                        strokeDasharray={isBounce(r) ? "4 3" : undefined}
                        className={isBounce(r) ? "stroke-status-held" : "stroke-border-strong"}
                      />
                    );
                  })}
                </svg>
                <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 left-[72px]">
                  {span.breaks.map((b) => (
                    <span key={b.x} className="absolute inset-y-0 border-l border-dashed border-border-strong" style={{ left: `${b.x}%` }} />
                  ))}
                </div>
              </div>
              <div className="relative mt-1 ml-[72px] h-3.5 font-mono text-meta text-muted">
                {!span.breaks.some((b) => b.x < 16) && <span className="absolute left-0">{clock(span.t0)}</span>}
                {span.breaks.map((b) => (
                  <span key={b.x} title={t("drawer.idleBreak")} className="absolute -translate-x-1/2 bg-bg px-1 whitespace-nowrap" style={{ left: `${b.x}%` }}>
                    +{formatDuration(b.ms)}
                  </span>
                ))}
                {!span.breaks.some((b) => b.x > 84) && <span className="absolute right-0">{clock(span.t1)}</span>}
              </div>
            </section>
          )}
          {selected && (
            <div data-run-caption className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-label">
              <span className="font-medium text-fg">{selected.step}</span>
              <Pill tone={outcomeTone(selected)}>{formatOutcome(selected, lang)}</Pill>
              <span className="font-mono text-muted">{formatDuration(runDurationMs(selected, now))}</span>
              <span className="font-mono text-muted">{formatRunCost(selected, lang)}</span>
              <span className="text-muted" title={selected.startedAt}>
                {t("drawer.started", { when: formatRelative(selected.startedAt, now, lang) })}
              </span>
              {seq.some(isBounce) && (
                <span className="ml-auto inline-flex items-center gap-1.5 text-meta text-muted">
                  <svg aria-hidden="true" width="18" height="6" className="stroke-status-held">
                    <line x1="0" y1="3" x2="18" y2="3" strokeWidth="1.5" strokeDasharray="4 3" />
                  </svg>
                  {t("drawer.sentBack")}
                </span>
              )}
            </div>
          )}
          {selected?.plain && (
            <p data-run-plain className="mb-1 text-body text-fg">
              {selected.plain}<SpeakButton text={selected.plain} label={t("drawer.readRunSummary")} className="ml-1 align-middle" />
            </p>
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
  const { t, lang } = useT();
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
  const [view, setView] = useState(readLogView);
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
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
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
  const live = liveIndicator(status, running, everOpened, lang);

  let body;
  if (view === "story") {
    body = <RunStory buf={buf.current} gen={gen} total={total} tail={buf.current.partial} running={running} />;
  } else if (wrap) {
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
        <span className={`inline-flex items-center gap-1.5 ${DOT_TEXT[live.tone]}`} data-live={liveIndicator(status, running, everOpened).label}>
          <span aria-hidden="true" className={`size-1.5 rounded-full bg-current ${live.pulse ? "animate-status-pulse" : ""}`} />
          {live.label}
        </span>
        <span className="truncate font-mono text-meta" title={run}>
          {run}
        </span>
        <span>{t("drawer.lines", { count: total })}</span>
        {partialOnly && <span>{t("drawer.partialLog")}</span>}
        <span className="ml-auto flex items-center gap-2">
          {!following && (
            <button type="button" className="rounded-md border border-border px-2 text-fg hover:bg-surface-raised" onClick={jumpToEnd}>
              {t("drawer.jumpToEnd")}
            </button>
          )}
          <span role="tablist" aria-label={t("drawer.logView")} className="inline-flex rounded-md border border-border p-px">
            {(["story", "raw"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                data-log-view={v}
                className={`rounded-[4px] px-2 ${view === v ? "bg-surface-raised text-fg" : "text-muted hover:text-fg"}`}
                onClick={() => {
                  setView(v);
                  writeLogView(v);
                }}
              >
                {v === "story" ? t("drawer.story") : t("drawer.raw")}
              </button>
            ))}
          </span>
          <label className={`flex cursor-pointer items-center gap-1 ${view === "story" ? "hidden" : ""}`}>
            <input
              type="checkbox"
              checked={wrap}
              onChange={(e) => {
                setWrap(e.target.checked);
                writeWrap(e.target.checked);
              }}
            />
            {t("drawer.wrap")}
          </label>
          <button
            type="button"
            className="rounded-md border border-border px-2 text-fg hover:bg-surface-raised"
            title={partialOnly ? t("drawer.copyPartial") : t("drawer.copyLog")}
            onClick={copy}
          >
            {copied === "ok" ? t("copy.copied") : copied === "fail" ? t("copy.failed") : t("copy.copy")}
          </button>
        </span>
      </div>
      <div
        ref={box}
        className={`relative min-h-0 flex-1 overflow-auto rounded-md border border-border bg-bg ${view === "story" ? "" : "font-mono text-label"}`}
        style={view === "story" ? undefined : { lineHeight: `${LINE_H}px` }}
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

/** Beats past this many fold into "Show N more" (the first few and the last several stay). */
const BEAT_FOLD = 12;

/**
 * The Story tab: the log as the agent told it. Each one-line message is a beat on a thin rail,
 * the report renders as markdown, and `[agenthook]` notices stand out. Model output built from
 * third-party ticket content: react-markdown escapes raw HTML, never add rehype-raw.
 */
const RunStory = memo(function RunStory({ buf, total, running }: { buf: LogBuffer; gen: number; total: number; tail: string; running: boolean }) {
  const { t } = useT();
  const [unfold, setUnfold] = useState(false);
  const blocks = useMemo(() => {
    const lines: string[] = [];
    for (let i = 0; i < total; i++) lines.push(lineAt(buf, i));
    return storyBlocks(lines);
    // `total` and the trailing partial change whenever the buffer does (it is mutated in place).
  }, [buf, total, buf.partial]); // eslint-disable-line react-hooks/exhaustive-deps
  const beatIdx = blocks.flatMap((b, i) => (b.kind === "beat" ? [i] : []));
  const fold = !unfold && beatIdx.length > BEAT_FOLD ? new Set(beatIdx.slice(3, beatIdx.length - 6)) : new Set<number>();
  const lastBeat = beatIdx[beatIdx.length - 1];
  if (blocks.length === 0) return <p className="p-3 text-label text-muted">{running ? t("drawer.waitingFirst") : t("drawer.wroteNothing")}</p>;
  const out: React.ReactNode[] = [];
  let folded = false;
  blocks.forEach((b: StoryBlock, i) => {
    if (fold.has(i)) {
      if (!folded) {
        folded = true;
        out.push(
          <li key={`fold-${i}`} className="relative pb-2 pl-5">
            <span aria-hidden="true" className="absolute top-2 left-[5px] h-px w-[7px] bg-border-strong" />
            <button type="button" className="text-label text-accent hover:underline" onClick={() => setUnfold(true)}>
              {t("drawer.showMore", { count: fold.size })}
            </button>
          </li>,
        );
      }
      return;
    }
    if (b.kind === "beat") {
      const live = running && i === lastBeat;
      out.push(
        <li key={i} data-story-beat className="relative pb-2 pl-5 text-body text-fg">
          <span aria-hidden="true" className={`absolute top-[7px] left-[4px] size-[7px] rounded-full ${live ? "animate-status-pulse bg-status-running" : "bg-border-strong"}`} />
          {b.text.replace(/\*\*/g, "")}
        </li>,
      );
    } else if (b.kind === "notice") {
      out.push(
        <li key={i} data-story-notice className="relative my-2 rounded-md bg-status-held-bg px-3 py-1.5 text-label text-status-held">
          {b.text}
        </li>,
      );
    } else {
      out.push(
        <li key={i} data-story-prose className="md-preview relative my-2 bg-bg border-t border-border-subtle pt-2 text-body text-fg [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Markdown>{b.text}</Markdown>
        </li>,
      );
    }
  });
  return (
    <ol className="relative m-0 list-none p-3 before:absolute before:top-4 before:bottom-4 before:left-[19px] before:w-px before:bg-border" data-run-story>
      {out}
    </ol>
  );
});
