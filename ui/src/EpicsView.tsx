import { useEffect, useRef, useState } from "react";
import type { EpicResponse, EpicStats, EpicsResponse, ProfileView, TicketRow } from "./contract";
import { REFETCH_DEBOUNCE_MS, etaLabel, fetchEpic, fetchEpics, splitCompleted } from "./epics";
import type { Loaded } from "./epics";
import { EpicStageBar } from "./EpicStageBar";
import { EpicPage, LiveNote } from "./EpicPage";
import { EmptyState, Pill, ProfileMark } from "./components";
import { profileLabel } from "./format";
import { hashFor } from "./route";

type Ref = { profile: string; ref: string };

/**
 * The profile's epics (docs/web-ui.md § Epics view): the list, or one epic's page when `epic` is
 * set. Fetches on open and on Refresh; a ticket SSE event for the profile (`ticketsNonce`) refetches
 * after a REFETCH_DEBOUNCE_MS quiet period. No timer polling. One profile at a time (ADR 0001).
 */
export default function EpicsView({ profile, epic, rows, ticketsNonce, onOpen }: { profile: ProfileView; epic?: string; rows: TicketRow[]; ticketsNonce: number; onOpen: (t: Ref) => void }) {
  // Tagged with the route it answers, so a previous route's response (the list, another epic) never renders under this one.
  const [data, setData] = useState<{ route: string; result: Loaded<EpicsResponse | EpicResponse> } | null>(null);
  const route = `${profile.name}\u0000${epic ?? ""}`;
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const gen = useRef(0);

  useEffect(() => {
    const mine = ++gen.current;
    setLoading(true);
    (epic !== undefined ? fetchEpic(profile.name, epic) : fetchEpics(profile.name)).then((r) => {
      if (gen.current !== mine) return; // a newer fetch (or another epic) owns the view
      setData({ route, result: r });
      setLoading(false);
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

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4" data-epics-view>
      <div className="flex flex-wrap items-center gap-3">
        <ProfileMark p={profile} />
        <h1 className="text-title font-semibold">
          {epic !== undefined ? (
            <a className="hover:underline" href={hashFor({ kind: "profile", profile: profile.name, view: "epics" })}>
              Epics
            </a>
          ) : (
            "Epics"
          )}{" "}
          <span className="font-normal text-muted">· {profileLabel(profile)}</span>
        </h1>
        <button
          type="button"
          data-refresh
          disabled={loading}
          className="ml-auto rounded-md border border-border px-3 py-1 text-label hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
          onClick={() => setReload((n) => n + 1)}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {!shown && <p className="text-label text-muted">Loading epics…</p>}
      {shown?.kind === "error" && (
        <p className="text-label text-status-failed" role="alert" data-epics-error={shown.status}>
          {shown.message}
        </p>
      )}
      {shown?.kind === "ok" &&
        ("epic" in shown.body ? (
          <EpicPage body={shown.body} profile={profile.name} rows={rows} onOpen={onOpen} />
        ) : (
          <EpicsList body={shown.body} profile={profile.name} />
        ))}
    </div>
  );
}

/** One row per epic; completed epics last, dimmed, under a "Completed (k)" disclosure. */
export function EpicsList({ body, profile }: { body: EpicsResponse; profile: string }) {
  if (!body.supported) return <EmptyState title="This tracker has no epics" />;
  const { open, completed } = splitCompleted(body.epics);
  return (
    <div className="flex flex-col gap-3">
      {!body.live && <LiveNote />}
      {body.epics.length === 0 && <EmptyState title="No epics yet" hint={body.live ? undefined : "Only epics a ticket here has run under appear while the receiver is down."} />}
      {open.length > 0 && (
        <ul className="rounded-lg border border-border bg-surface" data-epics-open>
          {open.map((e) => (
            <EpicRow key={e.ref} e={e} profile={profile} />
          ))}
        </ul>
      )}
      {completed.length > 0 && (
        <details className="rounded-lg border border-border bg-surface" data-epics-completed>
          <summary className="cursor-pointer select-none px-3 py-2 text-label font-semibold uppercase tracking-wide text-muted">Completed ({completed.length})</summary>
          <ul className="opacity-60">
            {completed.map((e) => (
              <EpicRow key={e.ref} e={e} profile={profile} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function EpicRow({ e, profile }: { e: EpicStats; profile: string }) {
  const href = hashFor({ kind: "profile", profile, view: "epics", epic: e.ref });
  const eta = etaLabel(e.eta);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-subtle px-3 py-2 last:border-b-0" data-epic-row={e.ref}>
      <a className="min-w-0 flex-1 basis-56 truncate font-medium text-accent hover:underline" href={href} title={e.name}>
        {e.name}
      </a>
      <span className="w-28 shrink-0 text-right">{e.status && <Pill>{e.status}</Pill>}</span>
      <EpicStageBar epic={e} />
      {e.readyToClose && (
        <Pill tone="done" title="All tickets finished — close this epic on the tracker">
          ready to close
        </Pill>
      )}
      <span className="w-24 shrink-0">
        {e.needsYou.length > 0 && (
          <a href={href} data-needs-you={e.needsYou.length} title={`${e.needsYou.length} ticket(s) need you`}>
            <Pill tone="held">needs you {e.needsYou.length}</Pill>
          </a>
        )}
      </span>
      <span className="w-28 shrink-0 text-label text-muted" data-eta>
        {eta ?? ""}
      </span>
    </li>
  );
}
