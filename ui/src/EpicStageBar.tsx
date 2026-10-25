import type { EpicBucket, EpicStats } from "./contract";
import { BUCKET_LABEL, BUCKET_ORDER, progressOf, stageSegments } from "./epics";

// Full class strings so Tailwind's scanner sees them: status tokens only, no new colours. With a
// forge, finished means "PR not merged yet", so it is drawn hollow (outlined) beside solid merged:
// the same done hue, never dimmed, told apart by shape rather than by a second green.
const FILL: Record<EpicBucket, string> = {
  merged: "bg-status-done",
  finished: "bg-status-done",
  running: "bg-status-running epic-seg-running",
  needsYou: "bg-status-held",
  backlog: "bg-status-queued/70",
  untracked: "bg-border-strong",
};
const HOLLOW = "bg-status-done-bg ring-1 ring-inset ring-status-done";

/** A bucket's fill; `forge` draws finished hollow (awaiting merge). */
export const bucketClass = (b: EpicBucket, forge: boolean) => (b === "finished" && forge ? HOLLOW : FILL[b]);

/** A bucket's name, the one map every label comes from; with a forge, finished reads "awaiting merge". */
export const bucketLabel = (b: EpicBucket, forge: boolean) => (b === "finished" && forge ? "awaiting merge" : BUCKET_LABEL[b]);

/**
 * An epic's tickets as one stacked bar by bucket, the same on the list and the epic page, named
 * "N of M finished: …" for screen readers. `wide` fills its row; otherwise it is a fixed-width bar
 * followed by `N/M` and what is left. The running segment slides (`epic-seg-running`, index.css).
 */
export function EpicStageBar({ epic, wide, forge = false, id }: { epic: Pick<EpicStats, "byStage" | "total">; wide?: boolean; forge?: boolean; id?: string }) {
  const { done, total } = progressOf(epic);
  const segs = stageSegments(epic);
  const left = epic.byStage.running + epic.byStage.needsYou + epic.byStage.backlog;
  const named = segs.map((s) => `${s.count} ${bucketLabel(s.bucket, forge)}`).join(", ") || "no tickets";
  return (
    <div className={`flex min-w-0 items-center gap-2 ${wide ? "w-full" : ""}`} data-stage-bar>
      <div id={id} role="img" aria-label={`${done} of ${total} finished: ${named}`} title={named} className={`flex gap-px overflow-hidden rounded-full bg-surface-raised ${wide ? "h-3 w-full" : "h-2 w-40 shrink-0"}`}>
        {segs.map((s) => (
          <span key={s.bucket} data-seg={s.bucket} className={bucketClass(s.bucket, forge)} style={{ width: `${s.pct}%` }} />
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

/** The key to the bar: one swatch per bucket in `buckets`, each with its count when `counts` is given. */
export function StageKey({ buckets, forge = false, counts }: { buckets: EpicBucket[]; forge?: boolean; counts?: Record<EpicBucket, number> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-label" data-stage-key>
      {BUCKET_ORDER.filter((b) => buckets.includes(b)).map((b) => (
        <li key={b} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`size-2.5 rounded-sm ${bucketClass(b, forge)}`} />
          {counts && <span className="font-mono">{counts[b]}</span>}
          <span className="text-muted">{bucketLabel(b, forge)}</span>
        </li>
      ))}
    </ul>
  );
}
