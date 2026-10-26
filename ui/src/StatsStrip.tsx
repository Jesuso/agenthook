import { Suspense, lazy, useEffect, useState } from "react";
import type { StatsView } from "./contract";
import { Segmented, ShowHide } from "./components";
import type { FeedEntry } from "./feed";
import { formatSpend } from "./format";
import { formatEnergy } from "../../src/energy.js";
import { DEFAULT_RANGE, RANGES, latestChange, shortDate, statsUrl, summarizeStats } from "./stats";
import type { Range } from "./stats";
import { useT } from "./i18n/react";

// d3 (scales + shapes) ships in its own chunk, not the main bundle.
const StatsChart = lazy(() => import("./StatsChart"));

/**
 * Day-by-day history under the Progress tiles (docs/web-ui.md § Daily stats): tickets finished
 * and cost per day, with a 7 / 14 / 30 day range. Derived server-side from the profile's whole
 * events log, so it reaches back far beyond the ~48 h the tiles above can see.
 */
export function StatsStrip({ profile, feed }: { profile: string; feed: FeedEntry[] }) {
  const { t, lang } = useT();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  // The chart is a drill-down: collapsed, the one-line total says enough for a glance.
  const [open, setOpen] = useState(false);
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
        <span className="text-label font-semibold uppercase tracking-wide text-muted">{t("stats.history")}</span>
        <span className="ml-auto flex items-center gap-2">
          <Segmented value={String(range) as `${Range}`} options={RANGES.map((r) => ({ value: String(r) as `${Range}`, label: t("stats.days", { count: r }) }))} onChange={(v) => setRange(Number(v) as Range)} />
          <ShowHide open={open} onToggle={() => setOpen(!open)} controls="stats-chart" label={t("stats.chartLabel")} data-stats-toggle />
        </span>
      </div>
      {failed && !stats ? (
        <p className="text-label text-muted">{t("stats.loadFailed")}</p>
      ) : (
        <>
          <p className="font-mono text-label" data-stats-total>
            {t("stats.finished", { count: sum.finished })} <span className="text-muted">{t("stats.perDay", { avg: sum.avgFinished.toFixed(1) })}</span> · {formatSpend({ reported: sum.costUsd, est: sum.estUsd }) || "$0"}
            {sum.finished > 0 && sum.costUsd + sum.estUsd > 0 && <span className="text-muted"> {t("stats.perTicket", { spend: formatSpend({ reported: sum.costUsd / sum.finished, est: sum.estUsd / sum.finished }) })}</span>}
            {sum.energyKwh > 0 && <span className="text-muted" data-stats-energy> · {formatEnergy(sum)}</span>}
            {sum.unestimatedRuns > 0 && <span className="text-muted" data-stats-unestimated> · {t("stats.noEstimate", { count: sum.unestimatedRuns })}</span>}
          </p>
          {open && (
            <div id="stats-chart" className="mt-1">
              <Suspense fallback={<div className="h-[210px]" aria-hidden="true" />}>
                <StatsChart days={days} />
              </Suspense>
              <p className="mt-2 text-meta text-muted" data-stats-foot>
                {sum.reworkRate !== null ? t("stats.reworkFoot", { range, pct: Math.round(sum.reworkRate * 100), runs: sum.runs }) : t("stats.runsFoot", { runs: sum.runs, range })}
                {sum.bestDay ? ` · ${t("stats.bestDay", { date: shortDate(sum.bestDay.date, lang), count: sum.bestDay.finished })}` : ""}
                {stats?.since ? ` · ${t("stats.historySince", { date: shortDate(stats.since.slice(0, 10), lang) })}` : ""}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
