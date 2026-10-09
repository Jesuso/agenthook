import type { FeedEntry } from "./feed";
import { formatFeedEvent, groupByMinute, ticketLabel } from "./feed";
import { STATUS_CLASS } from "./components/StatusBadge";

export type ActivityRailProps = {
  feed: FeedEntry[];
  displayIdFor: (profile: string, ref: string) => string | null;
  open: boolean;
  onToggle: () => void;
  onOpen: (t: { profile: string; ref: string }) => void;
  /** "rail" (fixed-width right column, xl+) or "panel" (capped-height disclosure, narrow). */
  variant: "rail" | "panel";
};

/** The live event feed, grouped by minute, newest first — a collapsible right-hand rail on wide
 * screens or an "Activity" panel under the summary strip on narrow ones. Live-only: nothing before
 * the page opened. */
export function ActivityRail({ feed, displayIdFor, open, onToggle, onOpen, variant }: ActivityRailProps) {
  const groups = groupByMinute(feed);
  const bodyHeight = variant === "rail" ? "flex-1 min-h-0 overflow-y-auto" : "max-h-72 overflow-y-auto";

  return (
    <div data-activity-rail={variant} className={variant === "rail" ? "flex h-full flex-col" : "rounded-lg border border-border bg-surface"}>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <h2 className="text-base font-semibold">
          Activity <span className="font-mono text-label text-muted">{feed.length}</span>
        </h2>
        <button
          type="button"
          data-activity-toggle
          aria-expanded={open}
          className="rounded-md border border-border px-2 py-0.5 text-label hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
          onClick={onToggle}
        >
          {open ? "collapse" : "expand"}
        </button>
      </div>
      {open &&
        (feed.length === 0 ? (
          <p className="px-3 pb-3 text-label text-muted">No activity since this page opened — new events appear here live.</p>
        ) : (
          <div className={bodyHeight}>
            {groups.map((g) => (
              <div key={g.key}>
                <div className="sticky top-0 bg-surface px-3 py-0.5 text-label text-muted">{g.minute}</div>
                {g.entries.map((e, i) => (
                  <ActivityLine key={i} entry={e} displayId={e.event.ref ? displayIdFor(e.profile, String(e.event.ref)) : null} onOpen={onOpen} />
                ))}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

export function ActivityLine({ entry, displayId, onOpen }: { entry: FeedEntry; displayId: string | null; onOpen: (t: { profile: string; ref: string }) => void }) {
  const f = formatFeedEvent(entry.event, displayId);
  const ref = entry.event.ref ? String(entry.event.ref) : "";
  const time = formatTime(entry.event.ts);
  const label = f.ticket ? ticketLabel(ref, displayId) : null;
  const dotClass = STATUS_CLASS[f.tone].split(" ")[0];

  const content = (
    <>
      <span className="font-mono text-label text-muted">{time}</span>
      <span className="font-mono text-label text-muted">{entry.profile}</span>
      {label && (
        <span className="font-mono text-label" title={label.title}>
          {label.text}
        </span>
      )}
      <span className={`truncate ${dotClass}`} title={f.title}>
        {f.text}
      </span>
    </>
  );

  const rowClass = "flex items-center gap-2 px-3 py-1 text-label";

  if (!f.ticket) {
    return <div className={rowClass}>{content}</div>;
  }
  return (
    <button
      type="button"
      data-activity-line
      className={`${rowClass} w-full text-left hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent`}
      onClick={() => onOpen({ profile: entry.profile, ref })}
    >
      {content}
    </button>
  );
}

function formatTime(ts: unknown): string {
  if (typeof ts !== "string") return "—";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
