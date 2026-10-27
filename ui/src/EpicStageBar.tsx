import type { EpicBucket, EpicStats } from "./contract";
import { BUCKET_LABEL, BUCKET_ORDER, progressOf } from "./epics";
import { translate } from "./i18n";
import { useT } from "./i18n/react";

/** A bar segment is a bucket — no client-side split (ADR 0008: done is the board's flag, one green). */
export type Seg = EpicBucket;

const ORDER: Seg[] = BUCKET_ORDER;

// Full class strings so Tailwind's scanner sees them: status tokens only, no new colours. Done
// (the board says so — ADR 0008) is the one solid fill, the only green.
const FILL: Record<Seg, string> = {
  done: "bg-status-done",
  running: "bg-status-running epic-seg-running",
  needsYou: "bg-status-held",
  backlog: "bg-status-queued/70",
  untracked: "bg-border-strong",
};

/** A segment's fill. */
export const segClass = (s: Seg) => FILL[s];

/** A segment's name: the one map every label comes from. `count` picks the plural form (none = a category: `other`). */
export const segLabel = (s: Seg, lang = "en", count?: number) => translate(lang, BUCKET_LABEL[s], count === undefined ? undefined : { count });

/**
 * An epic's tickets as one stacked bar, the same on the list and the epic page, named "N of M
 * done: …" for screen readers. `wide` fills its row; otherwise it is a fixed-width bar followed by
 * `N/M` and what is left. The running segment slides (`epic-seg-running`, index.css).
 */
export function EpicStageBar({ epic, wide, id }: { epic: Pick<EpicStats, "byStage" | "total">; wide?: boolean; id?: string }) {
  const { t, lang } = useT();
  const { done, total } = progressOf(epic);
  const counts = epic.byStage;
  const segs = ORDER.filter((s) => counts[s] > 0).map((s) => ({ seg: s, count: counts[s], pct: (counts[s] / epic.total) * 100 }));
  const left = total - epic.byStage.done; // the server's `remaining`
  const named = segs.map((s) => `${s.count} ${segLabel(s.seg, lang, s.count)}`).join(", ") || t("epics.noTickets");
  return (
    <div className={`flex min-w-0 items-center gap-2 ${wide ? "w-full" : ""}`} data-stage-bar>
      <div id={id} role="img" aria-label={t("stageBar.aria", { done, total, named })} title={named} className={`flex gap-px overflow-hidden rounded-full bg-surface-raised ${wide ? "h-3 w-full" : "h-2 w-40 shrink-0"}`}>
        {segs.map((s) => (
          <span key={s.seg} data-seg={s.seg} className={segClass(s.seg)} style={{ width: `${s.pct}%` }} />
        ))}
      </div>
      {!wide && (
        <span className="w-24 shrink-0 whitespace-nowrap text-label" data-progress>
          <span className="font-mono">
            {done}/{total}
          </span>
          {left > 0 && <span className="text-muted">{` · ${t("stageBar.left", { count: left })}`}</span>}
        </span>
      )}
    </div>
  );
}

/** The key to the bar: one swatch per present segment in bar order, with its count unless `quiet`. */
export function StageKey({ counts, quiet }: { counts: Record<Seg, number>; quiet?: boolean }) {
  const { t, lang } = useT();
  return (
    <ul className={`flex flex-wrap gap-x-4 gap-y-1 ${quiet ? "text-meta" : "text-label"}`} data-stage-key aria-label={t("stageBar.key")}>
      {ORDER.filter((s) => counts[s] > 0).map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`size-2.5 rounded-sm ${segClass(s)}`} />
          {!quiet && <span className="font-mono">{counts[s]}</span>}
          <span className="text-muted">{segLabel(s, lang, quiet ? undefined : counts[s])}</span>
        </li>
      ))}
    </ul>
  );
}
