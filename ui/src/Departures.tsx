import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { TicketRow, TicketStatus } from "./contract";
import { readSteps } from "./configEdit";
import { configUrl, parseCheck } from "./config";
import type { Board } from "./board";
import { ticketTitle } from "./format";
import { Ago, Elapsed, Pill, ShowHide, TicketId, Waiting } from "./components";
import { useT } from "./i18n/react";

/**
 * The Overview's board (#696): one row per ticket, the pipeline's steps as columns, and in each
 * row a line drawn up to the step the ticket is in. The rows that need you come first (they are
 * `NeedsYouZone`'s, drawn on this same grid), then what runs, what waits, and what finished today
 * (closed until asked for).
 * Nothing else of the pipeline's shape (edges, exit stages) is drawn here — that is Config's graph.
 *
 * One CSS grid holds every row (`subgrid`), so ids, titles, steps and clocks line up down the
 * whole card. The step columns show once the card itself is wide enough (a container query, so a
 * narrow window and a narrow column behave alike); below that each row names its step instead.
 */

type Ref = { profile: string; ref: string };

export type PipelineSteps = { kind: "loading" } | { kind: "error" } | { kind: "ok"; ids: string[]; manual: string[] };

/** The pipeline's step ids in order, and which of them are manual (they run no agent). */
export function pipelineStepIds(steps: Record<string, unknown>[]): { ids: string[]; manual: string[] } {
  const named = steps.filter((s) => typeof s.id === "string" && s.id !== "");
  return { ids: named.map((s) => s.id as string), manual: named.filter((s) => s.manual === true).map((s) => s.id as string) };
}

/** `GET /api/config` → the pipeline's steps. No new endpoint: ConfigView's own read. */
export function usePipelineSteps(profileName: string, lang: string): PipelineSteps {
  const [state, setState] = useState<PipelineSteps>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    fetch(configUrl(profileName))
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { text: string }) => {
        if (!live) return;
        const parsed = parseCheck(body.text, lang);
        setState(parsed.ok ? { kind: "ok", ...pipelineStepIds(readSteps(parsed.raw)) } : { kind: "error" });
      })
      .catch(() => live && setState({ kind: "error" }));
    return () => {
      live = false;
    };
  }, [profileName, lang]);
  return state;
}

/* Full literal classes — Tailwind's scanner needs them written out. Narrow: state, id, title, clock.
   Wide: state, id, title, one column per step, clock, action. A step column keeps room for its
   name; a long pipeline shares a little over half the card between its steps instead. */
const FRAME = "grid grid-cols-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-lg border border-border bg-surface";
const FRAME_STEPS = "@4xl:grid-cols-[5.5rem_auto_minmax(14rem,4fr)_repeat(var(--board-steps),minmax(min(6rem,calc(55cqw/var(--board-steps))),1fr))_6.5rem_auto]";
const FRAME_PLAIN = "@4xl:grid-cols-[5.5rem_auto_minmax(16rem,1fr)_6.5rem_auto]";

/** A full-width child of the board that passes the board's columns on to its own children. */
export const SUBGRID = "col-span-full grid grid-cols-subgrid";
/** One board row. */
export const ROW = `${SUBGRID} min-h-9 items-center gap-x-3 px-3`;
/** A step cell: cells touch (the row's gap is taken back) so a row's line runs unbroken. */
const STEP_CELL = "relative -mx-1.5 self-stretch border-l border-border-subtle @max-4xl:hidden";

/** The card every board row sits in. `columns` are the step columns ([] = none yet). */
export function BoardFrame({ columns, children }: { columns: string[]; children?: ReactNode }) {
  return (
    <div className="@container">
      <div data-board data-board-steps={columns.length} style={{ "--board-steps": columns.length } as CSSProperties} className={`${FRAME} ${columns.length ? FRAME_STEPS : FRAME_PLAIN}`}>
        {children}
      </div>
    </div>
  );
}

type Mark = TicketStatus | "pr";

/** Moving is a filled, pulsing dot; waiting is a hollow one — the shape says it, not the hue alone. */
const MARK: Partial<Record<Mark, string>> = {
  running: "bg-status-running animate-status-pulse",
  interrupted: "bg-status-interrupted",
  queued: "border border-status-queued bg-surface",
  stalled: "border border-status-stalled bg-surface",
  held: "bg-status-held",
  failed: "bg-status-failed",
};

/** A row's step cells: a line through the steps behind the ticket, a mark on the one it is in. */
export function Track({ columns, step, mark }: { columns: string[]; step: string | null; mark: Mark }) {
  const at = step ? columns.indexOf(step) : -1;
  return (
    <>
      {columns.map((id, i) => (
        <span key={id} aria-hidden="true" data-track={i === at ? "at" : i < at ? "past" : "ahead"} className={`${STEP_CELL} grid place-items-center`}>
          {i <= at && <span className={`absolute left-0 top-1/2 h-px bg-border-strong ${i < at ? "w-full" : "w-1/2"}`} />}
          {i === at && <span className={`relative size-2.5 rounded-full ${MARK[mark] ?? "bg-border-strong"}`} />}
        </span>
      ))}
    </>
  );
}

/**
 * Where a row says its step in words: under the title while the step columns are hidden (or when
 * the step is not one of them); read out, not shown, once the columns say it.
 */
export function StepName({ columns, step }: { columns: string[]; step: string | null }) {
  if (!step) return null;
  return (
    <span data-row-step className={`mt-1 block ${columns.includes(step) ? "@4xl:sr-only" : ""}`}>
      <Pill>{step}</Pill>
    </span>
  );
}

/** The board's first row: what is in flight, then each step's name and how many tickets sit in it. */
export function BoardHead({ board, free, up, onStep }: { board: Board; free: number; up: boolean; onStep: (step: string) => void }) {
  const { t } = useT();
  const idle = board.runningCount === 0 && board.queuedCount === 0;
  return (
    <div data-board-head className={`${ROW} border-b border-border-subtle text-label text-muted`}>
      <p className="col-span-3 flex flex-wrap items-center gap-x-3 py-1.5 @max-4xl:col-span-full">
        <span data-now-summary>{idle ? t(up ? "board.idle" : "overview.nothingIsRunning") : t("board.stepCount", { running: board.runningCount, queued: board.queuedCount })}</span>
        {/* Idle capacity is a few words, not a row per slot: rows are for work. */}
        {free > 0 && <span data-free-slots={free}>{t("overview.freeSlots", { count: free })}</span>}
      </p>
      {board.columns.map((id) => (
        <span key={id} data-board-step={id} className={`${STEP_CELL} flex min-w-0 items-center gap-1.5 px-2.5`}>
          <button type="button" className="min-w-0 truncate rounded-sm font-mono font-semibold hover:text-fg focus-visible:outline-2 focus-visible:outline-accent" title={t("board.stepTitle", { step: id })} onClick={() => onStep(id)}>
            {id}
          </button>
          {(board.counts[id] ?? 0) > 0 && <span className="font-mono text-fg" data-board-count>{board.counts[id]}</span>}
        </span>
      ))}
    </div>
  );
}

const MORE = "col-span-full border-t border-border-subtle px-3 py-1.5 text-left text-label text-accent hover:bg-surface-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/**
 * What runs and what waits, one row each: is it moving (dot and word), which one (id, title), where
 * (its mark on the step columns) and for how long. Model, cost and the agent's sentence are a
 * click away in the drawer. Then the tickets that finished today, quiet, below.
 */
export function BoardRows({ board, now, onOpen, onMore }: { board: Board; now: number; onOpen: (t: Ref) => void; onMore: (status: "queued" | "done") => void }) {
  const { t, lang } = useT();
  const [finishedOpen, setFinishedOpen] = useState(false);
  return (
    <>
      {board.rows.length > 0 && (
        <ul data-now-rows className={`${SUBGRID} divide-y divide-border-subtle`}>
          {board.rows.map(({ ticket: tk, clock }) => {
            const title = ticketTitle(tk, lang);
            const about = tk.plain ?? tk.summary;
            return (
              <li key={tk.ref} data-now-row={tk.ref} className={`${ROW} focus-within:bg-surface-raised hover:bg-surface-raised`}>
                <span className="flex items-center gap-1.5 text-label text-muted">
                  <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${MARK[tk.status] ?? "border border-border-strong"}`} />
                  <span className="@max-4xl:sr-only">{t(`status.${tk.status}`)}</span>
                </span>
                <TicketId id={tk.displayId} url={tk.trackerUrl} />
                <span className="min-w-0 py-2">
                  <button
                    type="button"
                    data-now-open
                    className="block w-full text-left focus-visible:outline-2 focus-visible:outline-accent @4xl:truncate"
                    title={title.unknown ? t("overview.openDetails") : t("overview.titleOpenDetails", { title: `${title.text}${about ? ` — ${about}` : ""}` })}
                    onClick={() => onOpen({ profile: tk.profile, ref: tk.ref })}
                  >
                    <span className={title.unknown ? "text-muted" : ""}>{title.unknown ? t("ticket.untitled") : title.text}</span>
                  </button>
                  <StepName columns={board.columns} step={tk.step} />
                </span>
                <Track columns={board.columns} step={tk.step} mark={tk.status} />
                {clock === "running" ? <Elapsed iso={tk.startedAt} seed={now} className="whitespace-nowrap text-label" /> : <Waiting iso={tk.queuedAt} seed={now} className="whitespace-nowrap text-label text-muted" />}
              </li>
            );
          })}
        </ul>
      )}
      {board.moreQueued > 0 && (
        <button type="button" data-board-more="queued" className={MORE} title={t("board.moreQueuedTitle")} onClick={() => onMore("queued")}>
          {t("board.moreQueued", { count: board.moreQueued })}
        </button>
      )}
      {board.finished.total > 0 && (
        <section data-finished-today className={`${SUBGRID} border-t border-border-subtle pb-1.5`}>
          {/* Closed until asked for: what finished no longer needs you, the count says enough. */}
          <div className="col-span-full flex items-center justify-between gap-2 px-3 pt-1.5">
            <h3 className="text-label font-semibold uppercase tracking-wide text-muted">
              {t("board.finishedToday")} <span className="ml-1 font-mono normal-case">{board.finished.total}</span>
            </h3>
            <ShowHide open={finishedOpen} onToggle={() => setFinishedOpen(!finishedOpen)} controls="finished-today" label={t("board.finishedToday")} data-finished-toggle />
          </div>
          {finishedOpen && (
            <ul id="finished-today" className={SUBGRID}>
              {board.finished.tickets.map((tk) => (
                <FinishedRow key={tk.ref} ticket={tk} now={now} onOpen={onOpen} />
              ))}
            </ul>
          )}
          {finishedOpen && board.finished.total > board.finished.tickets.length && (
            <button type="button" data-board-more="done" className="col-span-full px-3 py-1 text-left text-label text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent" onClick={() => onMore("done")}>
              {t("board.more", { count: board.finished.total - board.finished.tickets.length })}
            </button>
          )}
        </section>
      )}
    </>
  );
}

/** A ticket that finished today: quiet, one line on the board's own columns — it no longer moves. */
function FinishedRow({ ticket: tk, now, onOpen }: { ticket: TicketRow; now: number; onOpen: (t: Ref) => void }) {
  const { t, lang } = useT();
  const title = ticketTitle(tk, lang);
  return (
    <li data-finished-row={tk.ref} className={`${SUBGRID} min-h-8 items-center gap-x-3 px-3 focus-within:bg-surface-raised hover:bg-surface-raised`}>
      <span aria-hidden="true" />
      <TicketId id={tk.displayId} url={tk.trackerUrl} />
      <button
        type="button"
        className="min-w-0 truncate py-1 text-left text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent @4xl:col-start-3 @4xl:col-end-[-3]"
        title={title.unknown ? t("overview.openDetails") : t("overview.titleOpenDetails", { title: title.text })}
        onClick={() => onOpen({ profile: tk.profile, ref: tk.ref })}
      >
        {title.unknown ? t("ticket.untitled") : title.text}
      </button>
      <span className="whitespace-nowrap text-label text-muted">
        <Ago iso={tk.finishedAt} seed={now} />
      </span>
    </li>
  );
}
