import { useState } from "react";
import type { ProfileView, TicketRow, TicketStatus } from "./contract";
import { formatModel, formatRelative, formatTicketSpend, profileLabel, ticketTitle } from "./format";
import { filterTickets, pageLimit, prNumber, showMore, sortTickets, statusCounts, ticketEpics, PAGE_SIZE, STATUS_ORDER } from "./tickets";
import type { Page, StatusFilter } from "./tickets";
import { Segmented, StatusBadge, Tooltip } from "./components";

// Full class strings so Tailwind's scanner sees them: the pinned rows' low-alpha tint.
const PINNED_TINT: Partial<Record<TicketStatus, string>> = {
  held: "bg-status-held-bg/40",
  failed: "bg-status-failed-bg/40",
  interrupted: "bg-status-failed-bg/40",
};

const STATUS_TITLE: Partial<Record<TicketStatus, string>> = {
  interrupted: "receiver is down — this run was interrupted",
  stalled: "receiver is down — will resume when it restarts",
};

const CELL = "px-2 py-1";
const NOWRAP = `${CELL} whitespace-nowrap`;

export type TicketsTableProps = {
  tickets: TicketRow[];
  profiles: ProfileView[];
  now: number;
  profileFilter: string;
  onProfileFilter: (v: string) => void;
  /** Hide the profile picker and column: the table is already one profile's (the profile Overview). */
  lockProfile?: boolean;
  /** `""` = all statuses. */
  statusFilter: string;
  onStatusFilter: (v: string) => void;
  /** An epic ref, `""` = every epic. */
  epicFilter: string;
  onEpicFilter: (v: string) => void;
  showAll: boolean;
  onShowAll: (v: boolean) => void;
  /** The ticket whose drawer is open (highlighted), if any. */
  open: { profile: string; ref: string } | null;
  onOpen: (t: { profile: string; ref: string }) => void;
  /** Acknowledge a failed/cancelled ticket (it then reads `idle`). */
  onDismiss: (t: { profile: string; ref: string }) => void;
};

/** The dashboard's tickets section: a one-row filter toolbar over a paged table in its own scroll region. */
export function TicketsTable(props: TicketsTableProps) {
  const { tickets, profiles, now, profileFilter, statusFilter, epicFilter, showAll, open } = props;
  const forges = new Set(profiles.filter((p) => p.forge).map((p) => p.name));
  const base = { profile: profileFilter || null, epic: epicFilter || null, showAll, now, forges };
  const epics = ticketEpics(profileFilter ? tickets.filter((t) => t.profile === profileFilter) : tickets);
  const counts = statusCounts(tickets, base);
  const rows = sortTickets(filterTickets(tickets, { ...base, status: (statusFilter || null) as StatusFilter | null }));
  // Grown pages reset to one whenever a filter changes (the key no longer matches).
  const key = `${profileFilter}\u0000${statusFilter}\u0000${epicFilter}\u0000${showAll}`;
  const [page, setPage] = useState<Page>({ key, limit: PAGE_SIZE });
  const limit = pageLimit(page, key);
  const shown = rows.slice(0, limit);
  const remaining = rows.length - shown.length;

  const chips: { value: string; label: React.ReactNode }[] = [
    { value: "", label: <ChipLabel text="all" count={counts.all} /> },
    { value: "needs-you", label: <ChipLabel text="needs you" count={counts["needs-you"]} /> },
    ...STATUS_ORDER.filter((s) => counts[s] > 0 || statusFilter === s).map((s) => ({ value: s, label: <ChipLabel text={s} count={counts[s]} /> })),
  ];

  return (
    <>
      <h2 className="text-base font-semibold mb-2">tickets</h2>
      <div className="flex flex-wrap items-center gap-3 mb-2 text-sm" data-tickets-toolbar>
        {!props.lockProfile && (
        <select
          aria-label="profile"
          className="border border-border rounded px-1.5 py-0.5 bg-transparent"
          value={profileFilter}
          onChange={(e) => props.onProfileFilter(e.target.value)}
        >
          <option value="">all profiles</option>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {profileLabel(p)}
            </option>
          ))}
        </select>
        )}
        {(epics.length > 0 || epicFilter) && (
          <select
            aria-label="epic"
            data-epic-filter
            className="max-w-48 border border-border rounded px-1.5 py-0.5 bg-transparent"
            value={epicFilter}
            onChange={(e) => props.onEpicFilter(e.target.value)}
          >
            <option value="">All epics</option>
            {epicFilter && !epics.some((e) => e.ref === epicFilter) && <option value={epicFilter}>{epicFilter}</option>}
            {epics.map((e) => (
              <option key={e.ref} value={e.ref}>
                {e.name}
              </option>
            ))}
          </select>
        )}
        <Segmented value={statusFilter} options={chips} onChange={props.onStatusFilter} />
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showAll} onChange={(e) => props.onShowAll(e.target.checked)} />
          show all
        </label>
        <span className="text-muted">
          {shown.length} shown / {tickets.length} total
        </span>
      </div>
      <div className="max-h-[60vh] overflow-auto rounded-lg border border-border mb-6" data-tickets-scroll>
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface shadow-[inset_0_-1px_0_var(--color-border)]">
            <tr className="text-left text-muted">
              <th className={NOWRAP}>id</th>
              <th className={NOWRAP}>title</th>
              <th className={NOWRAP}>profile</th>
              <th className={NOWRAP}>step</th>
              <th className={NOWRAP}>status</th>
              <th className={NOWRAP}>model</th>
              <th className={NOWRAP}>started</th>
              <th className={NOWRAP}>cost</th>
              <th className={NOWRAP}>held reason</th>
              <th className={NOWRAP}>PR</th>
              <th className={NOWRAP} aria-label="actions"></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => (
              <Row key={`${t.profile}\u0000${t.ref}`} t={t} now={now} selected={open?.profile === t.profile && open.ref === t.ref} onOpen={props.onOpen} onDismiss={props.onDismiss} onEpic={props.onEpicFilter} />
            ))}
          </tbody>
        </table>
        {remaining > 0 && (
          <div className="border-t border-border-subtle p-2 text-center">
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1 text-label hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
              onClick={() => setPage(showMore(page, key))}
            >
              show {PAGE_SIZE} more ({remaining} remaining)
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function ChipLabel({ text, count }: { text: string; count: number }) {
  return (
    <>
      {text} <span className="font-mono opacity-70">{count}</span>
    </>
  );
}

function Row({ t, now, selected, onOpen, onDismiss, onEpic }: { t: TicketRow; now: number; selected: boolean; onOpen: TicketsTableProps["onOpen"]; onDismiss: TicketsTableProps["onDismiss"]; onEpic: (ref: string) => void }) {
  const title = ticketTitle(t);
  const model = formatModel(t.model);
  const pr = prNumber(t.prUrl);
  return (
    <tr
      data-ticket-row={t.ref}
      className={`cursor-pointer border-b border-border-subtle hover:bg-surface-raised ${selected ? "bg-border" : PINNED_TINT[t.status] ?? ""}`}
      onClick={(e) => {
        // Links in the row (tracker, PR) and the epic chip keep their own behavior.
        if ((e.target as HTMLElement).closest("a, [data-epic-chip]")) return;
        onOpen({ profile: t.profile, ref: t.ref });
      }}
    >
      <td className={`${NOWRAP} font-mono`}>
        {t.trackerUrl ? (
          <a className="text-accent hover:underline" href={t.trackerUrl} target="_blank" rel="noopener noreferrer">
            {t.displayId}
            <span aria-hidden="true"> ↗</span>
          </a>
        ) : (
          t.displayId
        )}
      </td>
      <td className={CELL}>
        {t.epic && (
          <button
            type="button"
            data-epic-chip={t.epic.ref}
            title={`epic: ${t.epic.name} — show only its tickets`}
            className="mb-0.5 block max-w-48 truncate rounded-full border border-border bg-surface-raised px-2 text-meta text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => onEpic(t.epic!.ref)}
          >
            {t.epic.name}
          </button>
        )}
        <div title={t.summary ? `${t.title ?? t.displayId} — ${t.summary}` : t.title ?? undefined} className={`min-w-40 max-w-md truncate max-lg:max-w-64 max-lg:whitespace-normal max-lg:line-clamp-2 ${title.unknown ? "text-muted" : ""}`}>
          {title.text}
        </div>
      </td>
      <td className={`${NOWRAP} font-mono`}>{t.profile}</td>
      <td className={NOWRAP}>{t.step ?? "—"}</td>
      <td className={NOWRAP} title={STATUS_TITLE[t.status]}>
        <StatusBadge status={t.status} />
      </td>
      <td className={NOWRAP} title={model.title}>
        {model.text}
      </td>
      <td className={NOWRAP}>{formatRelative(t.startedAt, now)}</td>
      <td className={NOWRAP}>{formatTicketSpend(t)}</td>
      <td className={CELL}>
        {t.heldReason ? (
          <Tooltip text={t.heldReason}>
            <span className="block max-w-64 truncate">{t.heldReason}</span>
          </Tooltip>
        ) : (
          "—"
        )}
      </td>
      <td className={NOWRAP}>
        {t.prUrl ? (
          <a className="text-accent hover:underline" href={t.prUrl} target="_blank" rel="noopener noreferrer">
            {pr ? `#${pr}` : "PR"}
          </a>
        ) : (
          "—"
        )}
      </td>
      <td className={NOWRAP}>
        {(t.status === "failed" || t.status === "cancelled") && (
          <button
            type="button"
            title="Acknowledge: stop counting this ticket as needing you (the ticket itself is untouched)"
            className="rounded-md border border-border px-2 py-0.5 text-label hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => onDismiss({ profile: t.profile, ref: t.ref })}
          >
            dismiss
          </button>
        )}
      </td>
    </tr>
  );
}
