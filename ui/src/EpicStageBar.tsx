import type { EpicBucket, EpicStats } from "./contract";
import { BUCKET_LABEL, BUCKET_ORDER, progressOf } from "./epics";
import { translate } from "./i18n";
import { useT } from "./i18n/react";

/** A bar segment: a bucket, or `awaiting` — done tickets whose known PR is still open. */
export type Seg = EpicBucket | "awaiting";

const ORDER: Seg[] = BUCKET_ORDER.flatMap((b): Seg[] => (b === "done" ? ["done", "awaiting"] : [b]));

// Full class strings so Tailwind's scanner sees them: status tokens only, no new colours. Done
// (the board says so — ADR 0008) is the one solid fill; a done ticket whose PR is still open is
// hollow (outlined), told apart by shape. It is drawn only on evidence (a recorded PR), never
// for every done ticket (CONTEXT.md: done with no recorded PR is just done).
const FILL: Record<Seg, string> = {
  done: "bg-status-done",
  awaiting: "bg-status-done-bg ring-1 ring-inset ring-status-done",
  running: "bg-status-running epic-seg-running",
  needsYou: "bg-status-held",
  backlog: "bg-status-queued/70",
  untracked: "bg-border-strong",
};

/** A segment's fill. */
export const segClass = (s: Seg) => FILL[s];

/** A segment's name: the one map every label comes from. `count` picks the plural form (none = a category: `other`). */
export const segLabel = (s: Seg, lang = "en", count?: number) => translate(lang, s === "awaiting" ? "stageBar.awaiting" : BUCKET_LABEL[s], count === undefined ? undefined : { count });

/** Counts per segment: `awaiting` (≤ done) is split out of done. */
export function segCounts(epic: Pick<EpicStats, "byStage">, awaiting = 0): Record<Seg, number> {
  const a = Math.min(awaiting, epic.byStage.done);
  return { ...epic.byStage, done: epic.byStage.done - a, awaiting: a };
}

/**
 * An epic's tickets as one stacked bar, the same on the list and the epic page, named "N of M
 * done: …" for screen readers. `awaiting` (the page knows it from local PR data; the list does
 * not) splits done into solid and hollow. `wide` fills its row; otherwise it is a fixed-width
 * bar followed by `N/M` and what is left. The running segment slides (`epic-seg-running`, index.css).
 */
export function EpicStageBar({ epic, wide, awaiting = 0, id }: { epic: Pick<EpicStats, "byStage" | "total">; wide?: boolean; awaiting?: number; id?: string }) {
  const { t, lang } = useT();
  const { done, total } = progressOf(epic);
  const counts = segCounts(epic, awaiting);
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
