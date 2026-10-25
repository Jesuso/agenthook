import type { EpicBucket, EpicDetail, EpicDetailTicket, EpicResponse, TicketRow } from "./contract";
import { BUCKET_LABEL, etaLabel, groupTickets, perDayLabel, progressOf, safeUrl, stageSegments } from "./epics";
import { EmptyState } from "./components";
import { formatRelative } from "./format";

type Ref = { profile: string; ref: string };

/** The page's sections above the folded history, in attention order. */
const OPEN_GROUPS = ["running", "backlog", "untracked"] as const;

const SECTION_TITLE: Record<EpicBucket, string> = {
  needsYou: "Needs you",
  running: "Running",
  backlog: "Backlog",
  finished: "Finished",
  merged: "Merged",
  untracked: "Not on the board",
};

// Full class strings so Tailwind's scanner sees them: status tokens only, no new colours.
const BAR_FILL: Record<EpicBucket, string> = {
  merged: "bg-status-done",
  finished: "bg-status-done",
  running: "bg-status-running epic-seg-running",
  needsYou: "bg-status-held",
  backlog: "bg-status-queued/70",
  untracked: "bg-border-strong",
};

/** Merged is hatched so it reads apart from finished without a second green. */
const HATCH = { backgroundImage: "repeating-linear-gradient(135deg, transparent 0 3px, rgb(0 0 0 / 0.35) 3px 5px)" };

/**
 * One epic (docs/web-ui.md § Epics view), in attention order: header, stage bar with counts and a
 * pace line, Needs you (reason, age, one action), Running, Backlog, tickets not on the board, then
 * finished and merged history folded. A ticket that ran here opens the drawer; one that didn't
 * opens on its tracker when its URL can be derived from the epic's.
 */
export function EpicPage({ body, profile, rows, onOpen }: { body: EpicResponse; profile: string; rows: TicketRow[]; onOpen: (t: Ref) => void }) {
  const epic = body.epic;
  if (!body.supported || !epic) return <EmptyState title="This tracker has no epics" />;
  const url = safeUrl(epic.url);
  const groups = groupTickets(epic.tickets);
  const rowBy = new Map(rows.filter((r) => r.profile === profile).map((r) => [r.ref, r]));
  const now = Date.now();
  const pace = paceOf(epic);
  const open = (t: EpicDetailTicket) => onOpen({ profile, ref: t.ref });
  const hrefOf = (t: EpicDetailTicket) => ticketUrl(url, epic.ref, t.ref);
  const history = [...groups.finished, ...groups.merged];

  return (
    <div className="flex flex-col gap-5" data-epic-page={epic.ref}>
      <header>
        <h2 className="text-[20px] leading-7 font-semibold text-balance">{epic.name}</h2>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted">
          {epic.displayId && <span className="font-mono">{epic.displayId}</span>}
          {epic.status && <span>Tracker status: {epic.status}</span>}
          {url && (
            <a className="text-accent hover:underline" href={url} target="_blank" rel="noopener noreferrer">
              Open on the tracker
              <Ext />
            </a>
          )}
        </p>
      </header>
      {!body.live && <LiveNote />}
      {epic.readyToClose && <ReadyToCloseBanner url={url} />}
      {epic.tickets.length > 0 && (
        <div className="flex flex-col gap-2">
          <StageBar epic={epic} />
          <p className={`text-body ${pace.stalled ? "text-status-held" : ""}`} data-pace>
            {pace.text}
            {pace.eta && <span className="text-muted"> {pace.eta}</span>}
          </p>
        </div>
      )}
      {groups.needsYou.length > 0 && (
        <Section group="needsYou" count={groups.needsYou.length} tone="text-status-held">
          {groups.needsYou.map((t) => (
            <NeedItem key={t.ref} t={t} row={rowBy.get(t.ref)} href={hrefOf(t)} onOpen={() => open(t)} now={now} />
          ))}
        </Section>
      )}
      {OPEN_GROUPS.map((b) =>
        groups[b].length > 0 ? (
          <Section key={b} group={b} count={groups[b].length}>
            {groups[b].map((t) => (
              <li key={t.ref} data-epic-ticket={t.ref}>
                <TicketLine t={t} row={rowBy.get(t.ref)} href={hrefOf(t)} onOpen={() => open(t)} showStage />
              </li>
            ))}
          </Section>
        ) : null,
      )}
      {history.length > 0 && (
        <details className="group rounded-lg border border-border bg-surface" data-group="history">
          <summary className="flex cursor-pointer list-none items-baseline gap-2 rounded-lg px-3 py-2 text-body font-semibold hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent">
            <Chevron />
            Finished and merged
            <span className="font-mono text-label font-normal text-muted">{history.length}</span>
          </summary>
          <ul className="border-t border-border-subtle p-1">
            {history.map((t) => (
              <li key={t.ref} data-epic-ticket={t.ref}>
                <TicketLine t={t} row={rowBy.get(t.ref)} href={hrefOf(t)} onOpen={() => open(t)}>
                  <span className="shrink-0 text-label text-status-done">{BUCKET_LABEL[t.bucket]}</span>
                </TicketLine>
              </li>
            ))}
          </ul>
        </details>
      )}
      {epic.tickets.length === 0 && (
        <p className="rounded-lg border border-border bg-surface px-3 py-3 text-muted">{epic.completed ? "Closed with no tickets." : "No tickets in this epic yet."}</p>
      )}
    </div>
  );
}

/** A ticket's tracker URL derived from its epic's (same tracker, the ref swapped at the end); null when the epic URL doesn't end in its ref. */
export function ticketUrl(epicUrl: string | null, epicRef: string, ref: string): string | null {
  if (!epicUrl) return null;
  const base = epicUrl.replace(/\/$/, "");
  return base.endsWith(epicRef) ? base.slice(0, base.length - epicRef.length) + encodeURIComponent(ref) : null;
}

/** Plain-language pace: what finished lately, a stall when nothing has for 5 days, and an ETA only with its basis. */
export function paceOf(epic: Pick<EpicDetail, "velocity" | "byStage" | "total" | "completed" | "eta">): { text: string; eta: string | null; stalled: boolean } {
  const days = epic.velocity.days;
  const { done, total } = progressOf(epic);
  const left = epic.byStage.backlog + epic.byStage.running + epic.byStage.needsYou;
  if (epic.completed) return { text: `Closed with ${done} of ${total} finished.`, eta: null, stalled: false };
  let last: string | null = null;
  for (const d of days) if (d.finished > 0) last = d.date;
  const today = days.length ? days[days.length - 1].date : null;
  const since = last && today ? Math.round((Date.parse(today) - Date.parse(last)) / 86_400_000) : null;
  const week = days.slice(-7).reduce((a, d) => a + d.finished, 0);
  const text =
    week > 0
      ? `${week} finished this week, the latest ${since === 0 ? "today" : `${since} d ago`}.`
      : since !== null
        ? `Nothing finished for ${since} days.`
        : `Nothing finished in the last ${days.length} days.`;
  const eta = left === 0 ? null : epic.eta && epic.velocity.perDay ? `${left} left at ${perDayLabel(epic.velocity.perDay)}: ${etaLabel(epic.eta)}.` : `${left} left, no estimate until something finishes.`;
  return { text, eta, stalled: left > 0 && (since === null || since >= 5) };
}

function Ext() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="ml-1 inline size-2.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4.5 2.5h5v5M9.5 2.5L3 9" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3 shrink-0 self-center transition-transform group-open:rotate-90 motion-reduce:transition-none" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4.5 2.5L8 6l-3.5 3.5" />
    </svg>
  );
}

/** The stage bar, named "N of M finished" for screen readers, with a labelled count per stage under it. */
function StageBar({ epic }: { epic: EpicDetail }) {
  const { done, total } = progressOf(epic);
  const segs = stageSegments(epic);
  return (
    <div className="min-w-0" data-stage-bar>
      <div role="img" aria-label={`${done} of ${total} finished: ${segs.map((s) => `${s.count} ${BUCKET_LABEL[s.bucket]}`).join(", ")}`} className="flex h-2 gap-px overflow-hidden rounded-full bg-surface-raised">
        {segs.map((s) => (
          <span key={s.bucket} data-seg={s.bucket} className={BAR_FILL[s.bucket]} style={{ width: `${s.pct}%`, ...(s.bucket === "merged" ? HATCH : {}) }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-label">
        {segs.map((s) => (
          <li key={s.bucket} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`size-2 rounded-sm ${BAR_FILL[s.bucket]}`} style={s.bucket === "merged" ? HATCH : undefined} />
            <span className="font-mono">{s.count}</span>
            <span className="text-muted">{BUCKET_LABEL[s.bucket]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({ group, count, tone = "", children }: { group: EpicBucket; count: number; tone?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface" data-group={group}>
      <h3 className={`flex items-baseline gap-2 border-b border-border-subtle px-3 py-2 text-body font-semibold ${tone}`}>
        {SECTION_TITLE[group]}
        <span className="font-mono text-label font-normal text-muted">{count}</span>
      </h3>
      <ul className="p-1">{children}</ul>
    </section>
  );
}

/** One ticket. It opens the drawer when it ran here, else the ticket on its tracker; a ticket with neither says why. */
function TicketLine({ t, row, href, onOpen, showStage, children }: { t: EpicDetailTicket; row: TicketRow | undefined; href: string | null; onOpen: () => void; showStage?: boolean; children?: React.ReactNode }) {
  const cls = "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-[5px] text-left";
  const body = (
    <>
      <span className="w-24 shrink-0 font-mono text-label text-muted">{t.displayId ?? t.ref}</span>
      <span className="min-w-0 flex-1 truncate" title={t.name}>
        {t.name}
      </span>
      {showStage && t.stage && <span className="shrink-0 text-meta text-muted">{t.stage}</span>}
      {children}
    </>
  );
  if (row)
    return (
      <button type="button" className={`${cls} hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent`} onClick={onOpen}>
        {body}
      </button>
    );
  if (href)
    return (
      <a className={`${cls} hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent`} href={href} target="_blank" rel="noopener noreferrer" title="Never ran here: opens on the tracker">
        {body}
        <Ext />
      </a>
    );
  return (
    <div className={cls} title="Never ran here and has no tracker link">
      {body}
    </div>
  );
}

/** Why a ticket needs the human, from its local row. */
function needOf(row: TicketRow | undefined): { kind: "held" | "failed" | "pr"; reason: string; since: string | null } | null {
  if (!row) return null;
  if (row.status === "held") return { kind: "held", reason: row.heldReason ?? "Held for a decision.", since: row.heldAt ?? row.startedAt };
  if (row.status === "failed") return { kind: "failed", reason: row.failReason ?? "The run failed.", since: row.startedAt };
  if (row.status === "done" && row.prState === "ready" && row.prUrl) return { kind: "pr", reason: "PR ready to merge.", since: row.finishedAt };
  return null;
}

/** A Needs-you ticket: the reason, step and age, and its one action. */
function NeedItem({ t, row, href, onOpen, now }: { t: EpicDetailTicket; row: TicketRow | undefined; href: string | null; onOpen: () => void; now: number }) {
  const n = needOf(row);
  const tone = n?.kind === "failed" ? "text-status-failed" : "text-status-held";
  const btn = "shrink-0 rounded-md border border-border px-2 py-0.5 text-label hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent";
  return (
    <li className="flex items-start gap-2 px-2 py-[5px]" data-epic-ticket={t.ref}>
      <span className="w-24 shrink-0 pt-0.5 font-mono text-label text-muted">{t.displayId ?? t.ref}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate" title={t.name}>
          {t.name}
        </p>
        <p className={`line-clamp-2 text-label ${tone}`}>{n ? n.reason : "Waiting on you."}</p>
      </div>
      {row && (
        <span className="hidden shrink-0 pt-0.5 font-mono text-label text-muted sm:inline">
          {row.step ?? ""}
          {n?.since ? ` · ${formatRelative(n.since, now)}` : ""}
        </span>
      )}
      {n?.kind === "pr" && row?.prUrl ? (
        <a className={btn} href={row.prUrl} target="_blank" rel="noopener noreferrer">
          Review PR
          <Ext />
        </a>
      ) : row ? (
        <button type="button" className={btn} onClick={onOpen}>
          Details
        </button>
      ) : href ? (
        <a className={btn} href={href} target="_blank" rel="noopener noreferrer">
          Open on the tracker
          <Ext />
        </a>
      ) : null}
    </li>
  );
}

/** All tickets finished, epic still open — closing it is a human call (ADR 0003–0006). */
function ReadyToCloseBanner({ url }: { url: string | null }) {
  return (
    <p className="rounded-md border border-border bg-status-done-bg px-3 py-2 text-label text-status-done" data-ready-to-close>
      All tickets finished — close this epic{" "}
      {url ? (
        <a className="underline" href={url} target="_blank" rel="noopener noreferrer">
          on the tracker
        </a>
      ) : (
        "on the tracker"
      )}
      ?
    </p>
  );
}

/** `live:false`: built from the profile dir alone. */
export function LiveNote() {
  return (
    <p className="text-label text-status-held" data-live-note>
      Known tickets only — receiver down, so the tracker wasn&apos;t read.
    </p>
  );
}
