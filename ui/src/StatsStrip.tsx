import { Suspense, lazy, useEffect, useState } from "react";
import type { StatsView } from "./contract";
import { Segmented } from "./components";
import type { FeedEntry } from "./feed";
import { formatSpend } from "./format";
import { formatEnergy } from "../../src/energy.js";
import { DEFAULT_RANGE, RANGES, latestChange, shortDate, statsUrl, summarizeStats } from "./stats";
import type { Range } from "./stats";

// d3 (scales + shapes) ships in its own chunk, not the main bundle.
const StatsChart = lazy(() => import("./StatsChart"));

/**
 * Day-by-day history under the Progress tiles (docs/web-ui.md § Daily stats): tickets finished
 * and cost per day, with a 7 / 14 / 30 day range. Derived server-side from the profile's whole
 * events log, so it reaches back far beyond the ~48 h the tiles above can see.
 */
export function StatsStrip({ profile, feed }: { profile: string; feed: FeedEntry[] }) {
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const [stats, setStats] = useState<StatsView | null>(null);
  const [failed, setFailed] = useState(false);
  // Refetch when something that changes the numbers arrives (run_end, pipeline_done, …).
  const changed = latestChange(feed);

  useEffect(() => {
    let live = true;
    fetch(statsUrl(profile, range))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((b: StatsView) => live && (setStats(b), setFailed(false)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [profile, range, changed]);

  const days = stats?.days ?? [];
  const sum = summarizeStats(days);
  return (
    <div data-stats className="mt-3 rounded-lg border border-border bg-surface px-3 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-label font-semibold uppercase tracking-wide text-muted">History</span>
        <span className="ml-auto">
          <Segmented value={String(range) as `${Range}`} options={RANGES.map((r) => ({ value: String(r) as `${Range}`, label: `${r}d` }))} onChange={(v) => setRange(Number(v) as Range)} />
        </span>
      </div>
      {failed && !stats ? (
        <p className="text-label text-muted">Couldn&apos;t load the history.</p>
      ) : (
        <>
          <p className="mb-1 font-mono text-label" data-stats-total>
            {sum.finished} finished <span className="text-muted">({sum.avgFinished.toFixed(1)}/day)</span> · {formatSpend({ reported: sum.costUsd, est: sum.estUsd }) || "$0"}
            {sum.finished > 0 && sum.costUsd + sum.estUsd > 0 && <span className="text-muted"> ({formatSpend({ reported: sum.costUsd / sum.finished, est: sum.estUsd / sum.finished })}/ticket)</span>}
            {sum.energyKwh > 0 && <span className="text-muted" data-stats-energy> · {formatEnergy(sum)}</span>}
            {sum.unestimatedRuns > 0 && <span className="text-muted" data-stats-unestimated> · {sum.unestimatedRuns} run{sum.unestimatedRuns === 1 ? "" : "s"} no estimate</span>}
          </p>
          <Suspense fallback={<div className="h-[210px]" aria-hidden="true" />}>
            <StatsChart days={days} />
          </Suspense>
          <p className="mt-2 text-meta text-muted" data-stats-foot>
            {sum.reworkRate !== null ? `Rework ${Math.round(sum.reworkRate * 100)}% of ${sum.runs} runs` : `${sum.runs} runs`}
            {sum.bestDay ? ` · best day ${shortDate(sum.bestDay.date)} (${sum.bestDay.finished})` : ""}
            {stats?.since ? ` · history since ${shortDate(stats.since.slice(0, 10))}` : ""}
          </p>
        </>
      )}
    </div>
  );
}
