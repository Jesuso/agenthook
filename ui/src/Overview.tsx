import { useEffect, useState } from "react";
import type { ProfileView, Snapshot, TicketRow } from "./contract";
import type { FeedEntry } from "./feed";
import { formatCost, formatModel, formatSpend, formatTicketSpend, ticketTitle } from "./format";
import { scopeToProfile } from "./summary";
import { MIN_RUNS_FOR_RATES, needsYouItems, nowItems, progress } from "./zones";
import type { NeedsItem, Progress } from "./zones";
import { DigestPanel } from "./DigestPanel";
import { StatsStrip } from "./StatsStrip";
import { ActivityRail } from "./ActivityRail";
import { ProfileNameCell } from "./ProfileNameCell";
import { TicketsTable } from "./TicketsTable";
import { Ago, CopyCommand, Elapsed, Menu, Pill, ProfileMark, ReceiverStatus, ShortcutSheet, ShortcutsButton, ShowHide, SpeakButton, TicketId } from "./components";
import type { MenuItem } from "./components";
import { prNumber } from "./tickets";
import type { ReleaseOutcome } from "./config";
import { ReleasePanel } from "./ReleasePanel";
import { dismissKey } from "./deferredDismiss";
import { failureSummary } from "./failure";
import { OVERVIEW_SHORTCUTS, overviewAction, shortcutsEnabled } from "./shortcuts";
import { newEntries, speak, speechSupported, speechText } from "./speech";
import { useReading } from "./useReading";
import { useT } from "./i18n/react";
import type { MessageKey, T } from "./i18n";

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
  /** Dismissed but still undoable (`dismissKey`): hidden from Needs you until sent or undone. */
  dismissing?: ReadonlySet<string>;
  /** Answer a held ticket (optional comment for the agent); resolves with what happened. */
  onRelease: (t: Ref, comment: string) => Promise<ReleaseOutcome>;
  /** Re-run a failed ticket's failed step (receiver up only); resolves with what happened. */
  onRetry: (t: Ref) => Promise<ReleaseOutcome>;
};

/**
 * One profile's dashboard (docs/web-ui.md § v4), in the order a glance needs it: Needs you leads
 * (its count is the page's headline; empty says "All clear"), then Now (running agents, slots,
 * queue), the digest, and Progress (today vs yesterday over the events tail). The full ticket table
 * and the live activity feed are collapsed drill-downs.
 */
export function Overview(props: OverviewProps) {
  const { profile, snapshot, now, feed, onOpen } = props;
  const { t, lang } = useT();
  const scoped = scopeToProfile(snapshot, profile.name);
  const forge = !!profile.forge;
  const needs = needsYouItems(scoped.tickets, forge, lang).filter((n) => !props.dismissing?.has(dismissKey(n.ticket)));
  const { running, queued } = nowItems(scoped.tickets);
  const prog = progress(profile, scoped.tickets, now);
  const [help, setHelp] = useState(false);
  const [ticketsOpen, setTicketsOpen] = useState(false);
  const filtered = props.statusFilter !== "" || props.epicFilter !== "";
  const ticketsShown = ticketsOpen || filtered;
  useNeedsYouKeys(setHelp);
  useAutoRead(profile.name, needs);
  // A background tab or a side screen still shows whether anything needs you.
  useEffect(() => {
    document.title = `${needs.length ? `(${needs.length}) ` : ""}${profile.label} · agenthook`;
    return () => {
      document.title = "agenthook";
    };
  }, [needs.length, profile.label]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
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
              <span>
                <span className="font-mono text-fg">{profile.queued ?? 0}</span> {t("common.queued")}
              </span>
            </>
          )}
          {/* The Claude quota lives in the app bar, once; repeating it here was the critique's noise. */}
        </div>
      </div>

      {!profile.up && <StoppedBanner profile={profile} />}

      {/* Screen readers hear the headline change (a ticket arrives or is handled), not every re-render. */}
      <p className="sr-only" aria-live="polite" data-needs-live>
        {needs.length === 0 ? t("overview.liveAllClear") : t("overview.liveNeeds", { count: needs.length })}
      </p>

      <NeedsYouZone items={needs} up={profile.up} now={now} onOpen={onOpen} onDismiss={props.onDismiss} onRelease={props.onRelease} onRetry={props.onRetry} />

      <NowZone profile={profile} running={running} queued={queued} now={now} onOpen={onOpen} />

      <DigestPanel profile={profile.name} up={profile.up} feed={feed} now={now} />

      <ProgressZone prog={prog} profile={profile.name} feed={feed} />

      <div className="flex flex-col gap-3">
        {/* A filter (set from Stats, Epics or a chip) opens it: the filtered table is what was asked for. */}
        <section data-all-tickets data-open={ticketsShown} className="rounded-lg border border-border bg-surface">
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <h2 className="text-label font-semibold uppercase tracking-wide text-muted">
              {t("overview.allTickets")} <span className="font-mono normal-case">{scoped.tickets.length}</span>
            </h2>
            {!filtered && <ShowHide open={ticketsOpen} onToggle={() => setTicketsOpen(!ticketsOpen)} controls="all-tickets" label={t("overview.allTicketsLabel")} data-tickets-toggle />}
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
              showAll={props.showAll}
              onShowAll={props.setShowAll}
              open={props.open}
              onOpen={onOpen}
              onDismiss={props.onDismiss}
            />
          </div>
          )}
        </section>

        <ActivityPanel feed={feed} displayIdFor={props.displayIdFor} onOpen={onOpen} />
      </div>

      {help && <ShortcutSheet rows={OVERVIEW_SHORTCUTS.map((s) => ({ keys: s.keys, what: t(s.what) }))} onClose={() => setHelp(false)} />}
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

const KIND: Record<NeedsItem["kind"], { text: MessageKey; tone: "failed" | "held" | "done" }> = {
  failed: { text: "needs.failed", tone: "failed" },
  held: { text: "needs.held", tone: "held" },
  pr: { text: "needs.pr", tone: "done" },
};

/** Hover (or keyboard focus) reveals a row's actions; touch screens always show them. */
const REVEAL = "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100";
/** A primary, always-visible row action (Release…, PR ↗). */
/** A row's secondary action: no border, muted until hovered, so the primary one reads first. */
const QUIET = "inline-block rounded-md px-2 py-0.5 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:px-3 pointer-coarse:py-2";
const ACTION = "inline-block rounded-md border border-border px-2 py-0.5 text-label font-medium hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:px-3 pointer-coarse:py-2";
const LINK = "rounded px-1.5 py-0.5 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent";

/**
 * j/k walk the Needs-you rows, then the Now rows (focusing each title, so Enter opens its drawer and
 * its live log), r opens the focused held row's answer box or re-runs the focused failed one, d
 * dismisses the focused failed row, ? shows the shortcut sheet. Acts through the
 * rows' own buttons, so a shortcut can never do what a click could not.
 */
function useNeedsYouKeys(setHelp: (open: boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutsEnabled() ? overviewAction(e, !!document.querySelector('[role="dialog"]')) : null;
      if (!action) return;
      if (action === "help") {
        e.preventDefault();
        return setHelp(true);
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

/** The headline count takes the tone of the worst thing waiting: failed, then held. */
const headlineTone = (items: NeedsItem[]) =>
  items.some((i) => i.kind === "failed") ? "text-status-failed" : items.some((i) => i.kind === "held") ? "text-status-held" : "text-fg";

type Retry = { state: "busy" | "started" } | { state: "error"; error: string };

/** A row's second line: the agent's plain sentence, else the (short) reason, else the summary. */
function needsSub(item: NeedsItem, lang = "en") {
  const reason = item.kind === "failed" ? failureSummary(item.reason, lang) : item.reason;
  return { reason, sub: item.ticket.plain ?? reason ?? item.ticket.summary };
}

const needsTitle = (t: TicketRow, tr: T, lang: string) => {
  const title = ticketTitle(t, lang);
  return { title, titleText: title.unknown ? tr("ticket.untitled") : title.text };
};

/** What a row's 🔊 (and auto-read) says: its title, then its full second line. */
function needsSpeech(item: NeedsItem, tr: T, lang: string): string {
  const { sub } = needsSub(item, lang);
  const { titleText } = needsTitle(item.ticket, tr, lang);
  return sub ? `${titleText}. ${sub}` : titleText;
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

function NeedsYouZone({ items, up, now, onOpen, onDismiss, onRelease, onRetry }: { items: NeedsItem[]; up: boolean; now: number; onOpen: (t: Ref) => void; onDismiss: (t: Ref) => void; onRelease: OverviewProps["onRelease"]; onRetry: OverviewProps["onRetry"] }) {
  const { t: tr, lang } = useT();
  const [releasing, setReleasing] = useState<string | null>(null);
  // Per-ref re-run progress. "started" holds until the row leaves (the receiver's enqueued event).
  const [retries, setRetries] = useState<Record<string, Retry>>({});
  const retry = (t: TicketRow) => {
    setRetries((r) => ({ ...r, [t.ref]: { state: "busy" } }));
    void onRetry({ profile: t.profile, ref: t.ref }).then((out) =>
      setRetries((r) => ({ ...r, [t.ref]: out.ok ? { state: "started" } : { state: "error", error: out.error } })),
    );
  };
  if (items.length === 0) {
    return (
      // The calm verdict takes the same headline slot as "N need you": the second-screen glance has
      // to read "look away" as loudly as "look here". Down, it stays neutral: someone must restart it.
      <section data-all-clear>
        <h2 className="flex items-baseline gap-2">
          {up && (
            <span aria-hidden="true" className="text-stat font-semibold text-success">
              ✓
            </span>
          )}{" "}
          <span className="text-stat font-semibold">{up ? tr("overview.allClear") : tr("overview.nothingNeedsYou")}</span>
        </h2>
        <p className="text-label text-muted">
          {up ? tr("overview.allClearHint") : tr("overview.downHint")}
        </p>
      </section>
    );
  }
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="flex items-baseline gap-2">
          <span className={`font-mono text-stat font-semibold ${headlineTone(items)}`}>{items.length}</span>{" "}
          <span className="text-title font-semibold">{tr("overview.needYou", { count: items.length })}</span>
        </h2>
        <p className="ml-auto text-label text-muted max-sm:hidden" data-keys-hint>
          <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> {tr("overview.keysMove")} · <kbd className="font-mono">?</kbd> {tr("overview.keysShortcuts")}
        </p>
      </div>
      <ul data-needs-you-zone className="divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface">
        {items.map((item) => {
          const { ticket: t, kind, since } = item;
          // The agent's plain sentence leads when it wrote one; the full reason moves to the tooltip.
          const { reason, sub } = needsSub(item, lang);
          const subTitle = t.plain ? (item.reason ?? t.summary ?? undefined) : (reason ?? t.summary ?? undefined);
          const said = t.plain ?? reason;
          const { title, titleText } = needsTitle(t, tr, lang);
          const kindText = tr(KIND[kind].text);
          const rerun = retries[t.ref];
          const pr = prNumber(t.prUrl);
          return (
            <li key={t.ref} data-needs-row={t.ref} data-kind={kind}>
              {/* Below sm (a half-width window, a phone) the row stacks: kind, id, age and the action on
                  one line, the title and its reason full width underneath, instead of squeezing to "…". */}
              <div className="group flex items-center gap-3 px-3 py-2 focus-within:bg-surface-raised max-sm:flex-wrap max-sm:gap-y-1">
                <span className="w-[4.5rem] shrink-0 max-sm:w-auto"><Pill tone={KIND[kind].tone}>{kindText}</Pill></span>
                <TicketId id={t.displayId} url={t.trackerUrl} />
                <SpeakButton text={needsSpeech(item, tr, lang)} label={tr("speak.needsRow", { id: t.displayId })} className="shrink-0" />
                <button
                  type="button"
                  data-needs-open
                  aria-label={`${t.displayId} ${titleText}, ${kindText}${said ? `: ${said}` : ""}`}
                  className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-accent max-sm:order-last max-sm:basis-full"
                  title={t.summary ? tr("overview.titleOpenDetails", { title: t.summary }) : tr("overview.openDetails")}
                  onClick={() => onOpen({ profile: t.profile, ref: t.ref })}
                >
                  <span className={title.unknown ? "text-muted" : ""}>{titleText}</span>
                  {sub && <span className="block truncate text-label text-muted" data-needs-sub title={subTitle}>{sub}</span>}
                </button>
                <span className="w-32 shrink-0 whitespace-nowrap text-right text-label text-muted max-sm:ml-auto max-sm:w-auto">
                  {t.step ? `${t.step} · ` : ""}
                  <Ago iso={since} seed={now} />
                </span>
                {/* One primary action per row, always visible, in a fixed-width slot so the columns line
                    up; a failed row adds the quieter Dismiss before it. A PR link on a held/failed row
                    lives in the drawer header; the title opens the drawer. */}
                <span className="flex w-40 shrink-0 items-center justify-end gap-1 max-sm:w-auto">
                  {kind === "failed" && (
                    <button type="button" data-needs-dismiss aria-label={tr("overview.dismissAria", { id: t.displayId })} aria-keyshortcuts="d" className={QUIET} title={tr("overview.dismissTitle")} onClick={() => onDismiss({ profile: t.profile, ref: t.ref })}>
                      {tr("overview.dismiss")}
                    </button>
                  )}
                  <span data-needs-primary>
                    {kind === "held" ? (
                      releasing !== t.ref && (
                        <button type="button" data-release-open aria-label={tr("overview.releaseAria", { id: t.displayId })} aria-keyshortcuts="r" className={ACTION} onClick={() => setReleasing(t.ref)}>
                          {tr("overview.release")}
                        </button>
                      )
                    ) : kind === "failed" && up ? (
                      <button
                        type="button"
                        data-needs-retry
                        aria-label={t.step ? tr("overview.rerunAriaStep", { id: t.displayId, step: t.step }) : tr("overview.rerunAria", { id: t.displayId })}
                        aria-keyshortcuts="r"
                        disabled={rerun?.state === "busy" || rerun?.state === "started"}
                        className={`${ACTION} disabled:cursor-default disabled:text-muted disabled:hover:bg-transparent`}
                        title={t.step ? tr("overview.rerunStepTitle", { step: t.step }) : tr("overview.rerunTitle")}
                        onClick={() => retry(t)}
                      >
                        {rerun?.state === "busy" ? tr("overview.rerunning") : rerun?.state === "started" ? tr("overview.started") : tr("overview.rerun")}
                      </button>
                    ) : kind === "failed" ? (
                      // Down, nothing can re-run it: the drawer has the full reason and the run log.
                      <button type="button" data-needs-log aria-label={tr("overview.openLogAria", { id: t.displayId })} className={ACTION} onClick={() => onOpen({ profile: t.profile, ref: t.ref })}>
                        {tr("overview.openLog")}
                      </button>
                    ) : t.prUrl ? (
                      <a className={ACTION} href={t.prUrl} target="_blank" rel="noreferrer" aria-label={tr("overview.openPrAria", { pr: pr ? `#${pr}` : "", id: t.displayId })}>
                        PR {pr ? `#${pr}` : ""} ↗
                      </a>
                    ) : null}
                  </span>
                </span>
              </div>
              {rerun?.state === "error" && (
                <p role="alert" data-retry-error className="px-3 pb-2 text-label text-status-failed">
                  {tr("overview.retryError", { id: t.displayId, error: rerun.error })}
                </p>
              )}
              {kind === "held" && releasing === t.ref && <ReleasePanel ticket={item.ticket} onRelease={onRelease} onClose={() => setReleasing(null)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function NowRow({ t, now, onOpen, queuedAt }: { t: TicketRow; now: number; onOpen: (r: Ref) => void; queuedAt?: number }) {
  const { t: tr, lang } = useT();
  const title = ticketTitle(t, lang);
  const model = formatModel(t.model);
  return (
    <li data-now-row={t.ref} className="group flex items-center gap-3 px-3 py-2 focus-within:bg-surface-raised">
      {queuedAt !== undefined ? <span className="w-5 font-mono text-label text-muted">{queuedAt}</span> : <span aria-hidden="true" className="size-2 animate-status-pulse rounded-full bg-status-running" />}
      <TicketId id={t.displayId} url={t.trackerUrl} />
      <button type="button" data-now-open className="min-w-0 flex-1 truncate text-left focus-visible:outline-2 focus-visible:outline-accent" title={title.unknown ? tr("overview.openDetails") : tr("overview.titleOpenDetails", { title: `${title.text}${t.summary ? ` — ${t.summary}` : ""}` })} onClick={() => onOpen({ profile: t.profile, ref: t.ref })}>
        <span className={title.unknown ? "text-muted" : ""}>{title.unknown ? tr("ticket.untitled") : title.text}</span>
        {(t.plain ?? t.summary) && <span className="block truncate text-label text-muted" data-now-sub>{t.plain ?? t.summary}</span>}
      </button>
      {t.step && <Pill>{t.step}</Pill>}
      {queuedAt === undefined && (
        <>
          {/* Narrow: model and cost go (the drawer has both); elapsed stays, it is the progress signal. */}
          <span className="font-mono text-label text-muted max-sm:hidden" title={model.title}>{model.text}</span>
          <Elapsed iso={t.startedAt} seed={now} className="text-label" />
          <span className="font-mono text-label text-muted max-sm:hidden" title={tr("overview.costSoFar")}>{formatTicketSpend(t)}</span>
          <button type="button" className={`${LINK} ${REVEAL} max-sm:hidden`} onClick={() => onOpen({ profile: t.profile, ref: t.ref })}>
            {tr("overview.followLog")}
          </button>
        </>
      )}
    </li>
  );
}

function NowZone({ profile, running, queued, now, onOpen }: { profile: ProfileView; running: TicketRow[]; queued: TicketRow[]; now: number; onOpen: (t: Ref) => void }) {
  const { t } = useT();
  const max = profile.maxConcurrent ?? 0;
  const free = profile.up ? Math.max(0, max - running.length) : 0;
  return (
    <Zone title={t("overview.now")} count={running.length}>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {running.length > 0 && <ul className="divide-y divide-border-subtle">{running.map((t) => <NowRow key={t.ref} t={t} now={now} onOpen={onOpen} />)}</ul>}
        {/* Idle capacity is one quiet line, not a row per slot: rows are for work. */}
        {free > 0 && (
          <p data-free-slots={free} className={`flex items-center gap-3 px-3 py-2 text-label text-muted ${running.length ? "border-t border-border-subtle" : ""}`}>
            <span aria-hidden="true" className="size-2 rounded-full border border-dashed border-border-strong" />
            {running.length === 0 ? t("overview.nothingRunning") : ""}
            {t("overview.freeSlots", { count: free })}
          </p>
        )}
        {!profile.up && running.length === 0 && <p className="px-3 py-2 text-label text-muted">{t("overview.nothingIsRunning")}</p>}
        {queued.length > 0 && (
          <div className="border-t border-border-subtle">
            <div className="px-3 pt-2 text-label text-muted">
              {t("overview.queuedHeading")} · <span className="font-mono">{queued.length}</span>
            </div>
            <ul className="divide-y divide-border-subtle">{queued.map((t, i) => <NowRow key={t.ref} t={t} now={now} onOpen={onOpen} queuedAt={i + 1} />)}</ul>
          </div>
        )}
      </div>
    </Zone>
  );
}

function ProgressZone({ prog, profile, feed }: { prog: Progress; profile: string; feed: FeedEntry[] }) {
  const { t, lang } = useT();
  const delta = (today: number, yesterday: number) => (yesterday === 0 && today === 0 ? "" : t("overview.yesterday", { value: yesterday }));
  const rate = prog.reworkRate;
  return (
    <Zone title={t("overview.progress")}>
      <dl data-progress className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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

