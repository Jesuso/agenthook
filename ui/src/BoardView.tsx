import { useEffect, useState } from "react";
import type { ProfileView, TicketRow, TicketStatus } from "./contract";
import type { Discover, StageKeys, StageOption } from "./configEdit";
import { discoverUrl, readSteps, stageKeysFor } from "./configEdit";
import { configUrl, parseCheck } from "./config";
import type { ReleaseOutcome } from "./config";
import { MARGIN, STEP_GAP, layoutPipeline, STAGE_H } from "./pipelineGraph";
import type { GraphEdge, PipelineLayout } from "./pipelineGraph";
import { EDGE_LABEL, EDGE_STYLE, Legend } from "./PipelineGraph";
import { boardSections } from "./board";
import type { BoardEntry, BoardSection } from "./board";
import { harnessAttention, needsYouItems } from "./zones";
import { NeedsYouZone } from "./NeedsYouZone";
import type { Ref } from "./NeedsYouZone";
import { ticketTitle } from "./format";
import { dismissKey } from "./deferredDismiss";
import { Elapsed, TicketId, Waiting } from "./components";
import { useT } from "./i18n/react";

/**
 * The profile Board (#697 ticket 1 of 3): every pipeline step as a fixed-size box holding its
 * running/queued tickets, joined by the Config graph's own connectors, with Needs you fixed above
 * it. Motion (path transitions as a ticket advances) is #696 ticket 2 — this view just re-renders
 * on the next snapshot/SSE update like the rest of the page.
 */

const BOARD_STEP_W = 240;
const BOARD_STEP_H = 216;
const LG_QUERY = "(min-width: 1024px)";
const GRID_SIZE = 24;
/** The blueprint look (#697): a fine grid at `--color-border-subtle` — the same hairline tone
 * the rest of the board already uses, so this isn't a new token. */
const GRID_BG: React.CSSProperties = {
  backgroundImage: "linear-gradient(to right, var(--color-border-subtle) 1px, transparent 1px), linear-gradient(to bottom, var(--color-border-subtle) 1px, transparent 1px)",
  backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
};

/** Full literal classes (Tailwind's scanner needs them written out, not built from a template). */
const STATUS_ACCENT: Partial<Record<TicketStatus, string>> = {
  running: "border-l-status-running",
  queued: "border-l-status-queued",
  interrupted: "border-l-status-interrupted",
  stalled: "border-l-status-stalled",
  done: "border-l-status-done",
};

type ConfigState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ok"; steps: Record<string, unknown>[]; keys: StageKeys | null; stages: StageOption[] | null; defaultAgent?: unknown };

/** `GET /api/config` → `readSteps`/`stageKeysFor` (ConfigView's own calls, #697 reuses them — no
 * new endpoint); stage labels from `/api/discover` only while the profile is up. */
function useBoardConfig(profileName: string, up: boolean, lang: string): ConfigState {
  const [state, setState] = useState<ConfigState>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    fetch(configUrl(profileName))
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { text: string }) => {
        if (!live) return;
        const parsed = parseCheck(body.text, lang);
        if (!parsed.ok) return setState({ kind: "error" });
        const raw = parsed.raw as Record<string, unknown>;
        const steps = readSteps(raw);
        const trackerType = (raw.tracker as Record<string, unknown> | undefined)?.type;
        const defaultAgent = raw.agent;
        if (!up) {
          setState({ kind: "ok", steps, keys: stageKeysFor(null, trackerType), stages: null, defaultAgent });
          return;
        }
        fetch(discoverUrl(profileName))
          .then((res) => (res.ok ? res.json() : null))
          .then((discover: Discover | null) => {
            if (!live) return;
            setState({ kind: "ok", steps, keys: stageKeysFor(discover ?? null, trackerType), stages: discover?.stages ?? null, defaultAgent });
          })
          .catch(() => live && setState({ kind: "ok", steps, keys: stageKeysFor(null, trackerType), stages: null, defaultAgent }));
      })
      .catch(() => live && setState({ kind: "error" }));
    return () => {
      live = false;
    };
  }, [profileName, up, lang]);
  return state;
}

/** `(min-width: 1024px)` — `lg`, the breakpoint below which the Board stacks and drops the SVG
 * connectors + legend (#697 acceptance). Mirrors `useReducedMotion`'s matchMedia pattern. */
function useWide(): boolean {
  const query = () => (typeof matchMedia === "function" ? matchMedia(LG_QUERY) : null);
  const [wide, setWide] = useState(() => query()?.matches ?? true);
  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const onChange = () => setWide(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

export type BoardViewProps = {
  profile: ProfileView;
  /** Already scoped to `profile` (Overview's `scoped.tickets`). */
  tickets: TicketRow[];
  now: number;
  onOpen: (t: Ref) => void;
  /** "+N more" on a step/other section: switch the Table tab to this step filter. */
  onStepFilter: (step: string) => void;
  dismissing?: ReadonlySet<string>;
  onDismiss: (t: Ref) => void;
  onRelease: (t: Ref, comment: string) => Promise<ReleaseOutcome>;
  onRetry: (t: Ref) => Promise<ReleaseOutcome>;
  onRecheck?: (profile: string, ref: string | null) => Promise<ReleaseOutcome>;
  onCloseOnBoard?: (t: Ref) => Promise<ReleaseOutcome>;
};

export function BoardView(props: BoardViewProps) {
  const { profile, tickets, now, onOpen, onStepFilter } = props;
  const { t, lang } = useT();
  const wide = useWide();
  const config = useBoardConfig(profile.name, profile.up, lang);
  const forge = !!profile.forge;
  const needs = needsYouItems(tickets, forge, lang).filter((n) => !props.dismissing?.has(dismissKey(n.ticket)));
  const attention = harnessAttention(profile);

  if (config.kind === "loading") return <p className="p-3 text-label text-muted">{t("app.loading")}</p>;
  if (config.kind === "error") return <p className="p-3 text-label text-status-failed">{t("board.unavailable")}</p>;

  const layout = layoutPipeline(config.steps, config.keys, config.stages, config.defaultAgent, lang, { stepW: BOARD_STEP_W, stepH: BOARD_STEP_H });
  const stepIds = layout.nodes.filter((n) => n.kind === "step").map((n) => n.id);
  const { steps, other, doneToday } = boardSections(tickets, stepIds, now, forge);
  const sectionOf = new Map<string, BoardSection>(steps.map((s) => [s.id, s]));

  const ordered = [...steps, ...(other ? [other] : []), doneToday.section];

  // Other/Done today aren't pipeline nodes — they sit in their own column to the right of the
  // last step, stacked top to bottom, not part of layoutPipeline's own geometry.
  const lastStep = [...layout.nodes].reverse().find((n) => n.kind === "step");
  const extraX = layout.width - MARGIN + STEP_GAP;
  const extraTop = lastStep?.y ?? MARGIN;
  const extras = [...(other ? [other] : []), doneToday.section];
  const extraYAt = (i: number) => extraTop + i * (BOARD_STEP_H + STEP_GAP);
  const boardWidth = extraX + BOARD_STEP_W + MARGIN;
  const boardHeight = Math.max(layout.height, extraTop + extras.length * (BOARD_STEP_H + STEP_GAP) - STEP_GAP + MARGIN);

  return (
    <div className="flex flex-col gap-4" data-board>
      {(attention.length + needs.length > 0) && (
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
        />
      )}

      {wide ? (
        <div className="overflow-auto" data-board-wide>
          <div className="relative" style={{ width: boardWidth, height: boardHeight, ...GRID_BG }}>
            <svg className="absolute left-0 top-0" width={boardWidth} height={boardHeight} aria-hidden="true">
              {layout.edges.map((e, i) => <BoardEdge key={i} edge={e} route={layout.routes[i]} />)}
            </svg>
            {layout.nodes.map((n) =>
              n.kind === "step" ? (
                <StepBox key={n.id} id={n.id} x={n.x} y={n.y} w={BOARD_STEP_W} h={BOARD_STEP_H} section={sectionOf.get(n.id)} step={config.steps[stepIds.indexOf(n.id)]} profile={profile} now={now} onOpen={onOpen} onStepFilter={onStepFilter} />
              ) : (
                <div key={`g:${n.id}`} data-board-stage={n.id} className="absolute flex items-center justify-center rounded-full border border-border bg-surface px-2 text-label text-muted" style={{ left: n.x, top: n.y, width: n.w, height: STAGE_H }} title={n.label}>
                  <span className="truncate">{n.label}</span>
                </div>
              ),
            )}
            {extras.map((s, i) => (
              <div key={s.id} className="absolute rounded-lg border border-border bg-surface" style={{ left: extraX, top: extraYAt(i), width: BOARD_STEP_W, height: BOARD_STEP_H }} data-board-section={s.id}>
                <SectionHeader id={s.id} section={s} step={undefined} profile={profile} doneTotal={s.kind === "done" ? doneToday.total : undefined} />
                <SectionEntries section={s} now={now} onOpen={onOpen} onStepFilter={onStepFilter} />
              </div>
            ))}
          </div>
          <Legend />
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-board-narrow>
          {ordered.map((s) => {
            if (s.kind === "step") {
              const idx = stepIds.indexOf(s.id);
              return <SectionBox key={s.id} section={s} step={config.steps[idx]} profile={profile} now={now} onOpen={onOpen} onStepFilter={onStepFilter} />;
            }
            if (s.kind === "other") return <SectionBox key={s.id} section={s} profile={profile} now={now} onOpen={onOpen} onStepFilter={onStepFilter} />;
            return <SectionBox key={s.id} section={s} profile={profile} now={now} onOpen={onOpen} onStepFilter={onStepFilter} doneTotal={doneToday.total} />;
          })}
        </div>
      )}
    </div>
  );
}

/** A straight-polyline rendering of a route (no bend rounding — the Board's sections are always
 * the same size, so the simpler path reads clearly at this scale); colour/dash from the shared
 * `EDGE_STYLE`, same as the Config graph. */
function BoardEdge({ edge, route }: { edge: GraphEdge; route: PipelineLayout["routes"][number] }) {
  const { t } = useT();
  const style = EDGE_STYLE[edge.type];
  const d = route.control
    ? `M${route.points[0].x},${route.points[0].y} Q${route.control.x},${route.control.y} ${route.points[1].x},${route.points[1].y}`
    : route.points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  return (
    <path d={d} fill="none" stroke={style.stroke} strokeWidth={1.5} strokeDasharray={style.dash}>
      <title>{edge.label ?? t(EDGE_LABEL[edge.type])}</title>
    </path>
  );
}

function harnessNames(step: Record<string, unknown> | undefined): string[] {
  const h = step?.harness;
  if (typeof h === "string") return [h];
  if (Array.isArray(h)) return h.filter((x): x is string => typeof x === "string");
  return [];
}

function StepBox({ id, x, y, w, h, section, step, profile, now, onOpen, onStepFilter }: { id: string; x: number; y: number; w: number; h: number; section: BoardSection | undefined; step: Record<string, unknown> | undefined; profile: ProfileView; now: number; onOpen: (t: Ref) => void; onStepFilter: (step: string) => void }) {
  return (
    <div className="absolute rounded-lg border border-border bg-surface" style={{ left: x, top: y, width: w, height: h }} data-board-section={id}>
      <SectionHeader id={id} section={section} step={step} profile={profile} />
      <SectionEntries section={section} now={now} onOpen={onOpen} onStepFilter={onStepFilter} />
    </div>
  );
}

/** The narrow (below `lg`) stacked rendering: the same section anatomy, no absolute positioning. */
function SectionBox({ section, profile, step, now, onOpen, onStepFilter, doneTotal }: { section: BoardSection; profile: ProfileView; step?: Record<string, unknown>; now: number; onOpen: (t: Ref) => void; onStepFilter: (step: string) => void; doneTotal?: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface" data-board-section={section.id}>
      <SectionHeader id={section.id} section={section} step={step} profile={profile} doneTotal={doneTotal} />
      <SectionEntries section={section} now={now} onOpen={onOpen} onStepFilter={onStepFilter} />
    </div>
  );
}

function SectionHeader({ id, section, step, profile, doneTotal }: { id: string; section: BoardSection | undefined; step: Record<string, unknown> | undefined; profile: ProfileView; doneTotal?: number }) {
  const { t } = useT();
  const names = harnessNames(step);
  return (
    <div className="flex items-center gap-2 border-b border-border-subtle px-2 py-1.5">
      <span className="truncate font-mono text-label font-semibold" data-done-count={section?.kind === "done" ? (doneTotal ?? 0) : undefined}>
        {section?.kind === "other" ? t("board.other") : section?.kind === "done" ? t("board.doneToday", { count: doneTotal ?? 0 }) : id}
      </span>
      {section && section.kind === "step" && (
        <span className="ml-auto shrink-0 text-meta text-muted">
          {section.runningCount} {t("status.running")} · {section.queuedCount} {t("status.queued")}
        </span>
      )}
      {names.length > 0 && (
        <span className="flex shrink-0 items-center gap-1 text-meta text-muted">
          {names.map((name) => {
            const hs = profile.harnesses?.[name];
            return (
              <span key={name} className="rounded border border-border px-1 font-mono">
                {name} {hs?.active ?? 0}/{hs?.max ?? "∞"}
              </span>
            );
          })}
        </span>
      )}
    </div>
  );
}

function SectionEntries({ section, now, onOpen, onStepFilter }: { section: BoardSection | undefined; now: number; onOpen: (t: Ref) => void; onStepFilter: (step: string) => void }) {
  const { t } = useT();
  if (!section) return null;
  return (
    <div className="flex flex-col divide-y divide-border-subtle">
      {section.entries.map((e) => <BoardRow key={e.ticket.ref} entry={e} now={now} onOpen={onOpen} />)}
      {section.moreCount > 0 && section.kind !== "done" && (
        <button
          type="button"
          className="px-2 py-1 text-left text-label text-accent hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
          title={t("board.moreTitle", { count: section.moreCount, step: section.id })}
          onClick={() => onStepFilter(section.id)}
        >
          {t("board.more", { count: section.moreCount })}
        </button>
      )}
    </div>
  );
}

function BoardRow({ entry, now, onOpen }: { entry: BoardEntry; now: number; onOpen: (t: Ref) => void }) {
  const { t, lang } = useT();
  const { ticket: tk, clock } = entry;
  const title = ticketTitle(tk, lang);
  const open = () => onOpen({ profile: tk.profile, ref: tk.ref });
  return (
    <div
      role="button"
      tabIndex={0}
      data-board-entry={tk.ref}
      className={`flex items-center gap-2 border-l-4 px-2 py-1 text-left focus-visible:outline-2 focus-visible:outline-accent hover:bg-surface-raised ${STATUS_ACCENT[tk.status] ?? "border-l-border"}`}
      title={title.unknown ? t("ticket.untitled") : title.text}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        open();
      }}
    >
      <span onClick={(e) => e.stopPropagation()}>
        <TicketId id={tk.displayId} url={tk.trackerUrl} />
      </span>
      <span className={`min-w-0 flex-1 truncate text-label ${title.unknown ? "text-muted" : ""}`}>{title.unknown ? t("ticket.untitled") : title.text}</span>
      {clock === "running" && <Elapsed iso={tk.startedAt} seed={now} className="shrink-0 text-meta" />}
      {clock === "queued" && <Waiting iso={tk.queuedAt} seed={now} className="shrink-0 text-meta text-muted" />}
    </div>
  );
}
