import type { EpicBucket, EpicStats } from "./contract";
import { BUCKET_LABEL, progressOf, stageSegments } from "./epics";

// Full class strings so Tailwind's scanner sees them: status tokens only, no new colours.
// merged and finished share one fill (both are "done") so N/M and the bar agree; a divider
// between them (below) keeps the two legible without dimming either.
export const BUCKET_CLASS: Record<EpicBucket, string> = {
  merged: "bg-status-done",
  finished: "bg-status-done",
  running: "bg-status-running",
  needsYou: "bg-status-held",
  backlog: "bg-status-queued/45",
  untracked: "bg-border-strong",
};

/** An epic's tickets as one stacked bar by bucket (`byStage`), with its `N/M` done count. The
 * running segment carries `epic-seg-running` (index.css): a sliding stripe, so it reads as in progress. */
export function EpicStageBar({ epic, wide }: { epic: Pick<EpicStats, "byStage" | "total">; wide?: boolean }) {
  const { done, total } = progressOf(epic);
  const segs = stageSegments(epic);
  const title = segs.map((s) => `${BUCKET_LABEL[s.bucket]} ${s.count}`).join(" · ") || "no tickets";
  return (
    <div className="flex min-w-0 items-center gap-2" data-stage-bar>
      <div role="img" aria-label={`${done} of ${total} finished — ${title}`} title={title} className={`flex h-2 overflow-hidden rounded-full bg-surface-raised ${wide ? "w-full" : "w-40 shrink-0"}`}>
        {segs.map((s, i) => {
          const divider = s.bucket === "finished" && segs[i - 1]?.bucket === "merged" ? " border-l border-surface" : "";
          const cls = s.bucket === "running" ? `${BUCKET_CLASS.running} epic-seg-running` : BUCKET_CLASS[s.bucket];
          return <span key={s.bucket} data-seg={s.bucket} className={`${cls}${divider}`} style={{ width: `${s.pct}%` }} />;
        })}
      </div>
      <span className={`shrink-0 font-mono text-label ${wide ? "" : "w-12"}`} data-progress>
        {done}/{total}
      </span>
    </div>
  );
}
