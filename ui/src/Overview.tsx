import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ProfileView, Snapshot } from "./contract";
import type { FeedEntry } from "./feed";
import { scopeToProfile } from "./summary";
import { harnessAttention, needsYouItems, progress } from "./zones";
import type { NeedsItem } from "./zones";
import { NeedsYouZone, needsSpeech } from "./NeedsYouZone";
import type { Ref } from "./NeedsYouZone";
import { BoardHead, BoardRows, usePipelineSteps } from "./Departures";
import { board as boardOf } from "./board";
import { DigestPanel } from "./DigestPanel";
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
 * it is in. Beside the board on a wide screen (below it otherwise): the digest and the live
 * activity. The glance level (PRODUCT.md) shows no cost — one quiet "N done today" line sits by
 * the headline; cost and the rework rate live on Statistics. The full ticket table is a collapsed
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
            {/* The one quiet number the glance keeps (no cost here — Statistics owns that). */}
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-label text-muted" data-done-today>
              <span><span className="font-mono text-fg">{prog.finishedToday}</span> {t("overview.doneToday")}</span>
              {(prog.finishedToday !== 0 || prog.finishedYesterday !== 0) && (
                <span className="text-meta">{t("overview.yesterday", { value: prog.finishedYesterday })}</span>
              )}
            </div>
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
              {profile.harnesses && <HarnessChips harnesses={profile.harnesses} />}
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
          <ActivityPanel feed={feed} displayIdFor={props.displayIdFor} onOpen={onOpen} />
        </aside>

        <div className="flex min-w-0 flex-col gap-6">
          {/* A filter (set from Stats, Epics, a chip, a step's name or the board's "+N more") opens it. */}
          <section data-all-tickets data-open={ticketsShown} className="rounded-lg border border-border bg-surface">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <h2 className="text-label font-semibold uppercase tracking-wide text-muted">
                {t("overview.allTickets")} <span className="font-mono normal-case">{scoped.tickets.length}</span>
              </h2>
              <ShowHide open={ticketsShown} onToggle={hideOrShowTickets} controls="all-tickets" label={t("overview.allTicketsLabel")} data-tickets-toggle />
            </div>
            {ticketsShown && (
            <div id="all-tickets" className="enter-fade px-3 pb-3">
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

/** A harness worth flagging at the glance level (#788): paused for quota, or down/probing under
 * the health breaker. A healthy harness (including a missing `state`, which fixtures and an
 * absent health state both look like) shows nothing on Overview — its `active/max` lives on the
 * Statistics page's Harnesses card. */
export function harnessProblem(h: NonNullable<ProfileView["harnesses"]>[string]): boolean {
  return h.cause === "quota" || h.state === "down" || h.state === "probing";
}

/** One chip per *problem* harness only (#788): a down/probing one tints status-failed, its title
 * naming the reason — the full diagnosis is the Needs-you row above; a `cause:"quota"` closure
 * instead shows its reopen time. Healthy harnesses and unharnessed agents render nothing; with
 * none to flag the chips render nothing at all, so the header stays quiet at rest. */
function HarnessChips({ harnesses }: { harnesses: NonNullable<ProfileView["harnesses"]> }) {
  const { t } = useT();
  const problems = Object.entries(harnesses).filter(([, h]) => harnessProblem(h));
  if (problems.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-harness-slots role="group" aria-label={t("overview.harnessSlots")}>
      {problems.map(([name, h]) => {
        const quota = h.cause === "quota";
        const quotaBack = quota && h.until ? t("overview.harnessQuotaBack", { when: hhmm(h.until) }) : null;
        return (
          <span
            key={name}
            data-harness={name}
            data-harness-state={h.state}
            data-harness-cause={h.cause}
            className={`rounded border px-1.5 font-mono ${quota ? "border-status-held/40 bg-status-held-bg text-status-held" : "border-status-failed/40 bg-status-failed-bg text-status-failed"}`}
            title={quotaBack ?? (h.reason ?? t(h.state === "down" ? "needs.harnessDown" : "needs.harnessProbing"))}
          >
            {name} {h.active}
            <span className="text-muted">/{h.max ?? "∞"}</span>
            {quotaBack ? <span className="ml-1 text-muted">· {quotaBack}</span> : null}
          </span>
        );
      })}
    </span>
  );
}

/** "14:32Z" from an ISO instant, for a quota-closed harness's reopen time. */
function hhmm(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : `${new Date(t).toISOString().slice(11, 16)}Z`;
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

