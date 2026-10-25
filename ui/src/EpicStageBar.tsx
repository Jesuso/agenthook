import type { EpicBucket, EpicStats } from "./contract";
import { BUCKET_LABEL, BUCKET_ORDER, progressOf } from "./epics";

/** A bar segment: a bucket, or `awaiting` — finished tickets with a known PR not merged yet. */
export type Seg = EpicBucket | "awaiting";

const ORDER: Seg[] = BUCKET_ORDER.flatMap((b): Seg[] => (b === "finished" ? ["finished", "awaiting"] : [b]));

// Full class strings so Tailwind's scanner sees them: status tokens only, no new colours. Merged,
// the furthest state, is the strongest fill; finished is the same hue lighter; awaiting merge is
// hollow (outlined), told apart by shape. It is drawn only on evidence (a recorded PR), never
// for every finished ticket (CONTEXT.md: finished with no recorded PR is just finished).
const FILL: Record<Seg, string> = {
  merged: "bg-status-done",
  finished: "bg-status-done/55",
  awaiting: "bg-status-done-bg ring-1 ring-inset ring-status-done",
  running: "bg-status-running epic-seg-running",
  needsYou: "bg-status-held",
  backlog: "bg-status-queued/70",
  untracked: "bg-border-strong",
};

/** A segment's fill. */
export const segClass = (s: Seg) => FILL[s];

/** A segment's name: the one map every label comes from. */
export const segLabel = (s: Seg) => (s === "awaiting" ? "awaiting merge" : BUCKET_LABEL[s]);

/** Counts per segment: `awaiting` (≤ finished) is split out of finished. */
export function segCounts(epic: Pick<EpicStats, "byStage">, awaiting = 0): Record<Seg, number> {
  const a = Math.min(awaiting, epic.byStage.finished);
  return { ...epic.byStage, finished: epic.byStage.finished - a, awaiting: a };
}

/**
 * An epic's tickets as one stacked bar, the same on the list and the epic page, named "N of M
 * finished: …" for screen readers. `awaiting` (the page knows it from local PR data; the list does
 * not) splits finished into solid and hollow. `wide` fills its row; otherwise it is a fixed-width
 * bar followed by `N/M` and what is left. The running segment slides (`epic-seg-running`, index.css).
 */
export function EpicStageBar({ epic, wide, awaiting = 0, id }: { epic: Pick<EpicStats, "byStage" | "total">; wide?: boolean; awaiting?: number; id?: string }) {
  const { done, total } = progressOf(epic);
  const counts = segCounts(epic, awaiting);
  const segs = ORDER.filter((s) => counts[s] > 0).map((s) => ({ seg: s, count: counts[s], pct: (counts[s] / epic.total) * 100 }));
  const left = epic.byStage.running + epic.byStage.needsYou + epic.byStage.backlog;
  const named = segs.map((s) => `${s.count} ${segLabel(s.seg)}`).join(", ") || "no tickets";
  return (
    <div className={`flex min-w-0 items-center gap-2 ${wide ? "w-full" : ""}`} data-stage-bar>
      <div id={id} role="img" aria-label={`${done} of ${total} finished: ${named}`} title={named} className={`flex gap-px overflow-hidden rounded-full bg-surface-raised ${wide ? "h-3 w-full" : "h-2 w-40 shrink-0"}`}>
        {segs.map((s) => (
          <span key={s.seg} data-seg={s.seg} className={segClass(s.seg)} style={{ width: `${s.pct}%` }} />
        ))}
      </div>
      {!wide && (
        <span className="w-24 shrink-0 whitespace-nowrap text-label" data-progress>
          <span className="font-mono">
            {done}/{total}
          </span>
          {left > 0 && <span className="text-muted">{` · ${left} left`}</span>}
        </span>
      )}
    </div>
  );
}

/** The key to the bar: one swatch per present segment in bar order, with its count unless `quiet`. */
export function StageKey({ counts, quiet }: { counts: Record<Seg, number>; quiet?: boolean }) {
  return (
    <ul className={`flex flex-wrap gap-x-4 gap-y-1 ${quiet ? "text-meta" : "text-label"}`} data-stage-key aria-label="Bar key">
      {ORDER.filter((s) => counts[s] > 0).map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`size-2.5 rounded-sm ${segClass(s)}`} />
          {!quiet && <span className="font-mono">{counts[s]}</span>}
          <span className="text-muted">{segLabel(s)}</span>
        </li>
      ))}
    </ul>
  );
}
