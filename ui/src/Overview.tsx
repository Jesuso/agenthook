import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ProfileView, Snapshot, StatsGroup, StatsResult } from "./contract";
import type { FeedEntry } from "./feed";
import { formatCost, formatSpend } from "./format";
import { harnessStatsUrl } from "./stats";
import { scopeToProfile } from "./summary";
import { MIN_RUNS_FOR_RATES, harnessAttention, needsYouItems, progress } from "./zones";
import type { NeedsItem, Progress } from "./zones";
import { NeedsYouZone, needsSpeech } from "./NeedsYouZone";
import type { Ref } from "./NeedsYouZone";
import { BoardHead, BoardRows, usePipelineSteps } from "./Departures";
import { board as boardOf } from "./board";
import { DigestPanel } from "./DigestPanel";
import { StatsStrip } from "./StatsStrip";
import { ActivityRail } from "./ActivityRail";
import { ProfileNameCell } from "./ProfileNameCell";
import { TicketsTable } from "./TicketsTable";
import { CopyCommand, Menu, ProfileMark, ReceiverStatus, ShortcutSheet, ShortcutsButton, ShowHide } from "./components";
import type { MenuItem } from "./components";
import type { ReleaseOutcome } from "./config";
import { dismissKey } from "./deferredDismiss";
import { OVERVIEW_SHORTCUTS, overviewAction, shortcutsEnabled } from "./shortcuts";
import { newEntries, speak, speechSupported, speechText } from "./speech";
import { useReading } from "./useReading";
import { useT } from "./i18n/react";
import { Modal } from "./Modal";
import { MarkdownEditor } from "./MarkdownEditor";
import { ticketAddOutcome, ticketAddRequest } from "./ticketAdd";
import type { TicketCreated } from "./ticketAdd";

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
  /** A pipeline step id, `""` = every step (set from the Board's "+N more", cleared like the other filters). */
  stepFilter: string;
  setStepFilter: (v: string) => void;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  open: Ref | null;
  onOpen: (t: Ref) => void;
  /** A local-board ticket was just created through the receiver: open its drawer (it fills in when its row arrives). */
  onCreated?: (t: Ref) => void;
  displayIdFor: (profile: string, ref: string) => string | null;
  menuItems: MenuItem[];
  note: string;
  onDismiss: (t: Ref) => void;
  /** Dismissed but still undoable (`dismissKey`): hidden from Needs you until sent or undone. */
  dismissing?: ReadonlySet<string>;
  /** Answer a held ticket (optional comment for the agent); resolves with what happened. */
  onRelease: (t: Ref, comment: string) => Promise<ReleaseOutcome>;
  /** Re-run a failed ticket's failed step (receiver up only); resolves with what happened. */
  onRetry: (t: Ref) => Promise<ReleaseOutcome>;
  /** Re-check a PR row with the tracker and forge (receiver up only); `ref` null = every flagged row of `profile`. */
  onRecheck?: (profile: string, ref: string | null) => Promise<ReleaseOutcome>;
  /** Close a shipped PR row's ticket on the tracker (receiver up only). */
  onCloseOnBoard?: (t: Ref) => Promise<ReleaseOutcome>;
};

/**
 * One profile's dashboard (docs/web-ui.md § v4), using the whole window. The board leads: the
 * Needs-you count is the page's headline (empty says "All clear"), and under it one row per ticket
 * — the ones that need you first, then what runs and what waits — each marked on the pipeline step
 * it is in. Beside the board on a wide screen (below it otherwise): the digest, Progress (today vs
 * yesterday over the events tail) and the live activity. The full ticket table is a collapsed
 * drill-down under the board.
 */
export function Overview(props: OverviewProps) {
  const { profile, snapshot, now, feed, onOpen } = props;
  const { t, lang } = useT();
  const scoped = scopeToProfile(snapshot, profile.name);
  const forge = !!profile.forge;
  const needs = needsYouItems(scoped.tickets, forge, lang).filter((n) => !props.dismissing?.has(dismissKey(n.ticket)));
  const attention = harnessAttention(profile);
  const needsCount = attention.length + needs.length;
  const prog = progress(profile, scoped.tickets, now);
  const [help, setHelp] = useState(false);
  const [ticketsOpen, setTicketsOpen] = useState(false);
  const pipeline = usePipelineSteps(profile.name, lang);
  // Until the steps are known (or when they can't be read) the rows still list, each naming its step.
  const board = boardOf(scoped.tickets, pipeline.kind === "ok" ? pipeline.ids : [], pipeline.kind === "ok" ? pipeline.manual : [], now, forge);
  const free = profile.up ? Math.max(0, (profile.maxConcurrent ?? 0) - board.runningCount) : 0;
  const [newTicket, setNewTicket] = useState(false);
  const [blockedNotice, setBlockedNotice] = useState<{ ref: string; by: string[] } | null>(null);
  const newTicketBtn = useRef<HTMLButtonElement>(null);
  const filtered = props.statusFilter !== "" || props.epicFilter !== "" || props.stepFilter !== "";
  const ticketsShown = ticketsOpen || filtered;
  // Hiding a filtered table drops the filter too: a filter is what holds it open.
  const hideOrShowTickets = () => {
    if (filtered) {
      props.setStatusFilter("");
      props.setEpicFilter("");
      props.setStepFilter("");
    }
    setTicketsOpen(!ticketsShown);
  };
  const openStatusInTable = (status: string) => {
    props.setStatusFilter(status);
    setTicketsOpen(true);
  };
  const openStepInTable = (step: string) => {
    props.setStepFilter(step);
    setTicketsOpen(true);
  };
  // A notice from a prior profile's New-ticket flow must not survive a profile switch
  // (<Overview> isn't keyed by profile — see App.tsx — so its own state otherwise would).
  useEffect(() => setBlockedNotice(null), [profile.name]);
  useNeedsYouKeys(setHelp, newTicketBtn);
  useAutoRead(profile.name, needs);
  // A background tab or a side screen still shows whether anything needs you.
  useEffect(() => {
    document.title = `${needsCount ? `(${needsCount}) ` : ""}${profile.label} · agenthook`;
    return () => {
      document.title = "agenthook";
    };
  }, [needsCount, profile.label]);

  return (
    <div className="flex flex-col gap-6 sm:px-2 2xl:px-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <ProfileMark p={profile} />
          {/* The config path sits beside the heading, not in it: a screen reader names the page by
              the profile alone, not "cahui-svc-test/tmp/ah-svc-test/…". */}
          <div className="min-w-0">
            <h1 className="text-title font-semibold">
              <ProfileNameCell p={profile} path={false} />
            </h1>
            {profile.configPath && (
              <p className="max-w-[40ch] truncate font-mono text-label text-muted max-lg:max-w-[24ch]" title={profile.configPath}>
                {profile.configPath}
              </p>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {props.note && <span className="text-label text-status-held">{props.note}</span>}
            {profile.tracker === "local" && (
              <span className="flex items-center gap-2">
                <button
                  ref={newTicketBtn}
                  type="button"
                  data-new-ticket-open
                  disabled={!profile.up}
                  title={profile.up ? t("shortcuts.overview.new") : t("overview.newTicketDisabled")}
                  onClick={() => setNewTicket(true)}
                  className="rounded-md border border-border px-2 py-1 text-label font-medium hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("overview.newTicket")}
                </button>
                {!profile.up && <span data-new-ticket-disabled-reason className="text-label text-muted">{t("overview.newTicketDisabled")}</span>}
              </span>
            )}
            <ShortcutsButton onClick={() => setHelp(true)} />
            <Menu label={t("overview.profileActions")} items={props.menuItems} />
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
                {t("common.agents")}
              </span>
              {(profile.harnesses || profile.unharnessed) && (
                <HarnessChips harnesses={profile.harnesses ?? {}} unharnessed={profile.unharnessed ?? {}} />
              )}
              <span>
                <span className="font-mono text-fg">{profile.queued ?? 0}</span> {t("common.queued")}
              </span>
            </>
          )}
          {/* The Claude quota lives in the app bar, once; repeating it here was the critique's noise. */}
        </div>
      </div>

      {!profile.up && <StoppedBanner profile={profile} />}

      {blockedNotice && (
        <p data-blocked-notice className="text-label text-status-held">
          {t("ticket.createdBlocked", { ref: `#${blockedNotice.ref}`, by: blockedNotice.by.map((b) => `#${b}`).join(", ") })}
        </p>
      )}

      {/* Screen readers hear the headline change (a ticket arrives or is handled), not every re-render. */}
      <p className="sr-only" aria-live="polite" data-needs-live>
        {needsCount === 0 ? t("overview.liveAllClear") : t("overview.liveNeeds", { count: needsCount })}
      </p>

      {/* Wide: the board and its drill-downs on the left, a rail of reading on the right. Narrower,
          the rail's zones sit side by side under the board, as many as fit. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 2xl:grid-cols-[minmax(0,1fr)_clamp(22rem,20vw,30rem)] 2xl:grid-rows-[auto_1fr]">
        <div data-overview-board className="flex min-w-0 flex-col gap-2">
          <NeedsYouZone
            items={needs}
            attention={attention}
            profile={profile.name}
            up={profile.up}
            now={now}
            onOpen={onOpen}
            onDismiss={props.onDismiss}
            onRelease={props.onRelease}
            onRetry={props.onRetry}
            onRecheck={props.onRecheck}
            onCloseOnBoard={props.onCloseOnBoard}
            board={{
              columns: board.columns,
              head: <BoardHead board={board} free={free} up={profile.up} onStep={openStepInTable} />,
              rest: <BoardRows board={board} now={now} onOpen={onOpen} onMore={openStatusInTable} />,
            }}
          />
          {pipeline.kind === "error" && <p className="text-meta leading-4 text-muted" data-pipeline-unavailable>{t("board.unavailable")}</p>}
        </div>

        <aside data-overview-rail aria-label={t("overview.railLabel")} className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] content-start items-start gap-6 2xl:col-start-2 2xl:row-span-2 2xl:row-start-1 2xl:grid-cols-1">
          <DigestPanel profile={profile.name} up={profile.up} feed={feed} now={now} />
          <ProgressZone prog={prog} profile={profile.name} feed={feed} />
          <ActivityPanel feed={feed} displayIdFor={props.displayIdFor} onOpen={onOpen} />
        </aside>

        <div className="flex min-w-0 flex-col gap-6">
          <HarnessesZone profile={profile} />
          {/* A filter (set from Stats, Epics, a chip, a step's name or the board's "+N more") opens it. */}
          <section data-all-tickets data-open={ticketsShown} className="rounded-lg border border-border bg-surface">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <h2 className="text-label font-semibold uppercase tracking-wide text-muted">
                {t("overview.allTickets")} <span className="font-mono normal-case">{scoped.tickets.length}</span>
              </h2>
              <ShowHide open={ticketsShown} onToggle={hideOrShowTickets} controls="all-tickets" label={t("overview.allTicketsLabel")} data-tickets-toggle />
            </div>
            {ticketsShown && (
            <div id="all-tickets" className="px-3 pb-3">
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
                stepFilter={props.stepFilter}
                onStepFilter={props.setStepFilter}
                showAll={props.showAll}
                onShowAll={props.setShowAll}
                open={props.open}
                onOpen={onOpen}
                onDismiss={props.onDismiss}
              />
            </div>
            )}
          </section>
        </div>
      </div>

      {newTicket && profile.tracker === "local" && (
        <NewTicketModal
          profile={profile}
          onCreated={(ticket) => {
            props.onCreated?.({ profile: profile.name, ref: ticket.ref });
            setBlockedNotice(ticket.blockedBy && ticket.blockedBy.length > 0 ? { ref: ticket.ref, by: ticket.blockedBy } : null);
          }}
          onClose={() => setNewTicket(false)}
        />
      )}
      {help && <ShortcutSheet rows={OVERVIEW_SHORTCUTS.map((s) => ({ keys: s.keys, what: t(s.what) }))} onClose={() => setHelp(false)} />}
    </div>
  );
}

/**
 * The New-ticket dialog for local boards (POST /api/ticket → the receiver's ticket_add op): a title,
 * an optional markdown body, the starting step (defaults to the pipeline's first), and optional
 * comma-separated blockers. It can only be opened with the receiver up (the button is the only
 * trigger), so every failure is the server's, shown inline.
 */
function NewTicketModal({ profile, onCreated, onClose }: { profile: ProfileView; onCreated: (ticket: TicketCreated) => void; onClose: () => void }) {
  const { t, lang } = useT();
  const steps = profile.ticketSteps ?? [];
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [step, setStep] = useState<string | null>(steps[0] ?? null);
  const [blockedBy, setBlockedBy] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim()) {
      setTitleError(t("ticket.titleRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    const { url, init } = ticketAddRequest({ profile: profile.name, title: title.trim(), body: body || undefined, step: step ?? undefined, blockedBy: blockedBy.trim() || undefined });
    let status = 0;
    let parsed: unknown = null;
    try {
      const res = await fetch(url, init);
      status = res.status;
      parsed = await res.json().catch(() => null);
    } catch {
      status = 0;
    }
    const out = ticketAddOutcome(status, parsed, lang);
    if (out.ok) {
      onCreated(out.ticket);
      return onClose();
    }
    setBusy(false);
    setError(out.error);
  };
  return (
    <Modal title={t("overview.newTicket")} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1 text-label text-muted">
          {t("ticket.title")}
          <input
            autoFocus
            value={title}
            disabled={busy}
            onChange={(e) => {
              setTitle(e.target.value);
              if (titleError) setTitleError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            className="rounded border border-border bg-surface px-2 py-1 text-body text-fg focus-visible:outline-2 focus-visible:outline-accent"
          />
        </label>
        {titleError && (
          <p role="alert" className="text-label text-status-failed">
            {titleError}
          </p>
        )}
        <div className="flex flex-col gap-1 text-label text-muted">
          {t("ticket.body")}
          <div className="h-32">
            <MarkdownEditor key="new-ticket-body" initial="" onChange={setBody} />
          </div>
        </div>
        {steps.length > 0 && (
          <label className="flex flex-col gap-1 text-label text-muted">
            {t("ticket.startStep")}
            <select
              value={step ?? ""}
              disabled={busy}
              onChange={(e) => setStep(e.target.value)}
              className="rounded border border-border bg-surface px-2 py-1 text-body text-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              {steps.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-label text-muted">
          {t("ticket.blockedBy")}
          <input
            value={blockedBy}
            disabled={busy}
            placeholder={t("ticket.blockedByPlaceholder")}
            onChange={(e) => setBlockedBy(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
            className="rounded border border-border bg-surface px-2 py-1 text-body text-fg focus-visible:outline-2 focus-visible:outline-accent"
          />
        </label>
        {blockedBy.trim() && <p className="text-label text-status-held">{t("ticket.blockedNotice", { by: blockedBy.trim() })}</p>}
        {error && (
          <p role="alert" className="text-label text-status-failed">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <button type="submit" disabled={busy} className="rounded-md bg-accent px-3 py-1 text-label font-medium text-accent-fg disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent">
            {busy ? t("ticket.creating") : t("ticket.create")}
          </button>
          <button type="button" disabled={busy} onClick={onClose} className="rounded-md px-2 py-1 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
            {t("ticket.cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Tile({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div title={title} className="rounded-lg border border-border bg-surface px-3 py-2">
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
  const { t } = useT();
  const cfg = profile.configPath ? ` --config ${profile.configPath}` : "";
  return (
    <div data-stopped-banner className="rounded-lg border border-status-held/40 bg-status-held-bg px-3 py-2 text-body">
      <p className="font-semibold text-status-held">{t("overview.stopped")}</p>
      <p className="text-fg">
        {t("overview.stoppedWait")}
        {!profile.configMissing && ` ${t("overview.stoppedStart")}`}
      </p>
      {!profile.configMissing && (
        <div className="mt-2 flex flex-col gap-1.5">
          <CopyCommand command={`agenthook start${cfg}`} />
          <CopyCommand command={`agenthook reconcile${cfg}`} />
        </div>
      )}
    </div>
  );
}

/** One pip per slot: filled while an agent runs in it, dashed while free; "—" when the receiver is down. */
function SlotPips({ active, max, up }: { active: number; max: number; up: boolean }) {
  const { t } = useT();
  if (!up || max <= 0) return <span className="font-mono text-muted">—</span>;
  return (
    <span className="inline-flex items-center gap-2" title={t("overview.slotsTitle", { active, max })}>
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

/** One `active/max` chip per named harness (a profile with `harnesses` only); an uncapped one reads
 * `∞`. A down/probing one (#688) tints status-failed, its title naming the reason — the full
 * diagnosis is the Needs-you row above; this is just a glance-level flag. A `cause:"quota"` closure
 * instead shows its reopen time. */
function HarnessChips({
  harnesses,
  unharnessed,
}: {
  harnesses: NonNullable<ProfileView["harnesses"]>;
  unharnessed?: NonNullable<ProfileView["unharnessed"]>;
}) {
  const { t } = useT();
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-harness-slots role="group" aria-label={t("overview.harnessSlots")}>
      {Object.entries(harnesses).map(([name, h]) => {
        const quota = h.cause === "quota";
        const down = !quota && (h.state === "down" || h.state === "probing");
        const quotaBack = quota && h.until ? t("overview.harnessQuotaBack", { when: hhmm(h.until) }) : null;
        return (
          <span
            key={name}
            data-harness={name}
            data-harness-state={h.state}
            data-harness-cause={h.cause}
            className={`rounded border px-1.5 font-mono ${down ? "border-status-failed/40 bg-status-failed-bg text-status-failed" : quota ? "border-status-held/40 bg-status-held-bg text-status-held" : "border-border"}`}
            title={quotaBack ?? (down ? (h.reason ?? t(h.state === "down" ? "needs.harnessDown" : "needs.harnessProbing")) : h.max === null ? t("overview.harnessUncapped", { name, active: h.active }) : t("overview.harnessTitle", { name, active: h.active, max: h.max }))}
          >
            {name} <span className={down || quota ? "" : "text-fg"}>{h.active}</span>
            <span className={down || quota ? "" : "text-muted"}>/{h.max ?? "∞"}</span>
            {quotaBack ? <span className="ml-1 text-muted">· {quotaBack}</span> : null}
          </span>
        );
      })}
      {Object.entries(unharnessed ?? {}).map(([agent, n]) => (
        <span
          key={agent}
          data-harness-implicit={agent}
          className="rounded border border-dashed border-border-strong px-1.5 font-mono text-muted"
          title={t("overview.harnessImplicit", { agent, n })}
        >
          {agent} <span className="text-fg">{n}</span>
        </span>
      ))}
    </span>
  );
}

/** "14:32Z" from an ISO instant, for a quota-closed harness's reopen time. */
function hhmm(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : `${new Date(t).toISOString().slice(11, 16)}Z`;
}

function Zone({ title, count, action, children }: { title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex min-h-6 items-center justify-between gap-2">
        <h2 className="text-label font-semibold uppercase tracking-wide text-muted">
          {title}
          {count !== undefined && <span className="ml-1.5 font-mono normal-case">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * j/k walk the Needs-you rows, then the Now rows (focusing each title, so Enter opens its drawer and
 * its live log), r opens the focused held row's answer box or re-runs the focused failed one, d
 * dismisses the focused failed row, n opens the New-ticket dialog (local boards), ? shows the
 * shortcut sheet. Acts through the rows' own buttons, so a shortcut can never do what a click could not.
 */
function useNeedsYouKeys(setHelp: (open: boolean) => void, newTicketBtn?: RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutsEnabled() ? overviewAction(e, !!document.querySelector('[role="dialog"]')) : null;
      if (!action) return;
      if (action === "help") {
        e.preventDefault();
        return setHelp(true);
      }
      if (action === "new") {
        const btn = newTicketBtn?.current;
        if (!btn || btn.disabled) return;
        e.preventDefault();
        btn.click();
        return;
      }
      const titles = [...document.querySelectorAll<HTMLElement>("[data-needs-open], [data-now-open]")];
      const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-needs-row], [data-now-row]");
      if (action === "next" || action === "prev") {
        if (!titles.length) return;
        e.preventDefault();
        const at = row ? titles.findIndex((t) => row.contains(t)) : -1;
        const to = at === -1 ? (action === "next" ? 0 : titles.length - 1) : Math.min(titles.length - 1, Math.max(0, at + (action === "next" ? 1 : -1)));
        titles[to].focus();
        return;
      }
      const button = row?.querySelector<HTMLElement>(action === "release" ? "[data-release-open], [data-needs-retry]" : "[data-needs-dismiss]");
      if (!button) return;
      e.preventDefault();
      if (action === "dismiss") {
        // Keep the keyboard in the list: focus the next row (or the previous at the end) first.
        const at = titles.findIndex((t) => row!.contains(t));
        (titles[at + 1] ?? titles[at - 1])?.focus();
      }
      button.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setHelp]);
}

// Every Needs you entry seen since page load (`dismissKey`), whatever the setting, and the profiles
// whose first list (the baseline, never spoken) has been taken.
const heardNeeds = new Set<string>();
const baselined = new Set<string>();

/**
 * Read new Needs you (#560): with Read aloud and auto-read on, an entry that arrives after the
 * profile's first list is spoken once, queued behind whatever is playing (never cutting it off).
 * One that leaves and comes back (an undone dismiss, a re-hold) is not read again this page load.
 */
function useAutoRead(profile: string, needs: NeedsItem[]) {
  const reading = useReading();
  const { t: tr, lang } = useT();
  const keys = needs.map((n) => dismissKey(n.ticket));
  const on = reading.readaloud === "on" && reading.autoread === "on";
  useEffect(() => {
    const fresh = new Set(newEntries(heardNeeds, keys));
    if (!baselined.has(profile)) {
      baselined.add(profile);
      return;
    }
    if (!on || !speechSupported()) return;
    for (const n of needs) if (fresh.has(dismissKey(n.ticket))) speak(speechText(needsSpeech(n, tr, lang)), { rate: Number(reading.rate) || 1, interrupt: false });
    // The keys stand for `needs`: re-run when the list changes, not on every render.
  }, [profile, keys.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps
}

function ProgressZone({ prog, profile, feed }: { prog: Progress; profile: string; feed: FeedEntry[] }) {
  const { t, lang } = useT();
  const delta = (today: number, yesterday: number) => (yesterday === 0 && today === 0 ? "" : t("overview.yesterday", { value: yesterday }));
  const rate = prog.reworkRate;
  return (
    <Zone title={t("overview.progress")}>
      <dl data-progress className="grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-2">
        <Tile label={t("overview.finishedToday")}>
          <span className="font-mono">{prog.finishedToday}</span> <span className="text-label font-normal text-muted">{delta(prog.finishedToday, prog.finishedYesterday)}</span>
        </Tile>
        <Tile label={t("overview.costToday")}>
          <span className="font-mono">{formatSpend({ reported: prog.costToday, est: prog.estToday }) || formatCost(0, lang)}</span>{" "}
          <span className="text-label font-normal text-muted">{prog.costYesterday || prog.estYesterday ? t("overview.yesterday", { value: formatSpend({ reported: prog.costYesterday, est: prog.estYesterday }) }) : ""}</span>
        </Tile>
        <Tile label={t("overview.rework")} title={t("overview.reworkTitle")}>
          {rate === null ? (
            <span className="text-label font-normal text-muted">{t("overview.needsRuns", { min: MIN_RUNS_FOR_RATES, runs: prog.runs })}</span>
          ) : (
            <span className="font-mono">{Math.round(rate * 100)}%</span>
          )}
        </Tile>
      </dl>
      <p className="mt-1 text-meta leading-4 text-muted">{t("overview.progressFoot")}</p>
      <StatsStrip profile={profile} feed={feed} />
    </Zone>
  );
}

/** "25s"/"1.4m" — a run_end-joined wall time; "—" when the group has none. */
function fmtWallMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}m`;
}

/**
 * Which backend is worth routing to (#646): per-harness success rate, wall time, output
 * throughput and cost over the last 7 days. Shown when the profile configures named harnesses
 * (its slots chip is up, even with the receiver down) **or** the 7-day result already has a
 * group other than `(none)` (a harness ran before `harnesses` was removed from config, or before
 * the receiver booted this session) — otherwise there's nothing to route between, so it stays hidden.
 */
/**
 * Shown when the profile configures named harnesses (its slots chip is up, even with the
 * receiver down), or when the 7-day result already has a group other than `(none)` (a harness
 * ran before `harnesses` was removed from config, or before the receiver booted this session —
 * data is read straight from the state dir, so it's available even then). Pulled out as a pure
 * function so both branches are unit-testable without waiting on the fetch effect below.
 */
export function harnessesVisible(configured: boolean, groups: StatsGroup[]): boolean {
  return configured || groups.some((g) => g.key !== "(none)");
}

function HarnessesZone({ profile }: { profile: ProfileView }) {
  const { t, lang } = useT();
  const [data, setData] = useState<StatsResult | null>(null);
  useEffect(() => {
    let live = true;
    fetch(harnessStatsUrl(profile.name))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((b: StatsResult) => live && setData(b))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [profile.name]);

  const configured = !!profile.harnesses && Object.keys(profile.harnesses).length > 0;
  const groups = data?.groups ?? [];
  if (!harnessesVisible(configured, groups)) return null;

  return (
    <Zone title={t("overview.harnesses")}>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <table className="w-full border-collapse text-sm" data-harnesses-table>
          <thead className="text-left text-muted">
            <tr>
              <th className="px-3 py-2">{t("overview.harnessesCol.harness")}</th>
              <th className="px-3 py-2">{t("overview.harnessesCol.runs")}</th>
              <th className="px-3 py-2">{t("overview.harnessesCol.success")}</th>
              <th className="px-3 py-2">{t("overview.harnessesCol.p50")}</th>
              <th className="px-3 py-2">{t("overview.harnessesCol.outPerMin")}</th>
              <th className="px-3 py-2">{t("overview.harnessesCol.cost")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {groups.map((g: StatsGroup) => (
              <HarnessRow key={g.key} g={g} lang={lang} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-meta leading-4 text-muted">{t("overview.harnessesFoot")}</p>
    </Zone>
  );
}

function HarnessRow({ g, lang }: { g: StatsGroup; lang: string }) {
  // Reported and estimated cost are shown apart, never summed (formatSpend, src/pricing.js).
  const spend = formatSpend({ reported: g.costUsd, est: g.estUsd }) || formatCost(0, lang);
  return (
    <tr>
      <td className="whitespace-nowrap px-3 py-2 font-mono">{g.key}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono">{g.runs}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono">{g.successRate === null ? "—" : `${Math.round(g.successRate * 100)}%`}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono">{fmtWallMs(g.wallP50Ms)}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono">{g.outPerMin === null ? "—" : Math.round(g.outPerMin).toLocaleString(lang)}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono">{spend}</td>
    </tr>
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

