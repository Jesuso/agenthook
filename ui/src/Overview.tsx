import { useState } from "react";
import type { ProfileView, Snapshot, TicketRow } from "./contract";
import type { FeedEntry } from "./feed";
import { formatCost, formatDuration, formatModel, formatRelative, ticketTitle } from "./format";
import { scopeToProfile } from "./summary";
import { MIN_RUNS_FOR_RATES, needsYouItems, nowItems, progress } from "./zones";
import type { NeedsItem, Progress } from "./zones";
import { ActivityRail } from "./ActivityRail";
import { ProfileNameCell } from "./ProfileNameCell";
import { TicketsTable } from "./TicketsTable";
import { Menu, Pill, ProfileMark } from "./components";
import type { MenuItem } from "./components";
import { prNumber } from "./tickets";

type Ref = { profile: string; ref: string };

export type OverviewProps = {
  profile: ProfileView;
  snapshot: Snapshot;
  now: number;
  /** This profile's live events only. */
  feed: FeedEntry[];
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  open: Ref | null;
  onOpen: (t: Ref) => void;
  displayIdFor: (profile: string, ref: string) => string | null;
  menuItems: MenuItem[];
  note: string;
  onDismiss: (t: Ref) => void;
};

/**
 * One profile's dashboard, three zones (docs/web-ui.md § v4): Needs you (hidden when empty, so
 * empty means calm), Now (running agents, slots, queue) and Progress (today vs yesterday over the
 * events tail). The full ticket table and the live activity feed are collapsed drill-downs.
 */
export function Overview(props: OverviewProps) {
  const { profile, snapshot, now, feed, onOpen } = props;
  const scoped = scopeToProfile(snapshot, profile.name);
  const forge = !!profile.forge;
  const needs = needsYouItems(scoped.tickets, forge);
  const { running, queued } = nowItems(scoped.tickets);
  const prog = progress(profile, scoped.tickets, now);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <ProfileMark p={profile} />
        <h1 className="text-title font-semibold">
          <ProfileNameCell p={profile} />
        </h1>
        <div className="ml-auto flex items-center gap-2">
          {props.note && <span className="text-label text-status-held">{props.note}</span>}
          <Menu label="profile actions" items={props.menuItems} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2" data-summary>
        <Tile label="agents">
          <SlotPips active={profile.up ? profile.active ?? 0 : 0} max={profile.maxConcurrent ?? 0} up={profile.up} />
        </Tile>
        <Tile label="queued">
          <span className="font-mono">{profile.up ? profile.queued ?? 0 : "—"}</span>
        </Tile>
      </div>

      {needs.length > 0 && <NeedsYouZone items={needs} now={now} onOpen={onOpen} onDismiss={props.onDismiss} />}

      <NowZone profile={profile} running={running} queued={queued} now={now} onOpen={onOpen} />

      <ProgressZone prog={prog} />

      <details data-all-tickets className="rounded-lg border border-border bg-surface" open={props.statusFilter !== ""}>
        <summary className="cursor-pointer select-none px-3 py-2 text-label font-semibold uppercase tracking-wide text-muted">
          All tickets <span className="font-mono normal-case">{scoped.tickets.length}</span>
        </summary>
        <div className="p-3">
          <TicketsTable
            tickets={scoped.tickets}
            profiles={scoped.profiles}
            now={now}
            profileFilter={profile.name}
            onProfileFilter={() => {}}
            lockProfile
            statusFilter={props.statusFilter}
            onStatusFilter={props.setStatusFilter}
            showAll={props.showAll}
            onShowAll={props.setShowAll}
            open={props.open}
            onOpen={onOpen}
            onDismiss={props.onDismiss}
          />
        </div>
      </details>

      <ActivityPanel feed={feed} displayIdFor={props.displayIdFor} onOpen={onOpen} />
    </div>
  );
}

function Tile({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div title={title} className="min-w-32 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="text-label uppercase tracking-wide text-muted">{label}</div>
      <div className="text-title font-semibold">{children}</div>
    </div>
  );
}

/** One pip per slot: filled while an agent runs in it, dashed while free; "—" when the receiver is down. */
function SlotPips({ active, max, up }: { active: number; max: number; up: boolean }) {
  if (!up || max <= 0) return <span className="font-mono text-muted">—</span>;
  return (
    <span className="inline-flex items-center gap-2" title={`${active} of ${max} slots in use`}>
      <span className="inline-flex gap-1" aria-hidden="true">
        {Array.from({ length: max }, (_, i) => (
          <span key={i} data-slot={i < active ? "busy" : "free"} className={`size-2.5 rounded-full ${i < active ? "bg-status-running" : "border border-dashed border-border-strong"}`} />
        ))}
      </span>
      <span className="font-mono">
        {active} <span className="text-muted">/ {max}</span>
      </span>
    </span>
  );
}

function Zone({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-label font-semibold uppercase tracking-wide text-muted">
        {title}
        {count !== undefined && <span className="ml-1.5 font-mono normal-case">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

const KIND: Record<NeedsItem["kind"], { text: string; tone: "failed" | "held" | "done" }> = {
  failed: { text: "failed", tone: "failed" },
  held: { text: "held", tone: "held" },
  pr: { text: "PR ready", tone: "done" },
};

/** Hover (or keyboard focus) reveals a row's actions; touch screens always show them. */
const REVEAL = "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100";
const LINK = "rounded px-1.5 py-0.5 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent";

function NeedsYouZone({ items, now, onOpen, onDismiss }: { items: NeedsItem[]; now: number; onOpen: (t: Ref) => void; onDismiss: (t: Ref) => void }) {
  return (
    <Zone title="Needs you" count={items.length}>
      <ul data-needs-you-zone className="divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
        {items.map(({ ticket: t, kind, reason, since }) => {
          const title = ticketTitle(t);
          const pr = prNumber(t.prUrl);
          return (
            <li key={t.ref} data-needs-row={t.ref} data-kind={kind} className="group flex items-center gap-3 px-3 py-2">
              <Pill tone={KIND[kind].tone}>{KIND[kind].text}</Pill>
              <button type="button" className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-accent" onClick={() => onOpen({ profile: t.profile, ref: t.ref })}>
                <span className="font-mono text-label text-muted">{t.displayId}</span> <span className={title.unknown ? "text-muted" : ""}>{title.unknown ? "(untitled)" : title.text}</span>
                {reason && <span className="block truncate text-label text-muted" title={reason}>{reason}</span>}
              </button>
              <span className="whitespace-nowrap text-label text-muted">
                {t.step ? `${t.step} · ` : ""}
                {formatRelative(since, now)}
              </span>
              <span className={`flex items-center gap-0.5 ${REVEAL}`}>
                {t.trackerUrl && (
                  <a className={LINK} href={t.trackerUrl} target="_blank" rel="noreferrer">
                    Ticket ↗
                  </a>
                )}
                {t.prUrl && (
                  <a className={LINK} href={t.prUrl} target="_blank" rel="noreferrer">
                    PR {pr ? `#${pr}` : ""} ↗
                  </a>
                )}
                <button type="button" className={LINK} onClick={() => onOpen({ profile: t.profile, ref: t.ref })}>
                  Details
                </button>
                {kind === "failed" && (
                  <button type="button" className={LINK} title="acknowledge: it stops counting as needing you" onClick={() => onDismiss({ profile: t.profile, ref: t.ref })}>
                    Dismiss
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </Zone>
  );
}

function NowRow({ t, now, onOpen, queuedAt }: { t: TicketRow; now: number; onOpen: (r: Ref) => void; queuedAt?: number }) {
  const title = ticketTitle(t);
  const model = formatModel(t.model);
  const elapsed = t.startedAt ? formatDuration(now - Date.parse(t.startedAt)) : "—";
  return (
    <li data-now-row={t.ref} className="group flex items-center gap-3 px-3 py-2">
      {queuedAt !== undefined ? <span className="w-5 font-mono text-label text-muted">{queuedAt}</span> : <span aria-hidden="true" className="size-2 animate-status-pulse rounded-full bg-status-running" />}
      <button type="button" className="min-w-0 flex-1 truncate text-left focus-visible:outline-2 focus-visible:outline-accent" onClick={() => onOpen({ profile: t.profile, ref: t.ref })}>
        <span className="font-mono text-label text-muted">{t.displayId}</span> <span className={title.unknown ? "text-muted" : ""}>{title.unknown ? "(untitled)" : title.text}</span>
      </button>
      {t.step && <Pill>{t.step}</Pill>}
      {queuedAt === undefined && (
        <>
          <span className="font-mono text-label text-muted" title={model.title}>{model.text}</span>
          <span className="font-mono text-label" title="elapsed">{elapsed}</span>
          <span className="font-mono text-label text-muted" title="cost so far (approx.)">{formatCost(t.costUsd)}</span>
          <button type="button" className={`${LINK} ${REVEAL}`} onClick={() => onOpen({ profile: t.profile, ref: t.ref })}>
            Follow log
          </button>
        </>
      )}
    </li>
  );
}

function NowZone({ profile, running, queued, now, onOpen }: { profile: ProfileView; running: TicketRow[]; queued: TicketRow[]; now: number; onOpen: (t: Ref) => void }) {
  const max = profile.maxConcurrent ?? 0;
  const free = profile.up ? Math.max(0, max - running.length) : 0;
  return (
    <Zone title="Now" count={running.length}>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {running.length > 0 && <ul className="divide-y divide-border-subtle">{running.map((t) => <NowRow key={t.ref} t={t} now={now} onOpen={onOpen} />)}</ul>}
        {free > 0 && (
          <ul aria-label="free slots" className={running.length ? "border-t border-border-subtle" : ""}>
            {Array.from({ length: free }, (_, i) => (
              <li key={i} data-free-slot className="flex items-center gap-3 px-3 py-2 text-label text-muted">
                <span aria-hidden="true" className="size-2 rounded-full border border-dashed border-border-strong" />
                free slot
              </li>
            ))}
          </ul>
        )}
        {!profile.up && running.length === 0 && <p className="px-3 py-2 text-label text-muted">receiver is down — nothing is running</p>}
        {queued.length > 0 && (
          <div className="border-t border-border-subtle">
            <div className="px-3 pt-2 text-label uppercase tracking-wide text-muted">queued {queued.length}</div>
            <ul className="divide-y divide-border-subtle">{queued.map((t, i) => <NowRow key={t.ref} t={t} now={now} onOpen={onOpen} queuedAt={i + 1} />)}</ul>
          </div>
        )}
      </div>
    </Zone>
  );
}

const delta = (today: number, yesterday: number) => (yesterday === 0 && today === 0 ? "" : `yesterday ${yesterday}`);

function ProgressZone({ prog }: { prog: Progress }) {
  const rate = prog.reworkRate;
  return (
    <Zone title="Progress">
      <dl data-progress className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile label="finished today">
          <span className="font-mono">{prog.finishedToday}</span> <span className="text-label font-normal text-muted">{delta(prog.finishedToday, prog.finishedYesterday)}</span>
        </Tile>
        <Tile label="cost today (approx.)">
          <span className="font-mono">{formatCost(prog.costToday)}</span> <span className="text-label font-normal text-muted">{prog.costYesterday ? `yesterday ${formatCost(prog.costYesterday)}` : ""}</span>
        </Tile>
        <Tile label="rework rate" title="share of agent runs that ended in a rework loop (changes), over the last ~48 h of events">
          {rate === null ? (
            <span className="text-label font-normal text-muted">needs {MIN_RUNS_FOR_RATES}+ runs ({prog.runs} so far)</span>
          ) : (
            <span className="font-mono">{Math.round(rate * 100)}%</span>
          )}
        </Tile>
      </dl>
      <p className="mt-1 text-meta text-faint">From the last ~48 h of events (the receiver&apos;s log tail), so older history isn&apos;t counted.</p>
    </Zone>
  );
}

/** The live feed as a collapsed bottom panel: the count beside it is what arrived since it was last open. */
function ActivityPanel({ feed, displayIdFor, onOpen }: { feed: FeedEntry[]; displayIdFor: OverviewProps["displayIdFor"]; onOpen: (t: Ref) => void }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(0);
  const toggle = () => {
    setSeen(feed.length);
    setOpen(!open);
  };
  return <ActivityRail feed={feed} displayIdFor={displayIdFor} open={open} onToggle={toggle} onOpen={onOpen} variant="panel" unread={open ? 0 : Math.max(0, feed.length - seen)} />;
}

