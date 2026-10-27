import { useState } from "react";
import type { ProfileView, TicketRow, TicketStatus } from "./contract";
import { formatModel, formatTicketSpend, profileLabel, ticketTitle } from "./format";
import { filterTickets, pageLimit, prNumber, showMore, sortTickets, statusCounts, ticketEpics, PAGE_SIZE, STATUS_ORDER } from "./tickets";
import type { Page, StatusFilter } from "./tickets";
import { Ago, Segmented, StatusBadge, Tooltip } from "./components";
import { useT } from "./i18n/react";
import type { MessageKey } from "./i18n";

// Full class strings so Tailwind's scanner sees them: the pinned rows' low-alpha tint.
const PINNED_TINT: Partial<Record<TicketStatus, string>> = {
  held: "bg-status-held-bg/40",
  failed: "bg-status-failed-bg/40",
  interrupted: "bg-status-failed-bg/40",
};

const STATUS_TITLE: Partial<Record<TicketStatus, MessageKey>> = {
  interrupted: "tickets.interruptedTitle",
  stalled: "tickets.stalledTitle",
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
  const { t: tr } = useT();
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
    { value: "", label: <ChipLabel text={tr("tickets.all")} count={counts.all} /> },
    { value: "needs-you", label: <ChipLabel text={tr("home.needsYou")} count={counts["needs-you"]} /> },
    ...STATUS_ORDER.filter((s) => counts[s] > 0 || statusFilter === s).map((s) => ({ value: s, label: <ChipLabel text={tr(`status.${s}`)} count={counts[s]} /> })),
  ];

  return (
    <>
      {/* The All tickets summary above is the visible heading; this keeps the outline for screen readers. */}
      <h2 className="sr-only">{tr("overview.allTickets")}</h2>
      <div className="flex flex-wrap items-center gap-3 mb-2 text-sm" data-tickets-toolbar>
        {!props.lockProfile && (
        <select
          aria-label={tr("tickets.profile")}
          className="border border-border rounded px-1.5 py-0.5 bg-transparent"
          value={profileFilter}
          onChange={(e) => props.onProfileFilter(e.target.value)}
        >
          <option value="">{tr("tickets.allProfiles")}</option>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {profileLabel(p)}
            </option>
          ))}
        </select>
        )}
        {(epics.length > 0 || epicFilter) && (
          <select
            aria-label={tr("tickets.epic")}
            data-epic-filter
            className="max-w-48 border border-border rounded px-1.5 py-0.5 bg-transparent"
            value={epicFilter}
            onChange={(e) => props.onEpicFilter(e.target.value)}
          >
            <option value="">{tr("tickets.allEpics")}</option>
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
          {tr("tickets.showAll")}
        </label>
        <span className="text-muted">
          {tr("tickets.shownTotal", { shown: shown.length, total: tickets.length })}
        </span>
      </div>
      <div className="max-h-[60vh] overflow-auto rounded-lg border border-border mb-6" data-tickets-scroll>
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface shadow-[inset_0_-1px_0_var(--color-border)]">
            <tr className="text-left text-muted">
              <th className={NOWRAP}>{tr("tickets.col.id")}</th>
              <th className={NOWRAP}>{tr("tickets.col.title")}</th>
              <th className={NOWRAP}>{tr("tickets.col.profile")}</th>
              <th className={NOWRAP}>{tr("tickets.col.step")}</th>
              <th className={NOWRAP}>{tr("tickets.col.status")}</th>
              <th className={NOWRAP}>{tr("tickets.col.model")}</th>
              <th className={NOWRAP}>{tr("tickets.col.started")}</th>
              <th className={NOWRAP}>{tr("tickets.col.cost")}</th>
              <th className={NOWRAP}>{tr("tickets.col.heldReason")}</th>
              <th className={NOWRAP}>PR</th>
              <th className={NOWRAP} aria-label={tr("tickets.col.actions")}></th>
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
              {tr("tickets.showMore", { size: PAGE_SIZE, remaining })}
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
  const { t: tr, lang } = useT();
  const title = ticketTitle(t, lang);
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
            title={tr("tickets.epicTitle", { name: t.epic.name })}
            className="mb-0.5 block max-w-48 truncate rounded-full border border-border bg-surface-raised px-2 text-meta text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => onEpic(t.epic!.ref)}
          >
            {t.epic.name}
          </button>
        )}
        {/* A real button so the keyboard can open the drawer too; the row click is the mouse shortcut. */}
        <button
          type="button"
          data-ticket-open
          title={t.summary ? `${t.title ?? t.displayId} — ${t.summary}` : t.title ?? undefined}
          onClick={(e) => {
            e.stopPropagation();
            onOpen({ profile: t.profile, ref: t.ref });
          }}
          className={`block min-w-40 max-w-md truncate text-left max-lg:max-w-64 max-lg:whitespace-normal max-lg:line-clamp-2 focus-visible:outline-2 focus-visible:outline-accent ${title.unknown ? "text-muted" : ""}`}
        >
          {title.text}
        </button>
      </td>
      <td className={`${NOWRAP} font-mono`}>{t.profile}</td>
      <td className={NOWRAP}>{t.step ?? "—"}</td>
      <td className={NOWRAP} title={STATUS_TITLE[t.status] && tr(STATUS_TITLE[t.status]!)}>
        <StatusBadge status={t.status} />
      </td>
      <td className={NOWRAP} title={model.title}>
        {model.text}
      </td>
      <td className={NOWRAP}>
        <Ago iso={t.startedAt} seed={now} />
      </td>
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
            aria-label={tr("overview.dismissAria", { id: t.displayId })}
            title={tr("tickets.dismissTitle")}
            className="rounded-md border border-border px-2 py-0.5 text-label hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => onDismiss({ profile: t.profile, ref: t.ref })}
          >
            {tr("overview.dismiss")}
          </button>
        )}
      </td>
    </tr>
  );
}
