import type { EpicDetailTicket, EpicResponse, TicketRow } from "./contract";
import { BUCKET_LABEL, GROUP_ORDER, etaLabel, groupTickets, perDayLabel, safeUrl } from "./epics";
import { EpicSparkline, EpicStageBar, StageLegend } from "./EpicStageBar";
import { Card, EmptyState, Pill, StatusBadge } from "./components";

type Ref = { profile: string; ref: string };

/**
 * One epic (docs/web-ui.md § Epics view): header, stage bar, Needs you first, velocity, then the
 * rest of its tickets by bucket and an untracked note. A ticket with a local row opens the drawer.
 */
export function EpicPage({ body, profile, rows, onOpen }: { body: EpicResponse; profile: string; rows: TicketRow[]; onOpen: (t: Ref) => void }) {
  const epic = body.epic;
  if (!body.supported || !epic) return <EmptyState title="This tracker has no epics" />;
  const url = safeUrl(epic.url);
  const groups = groupTickets(epic.tickets);
  const local = new Set(rows.filter((r) => r.profile === profile).map((r) => r.ref));
  const eta = etaLabel(epic.eta);
  const list = (tickets: EpicDetailTicket[]) => <TicketList tickets={tickets} local={local} onOpen={(ref) => onOpen({ profile, ref })} />;

  return (
    <div className="flex flex-col gap-4" data-epic-page={epic.ref}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-title font-semibold">{epic.name}</h2>
        {epic.displayId && <span className="font-mono text-label text-muted">{epic.displayId}</span>}
        {epic.status && <Pill>{epic.status}</Pill>}
        {epic.completed && <Pill tone="done">completed</Pill>}
        {url && (
          <a className="text-label text-accent hover:underline" href={url} target="_blank" rel="noopener noreferrer">
            open on the tracker<span aria-hidden="true"> ↗</span>
          </a>
        )}
      </div>
      {!body.live && <LiveNote />}
      {epic.readyToClose && <ReadyToCloseBanner url={url} />}

      <Card>
        <div className="flex flex-col gap-2">
          <EpicStageBar epic={epic} wide />
          <StageLegend epic={epic} />
        </div>
      </Card>

      {groups.needsYou.length > 0 && (
        <Card title={<span className="text-status-held">Needs you · {groups.needsYou.length}</span>}>
          <div data-group="needsYou">{list(groups.needsYou)}</div>
        </Card>
      )}

      <Card title="Velocity">
        <div className="flex flex-wrap items-center gap-4" data-velocity>
          <EpicSparkline days={epic.velocity.days} />
          <span className="text-label">
            <span className="font-mono">{epic.velocity.finished14}</span> finished in {epic.velocity.days.length} d
          </span>
          <span className="text-label text-muted">{perDayLabel(epic.velocity.perDay)}</span>
          {eta && <span className="text-label">ETA {eta}</span>}
        </div>
      </Card>

      {GROUP_ORDER.filter((b) => groups[b].length > 0).map((b) => (
        <Card key={b} title={`${BUCKET_LABEL[b]} · ${groups[b].length}`}>
          <div data-group={b}>{list(groups[b])}</div>
        </Card>
      ))}

      {groups.untracked.length > 0 && (
        <div className="rounded-lg border border-dashed border-border px-3 py-2" data-group="untracked">
          <p className="mb-1 text-label text-muted">Untracked / not on board — no pipeline stage and never ran here:</p>
          {list(groups.untracked)}
        </div>
      )}
      {epic.tickets.length === 0 && <EmptyState title="No tickets in this epic yet" />}
    </div>
  );
}

function TicketList({ tickets, local, onOpen }: { tickets: EpicDetailTicket[]; local: Set<string>; onOpen: (ref: string) => void }) {
  return (
    <ul className="flex flex-col">
      {tickets.map((t) => {
        const inner = (
          <>
            <span className="w-20 shrink-0 font-mono text-label text-muted">{t.displayId ?? t.ref}</span>
            <span className="min-w-0 flex-1 truncate" title={t.name}>
              {t.name}
            </span>
            {t.stage && <span className="shrink-0 text-meta text-muted">{t.stage}</span>}
            {t.status && <StatusBadge status={t.status} />}
          </>
        );
        return (
          <li key={t.ref} data-epic-ticket={t.ref}>
            {local.has(t.ref) ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => onOpen(t.ref)}
              >
                {inner}
              </button>
            ) : (
              <div className="flex items-center gap-2 px-1 py-1">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
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
