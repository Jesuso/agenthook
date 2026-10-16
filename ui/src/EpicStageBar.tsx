import type { EpicBucket, EpicStats } from "./contract";
import { BUCKET_LABEL, BUCKET_ORDER, progressOf, stageSegments } from "./epics";
import { epicSparkline } from "./epicSparkline";

// Full class strings so Tailwind's scanner sees them: status tokens only, no new colours.
export const BUCKET_CLASS: Record<EpicBucket, string> = {
  merged: "bg-status-done",
  finished: "bg-status-done/55",
  running: "bg-status-running",
  needsYou: "bg-status-held",
  backlog: "bg-status-queued/45",
  untracked: "bg-border-strong",
};

/** An epic's tickets as one stacked bar by bucket (`byStage`), with its `N/M` done count. */
export function EpicStageBar({ epic, wide }: { epic: Pick<EpicStats, "byStage" | "total">; wide?: boolean }) {
  const { done, total } = progressOf(epic);
  const segs = stageSegments(epic);
  const title = segs.map((s) => `${BUCKET_LABEL[s.bucket]} ${s.count}`).join(" · ") || "no tickets";
  return (
    <div className="flex min-w-0 items-center gap-2" data-stage-bar>
      <div role="img" aria-label={`${done} of ${total} done — ${title}`} title={title} className={`flex h-2 overflow-hidden rounded-full bg-surface-raised ${wide ? "w-full" : "w-40 shrink-0"}`}>
        {segs.map((s) => (
          <span key={s.bucket} data-seg={s.bucket} className={BUCKET_CLASS[s.bucket]} style={{ width: `${s.pct}%` }} />
        ))}
      </div>
      <span className={`shrink-0 font-mono text-label ${wide ? "" : "w-12"}`} data-progress>
        {done}/{total}
      </span>
    </div>
  );
}

/** The bar's legend: every bucket the epic has, with its count. */
export function StageLegend({ epic }: { epic: Pick<EpicStats, "byStage"> }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-meta text-muted">
      {BUCKET_ORDER.filter((b) => epic.byStage[b] > 0).map((b) => (
        <li key={b} className="flex items-center gap-1">
          <span aria-hidden="true" className={`size-2 rounded-sm ${BUCKET_CLASS[b]}`} />
          {BUCKET_LABEL[b]} <span className="font-mono">{epic.byStage[b]}</span>
        </li>
      ))}
    </ul>
  );
}

const SPARK_W = 168;
const SPARK_H = 32;

/** Tickets finished per day over the velocity window (epicSparkline does the geometry). */
export function EpicSparkline({ days }: { days: EpicStats["velocity"]["days"] }) {
  const m = epicSparkline(days, SPARK_W, SPARK_H);
  return (
    <svg data-chart="epic-velocity" width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} role="img" aria-label={`finished per day over ${days.length} days`}>
      {m.area && <path d={m.area} fill="var(--color-status-done)" fillOpacity={0.15} />}
      {m.line && <path d={m.line} fill="none" stroke="var(--color-status-done)" strokeWidth={1.5} />}
      {m.points.map((p) =>
        p.finished > 0 ? (
          <circle key={p.date} data-point={p.date} cx={p.x} cy={p.y} r={2} fill="var(--color-status-done)">
            <title>{`${p.date}: ${p.finished} finished`}</title>
          </circle>
        ) : null,
      )}
    </svg>
  );
}
