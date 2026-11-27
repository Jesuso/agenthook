import { useState } from "react";
import type { ReactNode } from "react";
import type { TicketRow } from "./contract";
import type { HarnessAttentionItem, NeedsItem } from "./zones";
import { ticketTitle } from "./format";
import { failureSummary } from "./failure";
import { prNumber } from "./tickets";
import type { ReleaseOutcome } from "./config";
import { ReleasePanel } from "./ReleasePanel";
import { BoardFrame, ROW, SUBGRID, StepName, Track } from "./Departures";
import { useArrivals } from "./motion";
import { Ago } from "./components/LiveTime";
import { Menu } from "./components/Menu";
import { Pill } from "./components/Pill";
import { SpeakButton } from "./components/SpeakButton";
import { TicketId } from "./components/TicketId";
import type { MenuItem } from "./components/Menu";
import { useT } from "./i18n/react";
import type { MessageKey, T } from "./i18n";

/**
 * The Needs-you zone (docs/web-ui.md § v4 "Needs you"): held/failed tickets plus a flagged PR row
 * (forge profiles) and a down/probing harness, worst first, under the page's headline count (or
 * "All clear"). Given a `board` (#696), its rows are the first rows of that board: same grid, same
 * step columns, each row marked on the step it stopped in, and the board's own rows follow.
 */

/** The board the rows are drawn on: its step columns, its first row, and the rows after ours. */
export type NeedsBoard = { columns: string[]; head: ReactNode; rest: ReactNode };

export type Ref = { profile: string; ref: string };

const KIND: Record<NeedsItem["kind"], { text: MessageKey; tone: "failed" | "held" | "done" }> = {
  failed: { text: "needs.failed", tone: "failed" },
  held: { text: "needs.held", tone: "held" },
  pr: { text: "needs.pr", tone: "done" },
};

/** A row's second line: the agent's plain sentence, else the (short) reason, else the summary. */
const QUIET = "inline-block rounded-md px-2 py-0.5 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:px-3 pointer-coarse:py-2";
const ACTION = "inline-block rounded-md border border-border px-2 py-0.5 text-label font-medium hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:px-3 pointer-coarse:py-2";

/** The headline count takes the tone of the worst thing waiting: failed, then held. */
const headlineTone = (items: NeedsItem[]) =>
  items.some((i) => i.kind === "failed") ? "text-status-failed" : items.some((i) => i.kind === "held") ? "text-status-held" : "text-fg";

/** On the board, a row that waits on you is lit: a flat tint of its own status, never an accent. */
const TINT: Record<NeedsItem["kind"], string> = { failed: "bg-status-failed-bg/40", held: "bg-status-held-bg/40", pr: "" };

type Retry = { state: "busy" | "started" } | { state: "error"; error: string };

function needsSub(item: NeedsItem, lang = "en") {
  const reason = item.kind === "failed" ? failureSummary(item.reason, lang) : item.reason;
  return { reason, sub: item.ticket.plain ?? reason ?? item.ticket.summary };
}

const needsTitle = (t: TicketRow, tr: T, lang: string) => {
  const title = ticketTitle(t, lang);
  return { title, titleText: title.unknown ? tr("ticket.untitled") : title.text };
};

/** What a row's 🔊 (and auto-read) says: its title, then its full second line. */
export function needsSpeech(item: NeedsItem, tr: T, lang: string): string {
  const { sub } = needsSub(item, lang);
  const { titleText } = needsTitle(item.ticket, tr, lang);
  return sub ? `${titleText}. ${sub}` : titleText;
}

export function NeedsYouZone({ items, attention, profile, up, now, onOpen, onDismiss, onRelease, onRetry, onRecheck, onCloseOnBoard, board }: { board?: NeedsBoard; items: NeedsItem[]; attention: HarnessAttentionItem[]; profile: string; up: boolean; now: number; onOpen: (t: Ref) => void; onDismiss: (t: Ref) => void; onRelease: (t: Ref, comment: string) => Promise<ReleaseOutcome>; onRetry: (t: Ref) => Promise<ReleaseOutcome>; onRecheck?: (profile: string, ref: string | null) => Promise<ReleaseOutcome>; onCloseOnBoard?: (t: Ref) => Promise<ReleaseOutcome> }) {
  const { t: tr, lang } = useT();
  const [releasing, setReleasing] = useState<string | null>(null);
  // The one place motion asks for attention: a row that starts needing the operator is washed
  // once. Arrived while the tab was in the background → washed when the operator comes back.
  const called = useArrivals([...attention.map((a) => `harness:${a.harness}`), ...items.map((i) => i.ticket.ref)], 1600, "defer");
  // Per-ref re-run progress. "started" holds until the row leaves (the receiver's enqueued event).
  const [retries, setRetries] = useState<Record<string, Retry>>({});
  const retry = (t: TicketRow) => {
    setRetries((r) => ({ ...r, [t.ref]: { state: "busy" } }));
    void onRetry({ profile: t.profile, ref: t.ref }).then((out) =>
      setRetries((r) => ({ ...r, [t.ref]: out.ok ? { state: "started" } : { state: "error", error: out.error } })),
    );
  };
  // A PR row's Re-check / Close on board refusal, shown under the row until the next try (key "" = Re-check all).
  const [prErrors, setPrErrors] = useState<Record<string, string>>({});
  const [checkingAll, setCheckingAll] = useState(false);
  const prAction = (key: string, run: () => Promise<ReleaseOutcome>) => {
    setPrErrors(({ [key]: _, ...rest }) => rest);
    return run().then((out) => {
      if (!out.ok) setPrErrors((e) => ({ ...e, [key]: out.error }));
    });
  };
  const recheckAll = () => {
    if (!onRecheck) return;
    setCheckingAll(true);
    void prAction("", () => onRecheck(profile, null)).finally(() => setCheckingAll(false));
  };
  const open = (url: string | null) => url && window.open(url, "_blank", "noopener,noreferrer");
  // The ⋯ menu of a PR row (code and board disagree): Re-check leads; Close on board only where the code shipped.
  const prMenu = (t: TicketRow): MenuItem[] => [
    { label: tr("overview.recheck"), disabled: !up || !onRecheck, onSelect: () => void (onRecheck && prAction(t.ref, () => onRecheck(t.profile, t.ref))) },
    ...(t.prNeeds === "mergedOpen" || t.prNeeds === "openOnDone"
      ? [{ label: tr("overview.closeOnBoard"), disabled: !up || !onCloseOnBoard, onSelect: () => void (onCloseOnBoard && prAction(t.ref, () => onCloseOnBoard({ profile: t.profile, ref: t.ref }))) }]
      : []),
    { label: tr("overview.dismiss"), onSelect: () => onDismiss({ profile: t.profile, ref: t.ref }) },
    { label: tr("overview.openPr"), disabled: !t.prUrl, onSelect: () => open(t.prUrl) },
    { label: tr("overview.openTicket"), disabled: !t.trackerUrl, onSelect: () => open(t.trackerUrl) },
  ];
  const anyPr = items.some((i) => i.kind === "pr");
  const count = attention.length + items.length;
  const frame = (rows: ReactNode) =>
    board && (
      <BoardFrame columns={board.columns}>
        {board.head}
        {rows}
        {board.rest}
      </BoardFrame>
    );
  if (count === 0) {
    return (
      // The calm verdict takes the same headline slot as "N need you": the second-screen glance has
      // to read "look away" as loudly as "look here". Down, it stays neutral: someone must restart it.
      <section data-all-clear className={board ? "flex flex-col gap-3" : undefined}>
        <div>
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
        </div>
        {frame(null)}
      </section>
    );
  }
  const headline = (
    <>
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="flex items-baseline gap-2">
          <span className={`font-mono text-stat font-semibold ${attention.length ? "text-status-failed" : headlineTone(items)}`}>{count}</span>{" "}
          <span className="text-title font-semibold">{tr("overview.needYou", { count })}</span>
        </h2>
        <p className="ml-auto text-label text-muted max-sm:hidden" data-keys-hint>
          <kbd className="font-mono">j</kbd>/<kbd className="font-mono">k</kbd> {tr("overview.keysMove")} · <kbd className="font-mono">?</kbd> {tr("overview.keysShortcuts")}
        </p>
        {anyPr && up && onRecheck && (
          <button type="button" data-recheck-all disabled={checkingAll} className={`${QUIET} disabled:cursor-default max-sm:ml-auto`} title={tr("overview.recheckAllTitle")} onClick={recheckAll}>
            {tr("overview.recheckAll")}
          </button>
        )}
      </div>
      {prErrors[""] !== undefined && (
        <p role="alert" data-recheck-all-error className="mb-2 text-label text-status-failed">
          {prErrors[""]}
        </p>
      )}
    </>
  );
  const rows = (
      <ul data-needs-you-zone className={`divide-y divide-border-subtle ${board ? SUBGRID : "overflow-hidden rounded-lg border border-border bg-surface"}`}>
        {attention.map((a) => <HarnessAttentionRow key={a.harness} item={a} wide={!!board} called={called.has(`harness:${a.harness}`)} />)}
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
          const speak = <SpeakButton text={needsSpeech(item, tr, lang)} label={tr("speak.needsRow", { id: t.displayId })} className="shrink-0" />;
          // The row's title: it opens the drawer; the agent's sentence (or the reason) sits under it.
          const titleButton = (cls: string, subCls: string) => (
            <button
              type="button"
              data-needs-open
              aria-label={`${t.displayId} ${titleText}, ${kindText}${said ? `: ${said}` : ""}`}
              className={cls}
              title={t.summary ? tr("overview.titleOpenDetails", { title: t.summary }) : tr("overview.openDetails")}
              onClick={() => onOpen({ profile: t.profile, ref: t.ref })}
            >
              <span className={title.unknown ? "text-muted" : ""}>{titleText}</span>
              {sub && <span className={subCls} data-needs-sub title={subTitle}>{sub}</span>}
            </button>
          );
          return (
            <li key={t.ref} data-needs-row={t.ref} data-kind={kind} data-called={called.has(t.ref) || undefined} className={`${board ? `${SUBGRID} ${TINT[kind]}` : ""} ${called.has(t.ref) ? "needs-arrive" : ""}`}>
              {/* Narrow (a half-width window, a phone) the row stacks: kind, id and age on one line with
                  the title and its reason beside them, then its step and the action on a second line,
                  instead of squeezing to "…". */}
              <div className={board ? `group ${ROW} focus-within:bg-surface-raised` : "group flex items-center gap-3 px-3 py-2 focus-within:bg-surface-raised max-sm:flex-wrap max-sm:gap-y-1"}>
                <span className={board ? "" : "w-[4.5rem] shrink-0 max-sm:w-auto"}><Pill tone={KIND[kind].tone}>{kindText}</Pill></span>
                <TicketId id={t.displayId} url={t.trackerUrl} />
                {!board && speak}
                {board ? (
                  <span className="flex min-w-0 items-start gap-2 py-2">
                    <span className="min-w-0 flex-1">
                      {titleButton(`block w-full text-left font-medium focus-visible:outline-2 focus-visible:outline-accent`, "block text-label font-normal text-muted @4xl:line-clamp-2")}
                      <span className="@max-4xl:hidden"><StepName columns={board.columns} step={t.step} /></span>
                    </span>
                    {speak}
                  </span>
                ) : (
                  titleButton("min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-accent max-sm:order-last max-sm:basis-full", "block truncate text-label text-muted")
                )}
                {board && <Track columns={board.columns} step={t.step} mark={kind === "pr" ? "pr" : kind} id={`${t.profile}:${t.ref}`} />}
                <span className={board ? "whitespace-nowrap text-label text-muted" : "w-32 shrink-0 whitespace-nowrap text-right text-label text-muted max-sm:ml-auto max-sm:w-auto"}>
                  {!board && t.step ? `${t.step} · ` : ""}
                  <Ago iso={since} seed={now} />
                </span>
                {/* One primary action per row, always visible, in its own column so the rows line up; a
                    failed row adds the quieter Dismiss before it. A PR link on a held/failed row
                    lives in the drawer header; the title opens the drawer. */}
                <span className={board ? "flex items-center justify-end gap-1 @max-4xl:col-start-3 @max-4xl:col-end-[-1] @max-4xl:pb-2" : "flex w-40 shrink-0 items-center justify-end gap-1 max-sm:w-auto"}>
                  {/* Narrow, the step shares the action's line instead of taking one of its own. */}
                  {board && t.step && <span data-row-step className="mr-auto @4xl:hidden"><Pill>{t.step}</Pill></span>}
                  {kind === "pr" && (
                    <span data-needs-pr-menu>
                      <Menu label={tr("overview.prMenu", { id: t.displayId })} items={prMenu(t)} />
                    </span>
                  )}
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
              {prErrors[t.ref] !== undefined && (
                <p role="alert" data-pr-action-error className="col-span-full px-3 pb-2 text-label text-status-failed">
                  {tr("overview.prActionError", { id: t.displayId, error: prErrors[t.ref] })}
                </p>
              )}
              {rerun?.state === "error" && (
                <p role="alert" data-retry-error className="col-span-full px-3 pb-2 text-label text-status-failed">
                  {tr("overview.retryError", { id: t.displayId, error: rerun.error })}
                </p>
              )}
              {kind === "held" && releasing === t.ref && (
                <div className="col-span-full">
                  <ReleasePanel ticket={item.ticket} onRelease={onRelease} onClose={() => setReleasing(null)} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
  );
  return (
    <section>
      {headline}
      {board ? frame(rows) : rows}
    </section>
  );
}

/** "14:32Z" from an ISO instant, for a down harness's "until" time — a clock time reads better
 * than a relative one for something in the future. @param {string} iso */
function clockTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : `${new Date(t).toISOString().slice(11, 16)}Z`;
}

/**
 * A harness whose breaker is down/probing (#688): no verdict to release, no PR to open — the row
 * is a diagnosis (name, pill, reason, until) plus the fix: run `harness_reset`. It disappears on
 * its own once `harness_up` fires — there is nothing to dismiss or click.
 */
function HarnessAttentionRow({ item, wide, called }: { item: HarnessAttentionItem; wide: boolean; called?: boolean }) {
  const { t: tr } = useT();
  return (
    <li data-needs-row={`harness:${item.harness}`} data-kind="harness" data-harness-state={item.state} className={`${wide ? `col-span-full ${TINT.failed}` : ""} ${called ? "needs-arrive" : ""}`}>
      <div className="flex items-center gap-3 px-3 py-2 max-sm:flex-wrap max-sm:gap-y-1">
        <span className="w-[4.5rem] shrink-0 max-sm:w-auto">
          <Pill tone="failed">{tr(item.state === "down" ? "needs.harnessDown" : "needs.harnessProbing")}</Pill>
        </span>
        <span className="min-w-0 flex-1 font-mono">{item.harness}</span>
        <div className="min-w-0 flex-1 max-sm:order-last max-sm:basis-full">
          {item.reason && <span className="block truncate text-label text-muted">{item.reason}</span>}
          <span className="block truncate text-label text-muted">{tr("overview.harnessResetHint", { name: item.harness })}</span>
        </div>
        <span className="w-32 shrink-0 whitespace-nowrap text-right text-label text-muted max-sm:ml-auto max-sm:w-auto">
          {item.until
            ? tr(item.state === "down" ? "overview.harnessDownUntil" : "overview.harnessProbingSince", { when: clockTime(item.until) })
            : tr(item.state === "down" ? "needs.harnessDown" : "overview.harnessProbing")}
        </span>
      </div>
    </li>
  );
}
