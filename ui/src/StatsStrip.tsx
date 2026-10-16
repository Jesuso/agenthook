import { useEffect, useState } from "react";
import type { DayStats, StatsView } from "./contract";
import { Segmented } from "./components";
import type { FeedEntry } from "./feed";
import { formatCost } from "./format";
import { DEFAULT_RANGE, RANGES, barHeights, latestChange, shortDate, statsUrl, summarizeStats, weekdayLetter } from "./stats";
import type { Range } from "./stats";

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
          <Bars title="Finished" days={days} value={(d) => d.finished} format={(n) => String(n)} total={`${sum.finished} · ${sum.avgFinished.toFixed(1)}/day`} />
          <Bars title="Cost" days={days} value={(d) => d.costUsd} format={(n) => (n ? formatCost(n) : "$0")} total={sum.costUsd ? formatCost(sum.costUsd) : "—"} />
          <p className="mt-2 text-meta text-faint" data-stats-foot>
            {sum.reworkRate !== null ? `Rework ${Math.round(sum.reworkRate * 100)}% of ${sum.runs} runs` : `${sum.runs} runs`}
            {sum.bestDay ? ` · best day ${shortDate(sum.bestDay.date)} (${sum.bestDay.finished})` : ""}
            {stats?.since ? ` · history since ${shortDate(stats.since.slice(0, 10))}` : ""}
          </p>
        </>
      )}
    </div>
  );
}

function Bars({ title, days, value, format, total }: { title: string; days: DayStats[]; value: (d: DayStats) => number; format: (n: number) => string; total: string }) {
  const heights = barHeights(days.map(value));
  const today = days.length ? days[days.length - 1].date : "";
  return (
    <div className="mb-2 last:mb-0" data-bars={title.toLowerCase()}>
      <div className="mb-1 flex items-baseline justify-between text-label">
        <span className="text-muted">{title}</span>
        <span className="font-mono">{total}</span>
      </div>
      <div className="flex h-14 items-end gap-0.5" role="img" aria-label={`${title} per day`}>
        {days.map((d, i) => (
          <div key={d.date} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${shortDate(d.date)}: ${format(value(d))}${d.date === today ? " (so far today)" : ""}`}>
            <div
              data-bar={d.date}
              className={`w-full rounded-sm ${d.date === today ? "opacity-60" : ""} ${heights[i] > 0 ? "bg-[var(--profile-accent,var(--color-accent))]" : "bg-border"}`}
              style={{ height: heights[i] > 0 ? `${heights[i]}%` : "2px" }}
            />
          </div>
        ))}
      </div>
      <div className="mt-0.5 flex gap-0.5 text-meta text-faint" aria-hidden="true">
        {days.map((d) => (
          <span key={d.date} className="min-w-0 flex-1 text-center">
            {days.length <= 14 || d.date.endsWith("-01") || d.date.endsWith("-15") ? weekdayLetter(d.date) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
