import type { LogFrame, RunView, TicketStatus, UiEvent } from "./contract";
import { formatCost } from "./format";
import { translate } from "./i18n";
import { formatEnergy } from "../../src/energy.js";

/** Retained-line cap: the oldest lines drop past this so a huge log can't exhaust memory. */
export const MAX_LINES = 50_000;

/**
 * A log being tailed: complete lines plus the trailing line still being written.
 * Mutated in place (a 50 000-line copy per append frame would be wasteful); the
 * caller bumps its own render counter after each apply.
 */
export type LogBuffer = {
  lines: string[];
  partial: string;
  /** lines dropped off the front by the cap */
  dropped: number;
  /** the init frame started mid-file (older bytes never sent) */
  truncated: boolean;
};

export function emptyLog(): LogBuffer {
  return { lines: [], partial: "", dropped: 0, truncated: false };
}

/** Append raw text, carrying an unterminated last line into `partial`. */
export function appendText(buf: LogBuffer, text: string, cap = MAX_LINES): LogBuffer {
  if (!text) return buf;
  const parts = (buf.partial + text).split("\n");
  buf.partial = parts.pop() ?? "";
  for (const line of parts) buf.lines.push(line);
  const excess = buf.lines.length - cap;
  if (excess > 0) {
    buf.lines.splice(0, excess);
    buf.dropped += excess;
  }
  return buf;
}

/** Apply one `/api/log/stream` frame: `init` replaces, `append` extends, `reset` clears. */
export function applyFrame(buf: LogBuffer, frame: LogFrame, cap = MAX_LINES): LogBuffer {
  if (frame.type === "append") return appendText(buf, frame.text, cap);
  buf.lines = [];
  buf.partial = "";
  buf.dropped = 0;
  buf.truncated = false;
  if (frame.type === "init") {
    buf.truncated = frame.truncated;
    appendText(buf, frame.text, cap);
  }
  return buf;
}

/** Rendered line count: complete lines plus a non-empty partial. */
export function lineCount(buf: LogBuffer): number {
  return buf.lines.length + (buf.partial ? 1 : 0);
}

export function lineAt(buf: LogBuffer, i: number): string {
  return i < buf.lines.length ? buf.lines[i] : buf.partial;
}

/** [start, end) of the lines to render for a fixed line height, with overscan on both sides. */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  lineHeight: number,
  total: number,
  overscan = 20,
): { start: number; end: number } {
  const first = Math.floor(Math.max(0, scrollTop) / lineHeight);
  const count = Math.ceil(Math.max(0, viewportHeight) / lineHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(total, first + count + overscan) };
}

/** Follow the tail only while scrolled to (within `slack` px of) the bottom. */
export function isAtBottom(scrollTop: number, clientHeight: number, scrollHeight: number, slack = 4): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= slack;
}

/** A run_start / run_end for this ticket — its run list changed. */
export function affectsRuns(ev: UiEvent, profile: string, ref: string): boolean {
  if (ev.type !== "event" || ev.profile !== profile || ev.event.ref !== ref) return false;
  return ev.event.event === "run_start" || ev.event.event === "run_end";
}

export function runsUrl(profile: string, ref: string): string {
  return `/api/runs?${new URLSearchParams({ profile, ref })}`;
}

export function logStreamUrl(profile: string, run: string): string {
  return `/api/log/stream?${new URLSearchParams({ profile, run })}`;
}

/** "advance" / "running" / "—" — a verdict stays as the agent wrote it (a protocol word, like a step id). */
export function formatOutcome(r: Pick<RunView, "outcome" | "running">, lang = "en"): string {
  return r.outcome ?? (r.running ? translate(lang, "status.running") : "—");
}

/**
 * A run's cost cell: the reported cost; else "~$x est." — a rate-table estimate (src/pricing.js),
 * for a non-Claude agent or a local model; else "unpriced" (no real cost and no rate), "—" when none.
 * A measured run (src/energy.js) appends " · energy $0.00029 (1.9 Wh)" — beside, never added.
 */
export function formatRunCost(r: Pick<RunView, "costUsd" | "unpriced"> & Partial<Pick<RunView, "estUsd" | "energyKwh" | "energyUsd">>, lang = "en"): string {
  const cost =
    !r.unpriced && r.costUsd
      ? formatCost(r.costUsd, lang)
      : typeof r.estUsd === "number" && r.estUsd > 0
        ? translate(lang, "runlog.estimate", { cost: formatCost(r.estUsd, lang) })
        : r.unpriced
          ? translate(lang, "runlog.unpriced")
          : formatCost(r.costUsd ?? 0, lang);
  const energy = formatEnergy(r);
  return energy ? `${cost} · ${energy}` : cost;
}

/** A run's outcome in the status colour language. */
export function outcomeTone(r: Pick<RunView, "outcome" | "running">): TicketStatus {
  if (r.outcome === "advance") return "done";
  if (r.outcome === "fail") return "failed";
  if (r.outcome === "hold" || r.outcome === "changes") return "held";
  if (!r.outcome && r.running) return "running";
  return "idle";
}

/** Ended: endedAt − startedAt; running: now − startedAt; otherwise (or unparseable) null. */
export function runDurationMs(r: Pick<RunView, "startedAt" | "endedAt" | "running">, now: number): number | null {
  const start = Date.parse(r.startedAt);
  const end = r.endedAt ? Date.parse(r.endedAt) : r.running ? now : NaN;
  return Number.isNaN(start) || Number.isNaN(end) ? null : end - start;
}

/** Lines per wrap-mode chunk: an append re-renders only the chunk it lands in. */
export const CHUNK_LINES = 200;

/**
 * Split `total` buffer lines into chunks aligned to absolute line numbers (`offset` = lines
 * already dropped off the front), so `key` — the chunk's first absolute line — stays stable as
 * the cap drops lines: only the first chunk shrinks, the rest keep their key and content.
 */
export function chunkRanges(total: number, size = CHUNK_LINES, offset = 0): { key: number; start: number; end: number }[] {
  const out = [];
  for (let start = 0; start < total; ) {
    const key = Math.floor((start + offset) / size) * size;
    const end = Math.min(total, key + size - offset);
    out.push({ key, start, end });
    start = end;
  }
  return out;
}

/** The loaded log as one string: every complete line newline-terminated, then the partial. */
export function logText(buf: LogBuffer): string {
  return buf.lines.map((l) => l + "\n").join("") + buf.partial;
}

export type StreamStatus = "connecting" | "live" | "closed";

/** The log toolbar's live dot: pulsing only while the stream is open on a running run. */
export function liveIndicator(
  status: StreamStatus,
  running: boolean,
  everOpened: boolean,
  lang = "en",
): { label: string; tone: TicketStatus; pulse: boolean } {
  if (status === "closed") return { label: translate(lang, "runlog.disconnected"), tone: "failed", pulse: false };
  if (status === "connecting") return { label: translate(lang, everOpened ? "runlog.reconnecting" : "runlog.connecting"), tone: "held", pulse: false };
  return running ? { label: translate(lang, "runlog.live"), tone: "running", pulse: true } : { label: translate(lang, "runlog.ended"), tone: "idle", pulse: false };
}

const WRAP_KEY = "ah.log.wrap";

/** The log's wrap toggle, persisted per browser; on unless explicitly turned off. */
const VIEW_KEY = "ah.log.view";

/** The run view's last-picked tab: the parsed story (default) or the raw log. */
export function readLogView(store: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): "story" | "raw" {
  try {
    return store?.getItem(VIEW_KEY) === "raw" ? "raw" : "story";
  } catch {
    return "story";
  }
}

export function writeLogView(view: "story" | "raw", store: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    store?.setItem(VIEW_KEY, view);
  } catch {
    /* storage disabled — the tab just won't persist */
  }
}

export function readWrap(store: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try {
    return store?.getItem(WRAP_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeWrap(on: boolean, store: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    store?.setItem(WRAP_KEY, on ? "1" : "0");
  } catch {
    /* storage disabled — the toggle just won't persist */
  }
}
