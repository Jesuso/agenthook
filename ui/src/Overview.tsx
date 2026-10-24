import { useState } from "react";
import type { ProfileView, Snapshot, TicketRow } from "./contract";
import type { FeedEntry } from "./feed";
import { formatCost, formatDuration, formatModel, formatQuota, formatRelative, formatSpend, formatTicketSpend, ticketTitle } from "./format";
import { scopeToProfile } from "./summary";
import { MIN_RUNS_FOR_RATES, needsYouItems, nowItems, progress } from "./zones";
import type { NeedsItem, Progress } from "./zones";
import { DigestPanel } from "./DigestPanel";
import { StatsStrip } from "./StatsStrip";
import { ActivityRail } from "./ActivityRail";
import { ProfileNameCell } from "./ProfileNameCell";
import { TicketsTable } from "./TicketsTable";
import { Menu, Pill, ProfileMark, ReceiverStatus, TicketId } from "./components";
import type { MenuItem } from "./components";
import { prNumber } from "./tickets";
import type { ReleaseOutcome } from "./config";

type Ref = { profile: string; ref: string };

export type OverviewProps = {
  profile: ProfileView;
  snapshot: Snapshot;
  now: number;
  /** This profile's live events only. */
  feed: FeedEntry[];
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  /** An epic ref, `""` = every epic. */
  epicFilter: string;
  setEpicFilter: (v: string) => void;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  open: Ref | null;
  onOpen: (t: Ref) => void;
  displayIdFor: (profile: string, ref: string) => string | null;
  menuItems: MenuItem[];
  note: string;
  onDismiss: (t: Ref) => void;
  /** Answer a held ticket (optional comment for the agent); resolves with what happened. */
  onRelease: (t: Ref, comment: string) => Promise<ReleaseOutcome>;
};

/**
 * One profile's dashboard (docs/web-ui.md § v4), in the order a glance needs it: Needs you leads
 * (its count is the page's headline; empty says "All clear"), then Now (running agents, slots,
 * queue), the digest, and Progress (today vs yesterday over the events tail). The full ticket table
 * and the live activity feed are collapsed drill-downs.
 */
export function Overview(props: OverviewProps) {
  const { profile, snapshot, now, feed, onOpen } = props;
  const scoped = scopeToProfile(snapshot, profile.name);
  const forge = !!profile.forge;
  const needs = needsYouItems(scoped.tickets, forge);
  const { running, queued } = nowItems(scoped.tickets);
  const prog = progress(profile, scoped.tickets, now);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      <div className="flex flex-col gap-2">
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

        {/* The machine's state, one quiet line: what the human came for is Needs you, below. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-label text-muted" data-summary>
          <ReceiverStatus p={profile} long />
          {/* Down: the banner below says it; dashes for slots and queue would only repeat it. */}
          {profile.up && (
            <>
              <span className="inline-flex items-center gap-2">
                <SlotPips active={profile.active ?? 0} max={profile.maxConcurrent ?? 0} up />
                agents
              </span>
              <span>
                <span className="font-mono text-fg">{profile.queued ?? 0}</span> queued
              </span>
            </>
          )}
          {profile.quota && (
            <span title="Claude subscription quota, as of the last Claude run" data-quota>
              Claude quota {formatQuota(profile.quota, now)}
            </span>
          )}
        </div>
      </div>

      {!profile.up && <StoppedBanner profile={profile} />}

      <NeedsYouZone items={needs} up={profile.up} now={now} onOpen={onOpen} onDismiss={props.onDismiss} onRelease={props.onRelease} />

      <NowZone profile={profile} running={running} queued={queued} now={now} onOpen={onOpen} />

      <DigestPanel profile={profile.name} up={profile.up} feed={feed} now={now} />

      <ProgressZone prog={prog} profile={profile.name} feed={feed} />

      <div className="flex flex-col gap-3">
        <details data-all-tickets className="rounded-lg border border-border bg-surface" open={props.statusFilter !== "" || props.epicFilter !== ""}>
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
              epicFilter={props.epicFilter}
              onEpicFilter={props.setEpicFilter}
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

/**
 * A stopped receiver, said once at the top: nothing runs, what happens to tickets meanwhile, and the
 * two commands that recover (start, then reconcile to fire tickets that moved while it was down).
 */
function StoppedBanner({ profile }: { profile: ProfileView }) {
  const cfg = profile.configPath ? ` --config ${profile.configPath}` : "";
  return (
    <div data-stopped-banner className="rounded-lg border border-status-held/40 bg-status-held-bg px-3 py-2 text-body">
      <p className="font-semibold text-status-held">The receiver is stopped, so no agents will run.</p>
      <p className="text-fg">
        Tickets moved on the board wait in their stage.{!profile.configMissing && " Start it, then pick up what moved meanwhile:"}
      </p>
      {!profile.configMissing && (
        <pre className="mt-1 font-mono text-label whitespace-pre-wrap break-all text-fg">
          {`agenthook start${cfg}\nagenthook reconcile${cfg}`}
        </pre>
      )}
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
/** A primary, always-visible row action (Release…, PR ↗). */
const ACTION = "inline-block rounded-md border border-border px-2 py-0.5 text-label font-medium hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent";
const LINK = "rounded px-1.5 py-0.5 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent";

/** The inline answer form under a held row: an optional comment for the agent, then Release. */
function ReleasePanel({ item, onRelease, onClose }: { item: NeedsItem; onRelease: OverviewProps["onRelease"]; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = item.ticket;
  const submit = async () => {
    setBusy(true);
    setError(null);
    const out = await onRelease({ profile: t.profile, ref: t.ref }, text);
    if (out.ok) return onClose();
    setBusy(false);
    setError(out.error);
  };
  return (
    <div data-release-panel={t.ref} className="flex flex-col gap-2 border-t border-border-subtle bg-surface-raised px-3 py-3">
      <label className="flex flex-col gap-1 text-label text-muted">
        Answer for the agent (optional) — added to its prompt when it re-runs {t.step ?? "the step"}
        <textarea
          autoFocus
          rows={3}
          maxLength={8000}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) void submit();
          }}
          className="rounded border border-border bg-surface px-2 py-1 text-body text-fg focus-visible:outline-2 focus-visible:outline-accent"
        />
      </label>
      {error && (
        <p role="alert" className="text-label text-status-failed">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={() => void submit()} className="rounded-md bg-accent px-3 py-1 text-label font-medium text-accent-fg disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent">
          {busy ? "Releasing…" : "Release"}
        </button>
        <button type="button" disabled={busy} onClick={onClose} className={LINK}>
          Cancel
        </button>
        <span className="ml-auto text-meta text-faint">⌘/Ctrl + Enter to release</span>
      </div>
    </div>
  );
}

/** The headline count takes the tone of the worst thing waiting: failed, then held. */
const headlineTone = (items: NeedsItem[]) =>
  items.some((i) => i.kind === "failed") ? "text-status-failed" : items.some((i) => i.kind === "held") ? "text-status-held" : "text-fg";

function NeedsYouZone({ items, up, now, onOpen, onDismiss, onRelease }: { items: NeedsItem[]; up: boolean; now: number; onOpen: (t: Ref) => void; onDismiss: (t: Ref) => void; onRelease: OverviewProps["onRelease"] }) {
  const [releasing, setReleasing] = useState<string | null>(null);
  if (items.length === 0) {
    return (
      <section data-all-clear>
        <h2 className="text-title font-semibold">{up ? "All clear" : "Nothing needs you"}</h2>
        <p className="text-label text-muted">Held questions, failed runs and PRs ready to merge show up here.</p>
      </section>
    );
  }
  return (
    <section>
      <h2 className="mb-3 flex items-baseline gap-2">
        <span className={`font-mono text-stat font-semibold ${headlineTone(items)}`}>{items.length}</span>
        <span className="text-title font-semibold">{items.length === 1 ? "needs you" : "need you"}</span>
      </h2>
      <ul data-needs-you-zone className="divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
        {items.map((item) => {
          const { ticket: t, kind, reason, since } = item;
          const title = ticketTitle(t);
          const pr = prNumber(t.prUrl);
          return (
            <li key={t.ref} data-needs-row={t.ref} data-kind={kind}>
              <div className="group flex items-center gap-3 px-3 py-2">
                <span className="w-[4.5rem] shrink-0"><Pill tone={KIND[kind].tone}>{KIND[kind].text}</Pill></span>
                <TicketId id={t.displayId} url={t.trackerUrl} />
                <button type="button" className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-accent" title={t.summary ? `${t.summary} — open details` : "open details"} onClick={() => onOpen({ profile: t.profile, ref: t.ref })}>
                  <span className={title.unknown ? "text-muted" : ""}>{title.unknown ? "(untitled)" : title.text}</span>
                  {(reason || t.summary) && <span className="block truncate text-label text-muted" data-needs-sub title={reason ?? t.summary ?? undefined}>{reason ?? t.summary}</span>}
                </button>
                <span className="w-32 shrink-0 whitespace-nowrap text-right text-label text-muted">
                  {t.step ? `${t.step} · ` : ""}
                  {formatRelative(since, now)}
                </span>
                {/* One primary action per row: always visible, fixed width, so the columns line up. A PR
                    link on a held/failed row lives in the drawer header; the title opens the drawer. */}
                <span className="w-28 shrink-0 text-right" data-needs-primary>
                  {kind === "held" ? (
                    releasing !== t.ref && (
                      <button type="button" data-release-open className={ACTION} onClick={() => setReleasing(t.ref)}>
                        Release…
                      </button>
                    )
                  ) : kind === "failed" ? (
                    <button type="button" className={ACTION} title="acknowledge: it stops counting as needing you" onClick={() => onDismiss({ profile: t.profile, ref: t.ref })}>
                      Dismiss
                    </button>
                  ) : t.prUrl ? (
                    <a className={ACTION} href={t.prUrl} target="_blank" rel="noreferrer">
                      PR {pr ? `#${pr}` : ""} ↗
                    </a>
                  ) : null}
                </span>
              </div>
              {kind === "held" && releasing === t.ref && <ReleasePanel item={item} onRelease={onRelease} onClose={() => setReleasing(null)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function NowRow({ t, now, onOpen, queuedAt }: { t: TicketRow; now: number; onOpen: (r: Ref) => void; queuedAt?: number }) {
  const title = ticketTitle(t);
  const model = formatModel(t.model);
  const elapsed = t.startedAt ? formatDuration(now - Date.parse(t.startedAt)) : "—";
  return (
    <li data-now-row={t.ref} className="group flex items-center gap-3 px-3 py-2">
      {queuedAt !== undefined ? <span className="w-5 font-mono text-label text-muted">{queuedAt}</span> : <span aria-hidden="true" className="size-2 animate-status-pulse rounded-full bg-status-running" />}
      <TicketId id={t.displayId} url={t.trackerUrl} />
      <button type="button" className="min-w-0 flex-1 truncate text-left focus-visible:outline-2 focus-visible:outline-accent" title={title.unknown ? "open details" : `${title.text}${t.summary ? ` — ${t.summary}` : ""} — open details`} onClick={() => onOpen({ profile: t.profile, ref: t.ref })}>
        <span className={title.unknown ? "text-muted" : ""}>{title.unknown ? "(untitled)" : title.text}</span>
        {t.summary && <span className="block truncate text-label text-muted" data-now-sub>{t.summary}</span>}
      </button>
      {t.step && <Pill>{t.step}</Pill>}
      {queuedAt === undefined && (
        <>
          <span className="font-mono text-label text-muted" title={model.title}>{model.text}</span>
          <span className="font-mono text-label" title="elapsed">{elapsed}</span>
          <span className="font-mono text-label text-muted" title="cost so far (approx.)">{formatTicketSpend(t)}</span>
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
        {!profile.up && running.length === 0 && <p className="px-3 py-2 text-label text-muted">Nothing is running.</p>}
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

function ProgressZone({ prog, profile, feed }: { prog: Progress; profile: string; feed: FeedEntry[] }) {
  const rate = prog.reworkRate;
  return (
    <Zone title="Progress">
      <dl data-progress className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile label="finished today">
          <span className="font-mono">{prog.finishedToday}</span> <span className="text-label font-normal text-muted">{delta(prog.finishedToday, prog.finishedYesterday)}</span>
        </Tile>
        <Tile label="cost today (approx.)">
          <span className="font-mono">{formatSpend({ reported: prog.costToday, est: prog.estToday }) || formatCost(0)}</span>{" "}
          <span className="text-label font-normal text-muted">{prog.costYesterday || prog.estYesterday ? `yesterday ${formatSpend({ reported: prog.costYesterday, est: prog.estYesterday })}` : ""}</span>
        </Tile>
        <Tile label="rework rate" title="share of agent runs that ended in a rework loop (changes), over the last ~48 h of events">
          {rate === null ? (
            <span className="text-label font-normal text-muted">needs {MIN_RUNS_FOR_RATES}+ runs ({prog.runs} so far)</span>
          ) : (
            <span className="font-mono">{Math.round(rate * 100)}%</span>
          )}
        </Tile>
      </dl>
      <p className="mt-1 text-meta text-faint">Today, yesterday and the rework rate come from the last ~48 h of events.</p>
      <StatsStrip profile={profile} feed={feed} />
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

