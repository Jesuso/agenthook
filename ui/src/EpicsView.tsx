import { useEffect, useId, useRef, useState } from "react";
import type { EpicResponse, EpicStats, EpicsResponse, ProfileView, TicketRow } from "./contract";
import type { ReleaseOutcome } from "./config";
import { REFETCH_DEBOUNCE_MS, etaLabel, fetchEpic, fetchEpics, splitCompleted } from "./epics";
import type { Loaded } from "./epics";
import { EpicStageBar } from "./EpicStageBar";
import { Count, EpicPage, LiveNote, paceOf } from "./EpicPage";
import { useDisclosure } from "./disclosure";
import { CopyCommand, EmptyState, Pill, ProfileMark, ShortcutSheet, ShortcutsButton } from "./components";
import { profileLabel } from "./format";
import { hashFor } from "./route";
import { EPICS_SHORTCUTS, epicsAction, shortcutsEnabled } from "./shortcuts";

type Ref = { profile: string; ref: string };

const QUIET = "rounded-md px-2 py-1 text-label text-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent";

/**
 * The profile's epics (docs/web-ui.md § Epics view): the list, or one epic's page when `epic` is
 * set. Fetches on open and on Refresh; a ticket SSE event for the profile (`ticketsNonce`) refetches
 * silently after a REFETCH_DEBOUNCE_MS quiet period, and a failed refetch keeps the last good data
 * under the error. No timer polling. One profile at a time (ADR 0001).
 */
export default function EpicsView({ profile, epic, rows, ticketsNonce, onOpen, onRelease, onRetry, onDismiss }: { profile: ProfileView; epic?: string; rows: TicketRow[]; ticketsNonce: number; onOpen: (t: Ref) => void; onRelease?: (t: Ref, comment: string) => Promise<ReleaseOutcome>; onRetry?: (t: Ref) => Promise<ReleaseOutcome>; onDismiss?: (t: Ref) => void }) {
  // Tagged with the route it answers, so a previous route's response (the list, another epic) never renders under this one.
  const [data, setData] = useState<{ route: string; result: Loaded<EpicsResponse | EpicResponse> } | null>(null);
  const [good, setGood] = useState<{ route: string; body: EpicsResponse | EpicResponse } | null>(null);
  const route = `${profile.name}\u0000${epic ?? ""}`;
  const [loading, setLoading] = useState(false);
  // Only a Refresh click shows "Refreshing…": an SSE-driven refetch on a second screen must not flicker.
  const [manual, setManual] = useState(false);
  const [reload, setReload] = useState(0);
  const [help, setHelp] = useState(false);
  const gen = useRef(0);
  const listHref = hashFor({ kind: "profile", profile: profile.name, view: "epics" });
  // The epic last shown, so coming back to the list (u, the back button) refocuses its row.
  const lastEpic = useRef<string | undefined>(epic);
  const [cameFrom, setCameFrom] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (epic === undefined && lastEpic.current !== undefined) setCameFrom(lastEpic.current);
    if (epic !== undefined) setCameFrom(undefined);
    lastEpic.current = epic;
  }, [epic]);

  useEffect(() => {
    const mine = ++gen.current;
    setLoading(true);
    (epic !== undefined ? fetchEpic(profile.name, epic) : fetchEpics(profile.name)).then((r) => {
      if (gen.current !== mine) return; // a newer fetch (or another epic) owns the view
      setData({ route, result: r });
      if (r.kind === "ok") setGood({ route, body: r.body });
      setLoading(false);
      setManual(false);
    });
  }, [profile.name, epic, reload]);

  // Trailing debounce over ticket events: a burst of them refetches once, 2 s after the last.
  const firstNonce = useRef(ticketsNonce);
  useEffect(() => {
    if (ticketsNonce === firstNonce.current) return;
    const t = setTimeout(() => setReload((n) => n + 1), REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [ticketsNonce]);

  const shown = data?.route === route ? data.result : null;
  const error = shown?.kind === "error" ? shown : null;
  const body = shown?.kind === "ok" ? shown.body : good?.route === route ? good.body : null;
  const epicName = body && "epic" in body ? body.epic?.name : undefined;

  useEffect(() => {
    document.title = `${epicName ? `${epicName} · ` : ""}Epics · ${profileLabel(profile)} · agenthook`;
    return () => {
      document.title = "agenthook";
    };
  }, [epicName, profile]);

  useEpicsKeys(setHelp, epic !== undefined ? listHref : null);

  const refresh = () => {
    setManual(true);
    setReload((n) => n + 1);
  };
  const cfg = profile.configPath ? ` --config ${profile.configPath}` : "";

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4" data-epics-view>
      <div className="flex flex-wrap items-center gap-3">
        <ProfileMark p={profile} />
        <h1 className="text-title font-semibold">
          {epic !== undefined ? (
            <a className="rounded-sm text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent focus-visible:outline-2 focus-visible:outline-accent" href={listHref} aria-keyshortcuts="u">
              Epics
            </a>
          ) : (
            "Epics"
          )}{" "}
          <span className="font-normal text-muted">· {profileLabel(profile)}</span>
        </h1>
        <span className="ml-auto flex items-center gap-1">
          <ShortcutsButton onClick={() => setHelp(true)} />
          <button
            type="button"
            data-refresh
            disabled={loading && manual}
            className="rounded-md border border-border px-3 py-1 text-label hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
            onClick={refresh}
          >
            {loading && manual ? "Refreshing…" : "Refresh"}
          </button>
        </span>
      </div>
      <p className="sr-only" role="status" data-epics-status>
        {!body && !error ? "Loading epics…" : loading && manual ? "Refreshing epics…" : ""}
      </p>
      {!body && !error && (
        <p className="text-label text-muted" aria-hidden="true">
          Loading epics…
        </p>
      )}
      {error && (
        <div className="flex flex-col gap-2 rounded-lg border border-status-failed/40 bg-surface px-3 py-2" role="alert" data-epics-error={error.status}>
          <p className="flex flex-wrap items-baseline gap-x-3 text-label text-status-failed">
            {error.message}
            {body && <span className="text-muted">Showing what loaded last.</span>}
            <button type="button" className={`${QUIET} ml-auto`} onClick={refresh}>
              Try again
            </button>
          </p>
          {error.status === 503 && !profile.configMissing && (
            <div className="flex flex-col gap-1">
              <p className="text-label text-muted">Start it, then try again:</p>
              <CopyCommand command={`agenthook start${cfg}`} />
            </div>
          )}
          {error.status === 404 && epic !== undefined && (
            <a className="self-start rounded-sm text-label text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent" href={listHref}>
              Back to all epics
            </a>
          )}
        </div>
      )}
      {body &&
        ("epic" in body ? (
          <EpicPage body={body} profile={profile.name} rows={rows} onOpen={onOpen} actions={{ up: profile.up, onRelease, onRetry, onDismiss }} />
        ) : (
          <EpicsList body={body} profile={profile.name} focusRef={cameFrom} />
        ))}
      {help && <ShortcutSheet rows={EPICS_SHORTCUTS} onClose={() => setHelp(false)} />}
    </div>
  );
}

/**
 * j/k walk the view's `data-epic-nav` targets (epic rows on the list, tickets on an epic's page),
 * focusing each so Enter opens it natively; u goes back to the list; ? shows the sheet. Read-only:
 * nothing here writes, so Release and Re-run stay buttons a click away.
 */
function useEpicsKeys(setHelp: (open: boolean) => void, upHref: string | null) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutsEnabled() ? epicsAction(e, !!document.querySelector('[role="dialog"]')) : null;
      if (!action) return;
      if (action === "help") {
        e.preventDefault();
        return setHelp(true);
      }
      if (action === "up") {
        if (!upHref) return;
        e.preventDefault();
        window.location.hash = upHref.replace(/^#/, "");
        return;
      }
      // Visible targets only: rows folded inside a closed <details> are skipped.
      const targets = [...document.querySelectorAll<HTMLElement>("[data-epics-view] [data-epic-nav]")].filter((t) => t.getClientRects().length > 0);
      if (!targets.length) return;
      e.preventDefault();
      const at = targets.indexOf(document.activeElement as HTMLElement);
      const to = at === -1 ? (action === "next" ? 0 : targets.length - 1) : Math.min(targets.length - 1, Math.max(0, at + (action === "next" ? 1 : -1)));
      targets[to].focus();
      targets[to].scrollIntoView?.({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setHelp, upHref]);
}

/**
 * One row per epic, what needs you first; closed epics last under "Closed (k)", collapsed unless
 * nothing is open (the fold's state is remembered per tab). `focusRef` (the epic just left) gets
 * focus back on return, opening Closed first when its row is in there.
 */
export function EpicsList({ body, profile, focusRef }: { body: EpicsResponse; profile: string; focusRef?: string }) {
  const { open, completed } = body.supported ? splitCompleted(body.epics) : { open: [], completed: [] };
  const [closedOpen, setClosedOpen] = useDisclosure(`${profile}:closed`, open.length === 0);
  const back = focusRef ? completed.some((e) => e.ref === focusRef) : false;
  useEffect(() => {
    if (!focusRef) return;
    if (back && !closedOpen) return setClosedOpen(true); // focus once the row is visible (next run)
    document.querySelector<HTMLElement>(`[data-epic-row="${CSS.escape(focusRef)}"] [data-epic-nav]`)?.focus();
  }, [focusRef, back, closedOpen]);
  if (!body.supported) return <EmptyState title="This tracker has no epics" />;
  // Optional columns take room only when some open epic fills them.
  const needCol = open.some((e) => e.needsYou.length > 0);
  const noteCol = open.some((e) => e.readyToClose || e.eta || paceOf(e).stalled);
  return (
    <div className="flex flex-col gap-3">
      {!body.live && <LiveNote />}
      {body.epics.length === 0 && <EmptyState title="No epics yet" hint={body.live ? undefined : "Only epics a ticket here has run under appear while the receiver is down."} />}
      {open.length > 0 && (
        <ul className="rounded-lg border border-border bg-surface" data-epics-open>
          {open.map((e) => (
            <EpicRow key={e.ref} e={e} profile={profile} needCol={needCol} noteCol={noteCol} />
          ))}
        </ul>
      )}
      {open.length === 0 && completed.length > 0 && (
        <p className="px-3 text-muted" data-no-open-epics>
          No open epics.
        </p>
      )}
      {completed.length > 0 && (
        <details className="group rounded-lg border border-border bg-surface" data-epics-completed open={closedOpen} onToggle={(e) => setClosedOpen(e.currentTarget.open)}>
          <summary className="flex cursor-pointer list-none items-baseline gap-2 rounded-lg px-3 py-2 text-body font-semibold select-none hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent">
            <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3 shrink-0 self-center transition-transform group-open:rotate-90 motion-reduce:transition-none" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4.5 2.5L8 6l-3.5 3.5" />
            </svg>
            Closed
            <Count n={completed.length} noun="epic" />
          </summary>
          <ul className="border-t border-border-subtle">
            {completed.map((e) => (
              <EpicRow key={e.ref} e={e} profile={profile} closed />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Columns: needs-you count (when any open epic has one), id + name, tracker status, stage bar with
 * N/M and what's left, then one note slot (ready to close, ETA, or a stall). The whole row is the
 * link. A closed row drops the bar and the status (the "Closed" header already says it) for a
 * muted ticket count, so closed epics never outweigh open ones.
 */
function EpicRow({ e, profile, closed, needCol, noteCol }: { e: EpicStats; profile: string; closed?: boolean; needCol?: boolean; noteCol?: boolean }) {
  const href = hashFor({ kind: "profile", profile, view: "epics", epic: e.ref });
  const need = e.needsYou.length;
  // The link is what j/k focus and a screen reader names: it carries the row's state by reference.
  const id = useId();
  const described = closed ? `${id}-count` : [need > 0 && `${id}-need`, e.status && `${id}-status`, `${id}-bar`, noteCol && `${id}-note`].filter(Boolean).join(" ");
  return (
    <li
      className="relative flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-subtle px-3 py-2 -outline-offset-2 last:border-b-0 hover:bg-surface-raised has-[[data-epic-nav]:focus-visible]:outline-2 has-[[data-epic-nav]:focus-visible]:outline-accent"
      data-epic-row={e.ref}
    >
      {needCol && (
        <span id={`${id}-need`} className="w-24 shrink-0" data-needs-you={need || undefined}>
          {need > 0 && <Pill tone="held">needs you {need}</Pill>}
        </span>
      )}
      <a
        data-epic-nav
        className={`flex min-w-0 flex-1 basis-56 items-baseline gap-2 after:absolute after:inset-0 after:content-[''] focus-visible:outline-none ${closed ? "text-muted" : "font-medium text-accent"}`}
        href={href}
        aria-describedby={described}
        title={e.name}
      >
        {e.displayId && <span className="shrink-0 font-mono text-label font-normal text-muted">{e.displayId}</span>}
        <span className="truncate">{e.name}</span>
      </a>
      {closed ? (
        <span id={`${id}-count`} className="shrink-0 text-label text-muted" data-closed-count>
          {e.total} {e.total === 1 ? "ticket" : "tickets"}
        </span>
      ) : (
        <>
          <span className="shrink-0 sm:w-28 sm:text-right">{e.status && <span id={`${id}-status`}><span className="sr-only">tracker status </span><Pill>{e.status}</Pill></span>}</span>
          <EpicStageBar epic={e} id={`${id}-bar`} />
          {noteCol && (
            <span id={`${id}-note`} className="w-28 shrink-0 text-label text-muted" data-eta>
              <RowNote e={e} />
            </span>
          )}
        </>
      )}
    </li>
  );
}

/** The note slot: closing is the human's job (neutral, not an all-good green), else the ETA, else a stall. */
function RowNote({ e }: { e: EpicStats }) {
  if (e.readyToClose) return <Pill title="All tickets finished: close this epic on the tracker">ready to close</Pill>;
  const eta = etaLabel(e.eta);
  if (eta) return <>{eta}</>;
  const pace = paceOf(e);
  if (pace.stalled)
    return (
      <span className="font-medium text-fg" data-stalled title="Nothing in this epic has finished lately">
        {pace.since === null ? "no finishes yet" : `stalled ${pace.since} d`}
      </span>
    );
  return null;
}
