import type { UiEvent } from "./contract";

export const FEED_MAX = 200;

export type FeedEntry = Extract<UiEvent, { type: "event" }>;

/** Newest first, capped at FEED_MAX. Immutable. */
export function appendFeed(feed: FeedEntry[], ev: FeedEntry): FeedEntry[] {
  return [ev, ...feed].slice(0, FEED_MAX);
}

/** "outcome=X reason=Y cost=$Z" — only the fields present on the event. */
export function formatEventDetail(event: Record<string, any>): string {
  const parts: string[] = [];
  if (event.outcome != null) parts.push(`outcome=${String(event.outcome)}`);
  if (event.reason != null) parts.push(`reason=${String(event.reason)}`);
  if (typeof event.costUsd === "number") parts.push(`cost=$${event.costUsd.toFixed(2)}`);
  return parts.join(" ");
}
