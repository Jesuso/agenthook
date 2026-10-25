import { useEffect, useRef, useState } from "react";
import type { EpicDetail, EpicDetailTicket, EpicResponse, TicketRow } from "./contract";
import type { ReleaseOutcome } from "./config";
import { etaLabel, groupTickets, perDayLabel, progressOf, safeUrl } from "./epics";
import { EpicStageBar, StageKey, segCounts, segLabel } from "./EpicStageBar";
import type { Seg } from "./EpicStageBar";
import { ReleasePanel } from "./ReleasePanel";
import { EmptyState, StatusBadge } from "./components";
import { dismissKey } from "./deferredDismiss";
import { prNumber } from "./tickets";
import { useDisclosure } from "./disclosure";
import { formatRelative } from "./format";

type Ref = { profile: string; ref: string };

/** A section's title: the segment's one label (segLabel), sentence case. */
const titleOf = (s: Seg) => {
  const l = segLabel(s);
  return l[0].toUpperCase() + l.slice(1);
};

/** A finished ticket's PR when it is known and not merged or closed: the only evidence for "awaiting merge". */
const openPr = (row: TicketRow | undefined): string | null => (row?.prUrl && row.prState !== "merged" && row.prState !== "closed" ? safeUrl(row.prUrl) : null);

// Writes (Release…, Re-run) are accent-tinted buttons; reads (a PR, the tracker, the log) are links
// or quiet buttons, so what changes something looks different from what only shows it.
const WRITE = "inline-block shrink-0 rounded-md border border-accent/60 bg-accent/10 px-2 py-0.5 text-label font-medium text-accent hover:bg-accent/20 focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:px-3 pointer-coarse:py-2";
const READ = "inline-block shrink-0 rounded-sm px-1 py-0.5 text-label text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:px-3 pointer-coarse:py-2";
const QUIET = "inline-block shrink-0 rounded-md px-2 py-0.5 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:px-3 pointer-coarse:py-2";

export type EpicActions = {
  /** The receiver is up: a failed ticket can be re-run. */
  up: boolean;
  onRelease?: (t: Ref, comment: string) => Promise<ReleaseOutcome>;
  onRetry?: (t: Ref) => Promise<ReleaseOutcome>;
  /** Acknowledge a failed ticket (App toasts it with Undo, as on the Overview). */
  onDismiss?: (t: Ref) => void;
  /** Tickets dismissed but still in their Undo window: they leave Needs you at once (deferredDismiss). */
  dismissing?: ReadonlySet<string>;
};

/**
 * One epic (docs/web-ui.md § Epics view), in attention order: header, stage bar with its key and a
 * pace line, Needs you (reason, step and age, the action by kind), Running, Awaiting merge (finished
 * tickets whose PR is recorded and not merged, each with its PR link: only on that evidence), Backlog,
 * tickets not on the board, then the rest of finished and merged folded, remembered per tab. A ticket that ran here opens the drawer; one
 * that didn't opens on its tracker when its URL can be derived from the epic's, or says it can't.
 */
export function EpicPage({ body, profile, rows, onOpen, actions = { up: true } }: { body: EpicResponse; profile: string; rows: TicketRow[]; onOpen: (t: Ref) => void; actions?: EpicActions }) {
  const epic = body.epic;
  // Hooks before the early return: a refetch can flip `supported` on the same mounted page.
  const [historyOpen, setHistoryOpen] = useDisclosure(`${profile}:${epic?.ref ?? ""}:history`);
  if (!body.supported || !epic) return <EmptyState title="This tracker has no epics" />;
  const url = safeUrl(epic.url);
  const groups = groupTickets(epic.tickets);
  const rowBy = new Map(rows.filter((r) => r.profile === profile).map((r) => [r.ref, r]));
  const now = Date.now();
  const pace = paceOf(epic);
  const open = (t: EpicDetailTicket) => onOpen({ profile, ref: t.ref });
  const hrefOf = (t: EpicDetailTicket) => ticketUrl(url, epic.ref, t.ref);
  // Awaiting merge only on evidence (a recorded, unmerged PR); a finished ticket without one is just finished.
  const awaiting = groups.finished.filter((t) => openPr(rowBy.get(t.ref)));
  const finishedRest = groups.finished.filter((t) => !openPr(rowBy.get(t.ref)));
  const history = [...finishedRest, ...groups.merged];
  const historyTitle = finishedRest.length && groups.merged.length ? "Finished and merged" : groups.merged.length ? "Merged" : "Finished";
  const counts = segCounts(epic, awaiting.length);
  const needs = groups.needsYou.filter((t) => !actions.dismissing?.has(dismissKey({ profile, ref: t.ref })));

  return (
    <div className="flex flex-col gap-5" data-epic-page={epic.ref}>
      <div>
        <h2 className="text-heading font-semibold text-balance">{epic.name}</h2>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted">
          {epic.displayId && <span className="font-mono">{epic.displayId}</span>}
          {epic.status && <span>Tracker status: {epic.status}</span>}
          {url && (
            <a className="rounded-sm text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent" href={url} target="_blank" rel="noopener noreferrer">
              Open on the tracker
              <Ext />
            </a>
          )}
        </p>
      </div>
      {!body.live && <LiveNote />}
      {epic.readyToClose && <ReadyToCloseBanner url={url} />}
      {epic.tickets.length > 0 && (
        <div className="flex flex-col gap-2">
          <EpicStageBar epic={epic} wide awaiting={awaiting.length} />
          <StageKey counts={counts} />
          <p className={`text-body ${pace.stalled ? "font-medium" : ""}`} data-pace data-stalled={pace.stalled || undefined}>
            {pace.text}
            {pace.eta && <span className="font-normal text-muted"> {pace.eta}</span>}
          </p>
        </div>
      )}
      {needs.length > 0 && (
        <Section group="needsYou" count={needs.length} tone="text-status-held">
          {needs.map((t) => (
            <NeedItem key={t.ref} t={t} row={rowBy.get(t.ref)} href={hrefOf(t)} onOpen={() => open(t)} now={now} actions={actions} />
          ))}
        </Section>
      )}
      {groups.running.length > 0 && (
        <Section group="running" count={groups.running.length}>
          {groups.running.map((t) => {
            const row = rowBy.get(t.ref);
            // The running bucket also holds queued, interrupted and stalled tickets: name those.
            return (
              <li key={t.ref} data-epic-ticket={t.ref}>
                <TicketLine t={t} row={row} href={hrefOf(t)} onOpen={() => open(t)}>
                  {row && row.status !== "running" && <StatusBadge status={row.status} />}
                </TicketLine>
              </li>
            );
          })}
        </Section>
      )}
      {awaiting.length > 0 && (
        <Section group="awaiting" count={awaiting.length}>
          {awaiting.map((t) => (
            <AwaitingItem key={t.ref} t={t} row={rowBy.get(t.ref)} href={hrefOf(t)} onOpen={() => open(t)} />
          ))}
        </Section>
      )}
      {(["backlog", "untracked"] as const).map((b) =>
        groups[b].length > 0 ? (
          <Section key={b} group={b} count={groups[b].length}>
            {groups[b].map((t) => (
              <li key={t.ref} data-epic-ticket={t.ref}>
                <TicketLine t={t} row={rowBy.get(t.ref)} href={hrefOf(t)} onOpen={() => open(t)} />
              </li>
            ))}
          </Section>
        ) : null,
      )}
      {history.length > 0 && (
        <details className="group rounded-lg border border-border bg-surface" data-group="history" open={historyOpen} onToggle={(e) => setHistoryOpen(e.currentTarget.open)}>
          <summary className="flex cursor-pointer list-none items-baseline gap-2 rounded-lg px-3 py-2 text-body font-semibold hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent">
            <Chevron />
            {historyTitle}
            <Count n={history.length} />
          </summary>
          <ul className="border-t border-border-subtle p-1">
            {history.map((t) => (
              <li key={t.ref} data-epic-ticket={t.ref}>
                <TicketLine t={t} row={rowBy.get(t.ref)} href={hrefOf(t)} onOpen={() => open(t)}>
                  {finishedRest.length > 0 && groups.merged.length > 0 && <span className={`shrink-0 text-label ${t.bucket === "merged" ? "text-status-done" : "text-muted"}`}>{segLabel(t.bucket)}</span>}
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

/** Days the server needs work finished on before it estimates (src/epics.js `activeDays >= 3`). */
const ETA_ACTIVE_DAYS = 3;

/**
 * Plain-language pace: what finished lately (finished and merged alike), a stall when nothing has
 * for 5 days, and an ETA only with its basis; when there is none, the real reason why.
 */
export function paceOf(epic: Pick<EpicDetail, "velocity" | "byStage" | "total" | "completed" | "eta">): { text: string; eta: string | null; stalled: boolean; since: number | null } {
  const { days, finished14, activeDays, perDay } = epic.velocity;
  const { done, total } = progressOf(epic);
  // Same as the server's `remaining` (src/epics.js): untracked tickets are still left to do.
  const left = total - epic.byStage.finished - epic.byStage.merged;
  let last: string | null = null;
  for (const d of days) if (d.finished > 0) last = d.date;
  const today = days.length ? days[days.length - 1].date : null;
  const since = last && today ? Math.round((Date.parse(today) - Date.parse(last)) / 86_400_000) : null;
  if (epic.completed) return { text: `Closed with ${done} of ${total} finished.`, eta: null, stalled: false, since };
  const week = days.slice(-7).reduce((a, d) => a + d.finished, 0);
  const stalled = left > 0 && (since === null || since >= 5);
  const text =
    week > 0 && !stalled
      ? `${week} ${week === 1 ? "ticket" : "tickets"} finished this week, the latest ${since === 0 ? "today" : `${since} d ago`}.`
      : since !== null
        ? `${stalled ? "Stalled: n" : "N"}othing finished for ${since} days.`
        : `${stalled ? "Stalled: n" : "N"}othing finished in the last ${days.length} days.`;
  const eta =
    left === 0
      ? null
      : epic.eta && perDay
        ? `${left} left at ${perDayLabel(perDay)}: ${etaLabel(epic.eta)}.`
        : finished14 === 0
          ? `${left} left. No estimate until something finishes.`
          : `${left} left. No estimate yet: that needs work finished on ${ETA_ACTIVE_DAYS} different days (${activeDays} so far).`;
  return { text, eta, stalled, since };
}

/** The new-tab mark, said aloud as "(new tab)". */
function Ext() {
  return (
    <>
      <svg aria-hidden="true" viewBox="0 0 12 12" className="ml-1 inline size-2.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4.5 2.5h5v5M9.5 2.5L3 9" />
      </svg>
      <span className="sr-only"> (new tab)</span>
    </>
  );
}

export function Chevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3 shrink-0 self-center transition-transform group-open:rotate-90 motion-reduce:transition-none" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4.5 2.5L8 6l-3.5 3.5" />
    </svg>
  );
}

/** A heading's count: shown as a bare number, read aloud as "(3 tickets)". */
export function Count({ n, noun = "ticket" }: { n: number; noun?: string }) {
  return (
    <span className="font-mono text-label font-normal text-muted">
      <span className="sr-only"> (</span>
      {n}
      <span className="sr-only">{` ${noun}${n === 1 ? "" : "s"})`}</span>
    </span>
  );
}

function Section({ group, count, tone = "", children }: { group: Seg; count: number; tone?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface" data-group={group}>
      <h3 className={`flex items-baseline gap-2 border-b border-border-subtle px-3 py-2 text-body font-semibold ${tone}`}>
        {titleOf(group)}
        <Count n={count} />
      </h3>
      <ul className="p-1">{children}</ul>
    </section>
  );
}

/**
 * One ticket. It opens the drawer when it ran here, else the ticket on its tracker (marked, and
 * said aloud); a ticket with neither says so on the row. j/k walk the `data-epic-nav` targets.
 */
function TicketLine({ t, row, href, onOpen, children }: { t: EpicDetailTicket; row: TicketRow | undefined; href: string | null; onOpen: () => void; children?: React.ReactNode }) {
  const cls = "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-[5px] text-left";
  const body = (
    <>
      <span className="w-24 shrink-0 font-mono text-label text-muted">{t.displayId ?? t.ref}</span>
      <span className="min-w-0 flex-1 truncate" title={t.name}>
        {t.name}
      </span>
      {children}
    </>
  );
  if (row)
    return (
      <button type="button" data-epic-nav className={`${cls} hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent`} onClick={onOpen}>
        {body}
      </button>
    );
  if (href)
    return (
      <a data-epic-nav className={`${cls} hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent`} href={href} target="_blank" rel="noopener noreferrer" title="Never ran here: opens on the tracker">
        {body}
        <span className="shrink-0 text-meta text-muted">
          tracker
          <Ext />
        </span>
      </a>
    );
  return (
    <div className={cls}>
      {body}
      <span className="shrink-0 text-meta text-muted">never ran here, no link</span>
    </div>
  );
}

/**
 * A finished ticket whose recorded PR is not merged yet: the ticket line, then its PR as a separate
 * link (never nested in the row's button).
 */
function AwaitingItem({ t, row, href, onOpen }: { t: EpicDetailTicket; row: TicketRow | undefined; href: string | null; onOpen: () => void }) {
  const pr = openPr(row);
  const num = prNumber(pr);
  return (
    <li className="flex items-center gap-2 pr-2" data-epic-ticket={t.ref}>
      <div className="min-w-0 flex-1">
        <TicketLine t={t} row={row} href={href} onOpen={onOpen} />
      </div>
      {pr && (
        <a className={READ} href={pr} target="_blank" rel="noopener noreferrer" aria-label={`PR ${num ? `#${num} ` : ""}for ${t.displayId ?? t.ref} (new tab)`} data-epic-pr>
          PR{num ? ` #${num}` : ""}
          <Ext />
        </a>
      )}
    </li>
  );
}

/** Why a ticket needs the human, from its local row. */
function needOf(row: TicketRow | undefined): { kind: "held" | "failed" | "pr"; reason: string; since: string | null } | null {
  if (!row) return null;
  if (row.status === "held") return { kind: "held", reason: row.heldReason ?? "Held for a decision; the agent gave no reason.", since: row.heldAt ?? row.startedAt };
  if (row.status === "failed") return { kind: "failed", reason: row.failReason ?? "The run failed without a reason.", since: row.startedAt };
  if (row.status === "done" && row.prState === "ready" && row.prUrl) return { kind: "pr", reason: "PR ready to merge.", since: row.finishedAt };
  return null;
}

type Rerun = { state: "busy" | "started" } | { state: "error"; error: string };

/**
 * A Needs-you ticket: the reason, step and age, and its action named by kind, the same as on the
 * Overview: held → Release… (the answer box opens inline), failed → Re-run (Open log while the
 * receiver is down), a ready PR → Review PR. The name opens the drawer, as on the Overview.
 */
function NeedItem({ t, row, href, onOpen, now, actions }: { t: EpicDetailTicket; row: TicketRow | undefined; href: string | null; onOpen: () => void; now: number; actions: EpicActions }) {
  const [answering, setAnswering] = useState(false);
  // Closing the answer box (Cancel, Esc) hands focus back to Release…, which it replaced.
  const releaseBtn = useRef<HTMLButtonElement>(null);
  const wasAnswering = useRef(false);
  useEffect(() => {
    if (wasAnswering.current && !answering) releaseBtn.current?.focus();
    wasAnswering.current = answering;
  }, [answering]);
  const [rerun, setRerun] = useState<Rerun | null>(null);
  // Re-run starts a real agent run: the button asks once inline, naming the step, before it does.
  const [confirming, setConfirming] = useState(false);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  // Leaving the confirm (Cancel, Esc, confirm) hands focus back to Re-run…, which it replaced.
  const rerunBtn = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) confirmBtn.current?.focus();
    else if (wasConfirming.current) rerunBtn.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const n = needOf(row);
  const id = t.displayId ?? t.ref;
  const tone = n?.kind === "failed" ? "text-status-failed" : "text-status-held";
  const reason = n ? n.reason : row ? "Marked Needs you on the tracker." : "Needs you on the tracker; it never ran here.";
  const meta = [row?.step, n?.since ? formatRelative(n.since, now) : null].filter(Boolean).join(" · ");
  const retry = () => {
    if (!row || !actions.onRetry) return;
    setConfirming(false);
    setRerun({ state: "busy" });
    void actions.onRetry({ profile: row.profile, ref: row.ref }).then((out) => setRerun(out.ok ? { state: "started" } : { state: "error", error: out.error }));
  };
  let primary: React.ReactNode = null;
  const prHref = n?.kind === "pr" ? safeUrl(row?.prUrl ?? null) : null;
  if (prHref)
    primary = (
      <a className={READ} href={prHref} target="_blank" rel="noopener noreferrer">
        Review PR
        <Ext />
      </a>
    );
  else if (n?.kind === "held" && row && actions.onRelease)
    primary = !answering && (
      <button ref={releaseBtn} type="button" data-epic-release className={WRITE} aria-label={`Release ${id}…`} onClick={() => setAnswering(true)}>
        Release…
      </button>
    );
  else if (n?.kind === "failed" && row && actions.up && actions.onRetry)
    primary = confirming ? (
      <span
        className="flex items-center gap-1 text-label"
        data-epic-retry-confirm
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setConfirming(false);
          }
        }}
      >
        <span className="text-muted">Re-run {row.step ?? "the failed step"}?</span>
        <button ref={confirmBtn} type="button" data-epic-retry className={WRITE} onClick={retry}>
          Re-run
        </button>
        <button type="button" className={QUIET} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </span>
    ) : (
      <button
        type="button"
        ref={rerunBtn}
        data-epic-retry-open
        className={`${WRITE} aria-disabled:cursor-default aria-disabled:border-border aria-disabled:bg-transparent aria-disabled:text-muted`}
        aria-label={`Re-run ${id}${row.step ? ` (${row.step})` : ""}…`}
        // aria-disabled, not disabled: it keeps focus after a confirm instead of dropping it to the page.
        aria-disabled={rerun?.state === "busy" || rerun?.state === "started" || undefined}
        onClick={() => rerun?.state !== "busy" && rerun?.state !== "started" && setConfirming(true)}
      >
        {rerun?.state === "busy" ? "Re-running…" : rerun?.state === "started" ? "Started" : "Re-run…"}
      </button>
    );
  else if (row && !actions.up && n?.kind === "failed")
    primary = (
      <button type="button" data-epic-log className={QUIET} aria-label={`Open log for ${id}`} onClick={onOpen}>
        Open log
      </button>
    );
  else if (!row && href)
    primary = (
      <a data-epic-nav className={READ} href={href} target="_blank" rel="noopener noreferrer">
        Open on the tracker
        <Ext />
      </a>
    );
  return (
    <li data-epic-ticket={t.ref}>
      <div className="flex items-start gap-2 px-2 py-[5px]">
        <span className="w-24 shrink-0 pt-0.5 font-mono text-label text-muted">{id}</span>
        <div className="min-w-0 flex-1">
          {row ? (
            <button type="button" data-epic-nav className="block max-w-full truncate rounded-sm text-left hover:underline focus-visible:outline-2 focus-visible:outline-accent" title={`${t.name}: open details and log`} onClick={onOpen}>
              {t.name}
            </button>
          ) : (
            <p className="truncate" title={t.name}>
              {t.name}
            </p>
          )}
          <p className={`line-clamp-2 text-label ${tone}`}>{reason}</p>
          {meta && <p className="text-meta text-muted">{meta}</p>}
          {rerun?.state === "error" && (
            <p role="alert" className="text-label text-status-failed">
              {rerun.error}
            </p>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-1">
          {n?.kind === "failed" && row && actions.onDismiss && !confirming && (
            <button type="button" data-epic-dismiss className={QUIET} aria-label={`Dismiss ${id}`} title="acknowledge: it stops counting as needing you" onClick={() => actions.onDismiss!({ profile: row.profile, ref: row.ref })}>
              Dismiss
            </button>
          )}
          {primary}
        </span>
      </div>
      {answering && row && actions.onRelease && <ReleasePanel ticket={row} onRelease={actions.onRelease} onClose={() => setAnswering(false)} />}
    </li>
  );
}

/** All tickets finished, epic still open: closing it is the human's job, said as an instruction (ADR 0003–0006). */
function ReadyToCloseBanner({ url }: { url: string | null }) {
  return (
    <p className="rounded-md border border-border-strong bg-surface px-3 py-2 text-body" data-ready-to-close>
      <span className="font-medium">All tickets finished.</span>{" "}
      {url ? (
        <a className="rounded-sm text-accent underline focus-visible:outline-2 focus-visible:outline-accent" href={url} target="_blank" rel="noopener noreferrer">
          Close this epic on the tracker
          <Ext />
        </a>
      ) : (
        "Close this epic on the tracker."
      )}
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
