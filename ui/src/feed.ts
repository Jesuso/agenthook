import type { TicketStatus, UiEvent } from "./contract";
import { shortRef } from "./format";
import { formatEnergy } from "../../src/energy.js";
import { translate } from "./i18n";
import type { MessageKey, Vars } from "./i18n";

export const FEED_MAX = 200;

export type FeedEntry = Extract<UiEvent, { type: "event" }>;

/** Newest first, capped at FEED_MAX. Immutable. */
export function appendFeed(feed: FeedEntry[], ev: FeedEntry): FeedEntry[] {
  return [ev, ...feed].slice(0, FEED_MAX);
}

const RUN_END_TONE: Record<string, TicketStatus> = { advance: "done", hold: "held", changes: "queued", fail: "failed" };
const RUN_END_KEY: Record<string, MessageKey> = { advance: "feed.runEnd.advance", hold: "feed.runEnd.hold", changes: "feed.runEnd.changes", fail: "feed.runEnd.fail" };

/** Events shown as their name in words, with no ticket (the English is the name with `_` → space). */
const PLAIN_EVENTS: Record<string, MessageKey> = {
  restart_requested: "feed.restartRequested",
  restarting: "feed.restarting",
  decommission_requested: "feed.decommissionRequested",
  decommissioning: "feed.decommissioning",
};

/** Event names hidden from the activity feed by default (src/events.js HIDDEN_BY_DEFAULT). */
const HIDDEN_FEED_EVENTS = new Set(["coalesced", "digest_start", "digest_end", "epic_changed"]);

/** Whether `name` (events.jsonl's `event` field) should not be appended to the activity feed. */
export function isHiddenFeedEvent(name: string): boolean {
  return HIDDEN_FEED_EVENTS.has(name);
}

/** Human text (in `lang`) + status tone for one events.jsonl line (src/dispatch.js / src/engine.js event names). */
export function formatFeedEvent(event: Record<string, any>, displayId: string | null, lang = "en"): { text: string; title?: string; tone: TicketStatus; ticket: boolean } {
  const tr = (key: MessageKey, vars?: Vars) => translate(lang, key, vars);
  const name = String(event.event ?? "");
  const ref = event.ref ? String(event.ref) : "";
  const ticket = ref !== "";
  const step = event.step ?? "?";

  let text: string;
  let tone: TicketStatus = "idle";

  switch (name) {
    case "run_start": {
      text = tr("feed.runStart", { step });
      tone = "running";
      break;
    }
    case "run_end": {
      const outcome = String(event.outcome ?? "");
      const key = Object.hasOwn(RUN_END_KEY, outcome) ? RUN_END_KEY[outcome] : undefined;
      tone = RUN_END_TONE[outcome] ?? "idle";
      // An outcome this UI doesn't know shows as its raw name.
      text = key ? tr(key, { step }) : outcome ? `${step} ${outcome}` : tr("feed.runEnd.ended", { step });
      if (typeof event.costUsd === "number" && event.unpriced !== true) text += ` · $${event.costUsd.toFixed(2)}`;
      else if (typeof event.estUsd === "number") text += ` · ${tr("feed.est", { value: event.estUsd.toFixed(2) })}`;
      const energy = formatEnergy(event);
      if (energy) text += ` · ${energy}`;
      break;
    }
    case "enqueued": {
      text = tr("feed.enqueued", { step });
      tone = "queued";
      break;
    }
    case "failed": {
      // Mirrors CANCELLED_REASON in src/events.js: an operator cancel is not a crash.
      const cancelled = event.reason === "cancelled by operator";
      text = cancelled ? tr("feed.cancelled") : tr("feed.failed", { reason: event.reason ?? "?" });
      tone = cancelled ? "cancelled" : "failed";
      break;
    }
    case "dismissed": {
      text = tr("feed.dismissed");
      tone = "idle";
      break;
    }
    case "coalesced": {
      text = tr("feed.coalesced");
      tone = "idle";
      break;
    }
    case "verdict_missing": {
      text = tr("feed.verdictMissing", { step });
      tone = "held";
      break;
    }
    case "blocked": {
      text = tr("feed.blocked", { reason: event.reason ?? "?" });
      tone = "held";
      break;
    }
    case "merged": {
      text = tr("feed.merged");
      tone = "done";
      break;
    }
    case "pipeline_done": {
      text = tr("status.done");
      tone = "done";
      break;
    }
    case "ci_red": {
      text = tr("feed.ciRed", { action: event.action ?? "?" });
      tone = "failed";
      break;
    }
    case "overlap_held": {
      text = tr("feed.overlapHeld");
      tone = "held";
      break;
    }
    case "overlap_released":
    case "pulled": {
      text = tr(name === "pulled" ? "feed.pulled" : "feed.overlapReleased");
      tone = "queued";
      break;
    }
    case "epic_skipped": {
      text = tr("feed.epicSkipped");
      tone = "idle";
      break;
    }
    case "epic_changed": {
      text = tr("feed.epicChanged");
      tone = "idle";
      break;
    }
    default: {
      if (Object.hasOwn(PLAIN_EVENTS, name)) {
        text = tr(PLAIN_EVENTS[name]);
        tone = "idle";
        return { text, tone, ticket: false };
      }
      text = name || tr("lastEvent.event");
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

