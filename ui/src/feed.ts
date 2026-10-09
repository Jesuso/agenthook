import type { TicketStatus, UiEvent } from "./contract";
import { shortRef } from "./format";

export const FEED_MAX = 200;

export type FeedEntry = Extract<UiEvent, { type: "event" }>;

/** Newest first, capped at FEED_MAX. Immutable. */
export function appendFeed(feed: FeedEntry[], ev: FeedEntry): FeedEntry[] {
  return [ev, ...feed].slice(0, FEED_MAX);
}

const RUN_END_TONE: Record<string, TicketStatus> = { advance: "done", hold: "held", changes: "queued", fail: "failed" };
const RUN_END_WORD: Record<string, string> = { advance: "passed", hold: "held", changes: "→ changes", fail: "failed" };

const PLAIN_EVENTS = new Set(["restart_requested", "restarting", "decommission_requested", "decommissioning"]);

/** Human text + status tone for one events.jsonl line (src/dispatch.js / src/engine.js event names). */
export function formatFeedEvent(event: Record<string, any>, displayId: string | null): { text: string; title?: string; tone: TicketStatus; ticket: boolean } {
  const name = String(event.event ?? "");
  const ref = event.ref ? String(event.ref) : "";
  const ticket = ref !== "";

  let text: string;
  let tone: TicketStatus = "idle";

  switch (name) {
    case "run_start": {
      text = `started ${event.step ?? "?"}`;
      tone = "running";
      break;
    }
    case "run_end": {
      const outcome = String(event.outcome ?? "");
      const word = RUN_END_WORD[outcome] ?? (outcome || "ended");
      tone = RUN_END_TONE[outcome] ?? "idle";
      text = `${event.step ?? "?"} ${word}`;
      if (typeof event.costUsd === "number") text += ` · $${event.costUsd.toFixed(2)}`;
      break;
    }
    case "enqueued": {
      text = `queued for ${event.step ?? "?"}`;
      tone = "queued";
      break;
    }
    case "failed": {
      text = `failed: ${event.reason ?? "?"}`;
      tone = "failed";
      break;
    }
    case "blocked": {
      text = `held: ${event.reason ?? "?"}`;
      tone = "held";
      break;
    }
    case "merged": {
      text = "merged";
      tone = "done";
      break;
    }
    case "pipeline_done": {
      text = "done";
      tone = "done";
      break;
    }
    case "ci_red": {
      text = `CI red (${event.action ?? "?"})`;
      tone = "failed";
      break;
    }
    case "overlap_held": {
      text = "waiting on overlap";
      tone = "held";
      break;
    }
    case "overlap_released":
    case "pulled": {
      text = name === "pulled" ? "pulled" : "overlap released";
      tone = "queued";
      break;
    }
    default: {
      if (PLAIN_EVENTS.has(name)) {
        text = name.replace(/_/g, " ");
        tone = "idle";
        return { text, tone, ticket: false };
      }
      text = name || "event";
      tone = "idle";
    }
  }

  const title = text.length > 60 ? text : undefined;
  return { text, title, tone, ticket };
}

/** displayId when present and distinct from `ref`, else the shortened ref (full ref as tooltip). */
export function ticketLabel(ref: string, displayId: string | null): { text: string; title?: string } {
  if (displayId && displayId !== ref) return { text: displayId };
  return shortRef(ref);
}

export type FeedGroup = { minute: string; key: string; entries: FeedEntry[] };

/** Groups a newest-first feed by local HH:MM, preserving order. Missing/invalid `ts` go in a "—" group. */
export function groupByMinute(feed: FeedEntry[]): FeedGroup[] {
  const groups: FeedGroup[] = [];
  let current: FeedGroup | null = null;
  for (const entry of feed) {
    const key = minuteKey(entry.event.ts);
    if (!current || current.key !== key) {
      current = { minute: key === "—" ? "—" : minuteLabel(entry.event.ts), key, entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

function minuteKey(ts: unknown): string {
  if (typeof ts !== "string") return "—";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "—";
  return String(Math.floor(t / 60000));
}

function minuteLabel(ts: unknown): string {
  const t = new Date(String(ts));
  return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const RAIL_OPEN_KEY = "ah.activity.open";

/** The activity rail's open/closed state, persisted per browser; on unless explicitly closed. */
export function readRailOpen(store: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try {
    return store?.getItem(RAIL_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeRailOpen(on: boolean, store: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    store?.setItem(RAIL_OPEN_KEY, on ? "1" : "0");
  } catch {
    /* storage disabled — the toggle just won't persist */
  }
}
