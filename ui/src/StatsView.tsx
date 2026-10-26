import { useEffect, useRef, useState } from "react";
import type { DayStats, ProfileView, StatsView as StatsData } from "./contract";
import { Segmented, ProfileMark } from "./components";
import type { FeedEntry } from "./feed";
import { formatCost, formatSpend, profileLabel } from "./format";
import { formatEnergy } from "../../src/energy.js";
import { latestChange, shortDate, statsUrl } from "./stats";
import { axisDollars } from "./statsChart";
import { DOWN, OTHER_STEPS, UP, calendarModel, divergingModel, nearestDay, rangeModel, stackedModel } from "./statsModels";
import type { Outcome, Tick } from "./statsModels";
import { useT } from "./i18n/react";
import type { MessageKey } from "./i18n";

const RANGES = ["14", "30", "90"] as const;
type Range = (typeof RANGES)[number];
/** The calendar always shows this many days (26 weeks) whatever the range above says. */
const CALENDAR_DAYS = 182;
const H = 200;

const OUTCOME_COLOR: Record<Outcome, string> = {
  advance: "var(--color-status-done)",
  changes: "var(--color-status-queued)",
  hold: "var(--color-status-held)",
  fail: "var(--color-status-failed)",
};
const OUTCOME_LABEL: Record<Outcome, MessageKey> = { advance: "statsView.outcome.advance", changes: "statsView.outcome.changes", hold: "statsView.outcome.hold", fail: "statsView.outcome.fail" };

/**
 * The profile's deeper history (docs/web-ui.md § Daily stats): four charts over the day buckets
 * `GET /api/stats` derives from the whole events log. d3 does the geometry (`statsModels.ts`,
 * unit-tested); these components only draw it. One profile at a time (ADR 0001).
 */
export default function StatsView({ profile, feed }: { profile: ProfileView; feed: FeedEntry[] }) {
  const { t, lang } = useT();
  const [range, setRange] = useState<Range>("30");
  const [data, setData] = useState<StatsData | null>(null);
  const [failed, setFailed] = useState(false);
  const changed = latestChange(feed);

  useEffect(() => {
    let live = true;
    fetch(statsUrl(profile.name, CALENDAR_DAYS))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((b: StatsData) => live && (setData(b), setFailed(false)))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [profile.name, changed]);

  const all = data?.days ?? [];
  const days = all.slice(-Number(range));
  const empty = data !== null && days.every((d) => d.runs === 0 && d.finished === 0);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4" data-stats-view>
      <div className="flex flex-wrap items-center gap-3">
        <ProfileMark p={profile} />
        <h1 className="text-title font-semibold">
          {t("statsView.title")} <span className="font-normal text-muted">· {profileLabel(profile)}</span>
        </h1>
        <span className="ml-auto">
          <Segmented value={range} options={RANGES.map((r) => ({ value: r, label: t("stats.days", { count: Number(r) }) }))} onChange={setRange} />
        </span>
      </div>
      {failed && !data && <p className="text-label text-muted">{t("stats.loadFailed")}</p>}
      {data && (
        <>
          <Card title={t("statsView.finishedPerDay")} note={t("statsView.calendarNote", { count: Math.min(CALENDAR_DAYS / 7, Math.ceil(all.length / 7)) })}>
            <Calendar days={all} />
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t("statsView.spendByStep")} note={t("statsView.spendByStepNote")}>
              <Stacked days={days} />
            </Card>
            <Card title={t("statsView.howRunsEnded")} note={t("statsView.howRunsEndedNote")}>
              <Diverging days={days} />
            </Card>
          </div>
          <Card title={t("statsView.ticketCost")} note={t("statsView.ticketCostNote")}>
            <Range days={days} />
          </Card>
          {empty && <p className="text-label text-muted">{t("statsView.empty")}</p>}
          <p className="text-meta text-muted">{data.since ? `${t("statsView.since", { date: shortDate(data.since.slice(0, 10), lang) })} ` : ""}{t("statsView.midnight")}</p>
        </>
      )}
    </div>
  );
}

function Card({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-surface px-3 py-3">
      <h2 className="text-label font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <p className="mb-2 text-meta text-muted">{note}</p>
      {children}
    </section>
  );
}

/** Track the container's width (the SVG's viewBox width) so text stays a constant size. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const AXIS = "fill-[var(--color-muted)] font-mono text-[10px]";

function Grid({ ticks, left, right, zero }: { ticks: Tick[]; left: number; right: number; zero?: string }) {
  return (
    <>
      {ticks.map((t) => (
        <g key={t.pos}>
          <line x1={left} x2={right} y1={t.pos} y2={t.pos} stroke="var(--color-border-subtle)" strokeDasharray={t.label === zero ? undefined : "2 3"} />
          <text x={left - 6} y={t.pos} dy="0.32em" textAnchor="end" className={AXIS}>
            {t.label}
          </text>
        </g>
      ))}
    </>
  );
}

function DayLabels({ ticks }: { ticks: Tick[] }) {
  return (
    <>
      {ticks.map((t) => (
        <text key={t.pos} x={t.pos} y={H - 6} textAnchor="middle" className="fill-[var(--color-faint)] text-[10px]">
          {t.label}
        </text>
      ))}
    </>
  );
}

function Tip({ x, width, children }: { x: number; width: number; children: React.ReactNode }) {
  return (
    <div data-stats-tip role="status" className="pointer-events-none absolute top-0 z-10 rounded-md border border-border bg-surface-raised px-2 py-1 text-label shadow-lg" style={{ left: Math.min(Math.max(0, x - 80), Math.max(0, width - 170)), maxWidth: 170 }}>
      {children}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-meta text-muted" aria-hidden="true">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-sm" style={{ background: i.color }} /> {i.label}
        </span>
      ))}
    </div>
  );
}

/** Pointer → the day under it (SVG units) for every band chart. */
function usePointerDay(width: number, centers: { centers: number[]; plot: { left: number; right: number } }) {
  const [hover, setHover] = useState(-1);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(nearestDay(centers, ((e.clientX - r.left) / r.width) * width));
  };
  return { hover, onMove, onLeave: () => setHover(-1) };
}

// ------------------------------------------------------------------- 1. spend by step

export function Stacked({ days }: { days: DayStats[] }) {
  const { t, lang } = useT();
  const [ref, w] = useWidth();
  const m = stackedModel(days, w, H, lang);
  const { hover, onMove, onLeave } = usePointerDay(w, m);
  const d = hover >= 0 ? days[hover] : null;
  const color = (s: string) => m.legend.find((l) => l.series === s)?.color ?? "var(--color-muted)";
  return (
    <div ref={ref} className="relative" data-chart="spend-by-step">
      <svg viewBox={`0 0 ${w} ${H}`} width="100%" height={H} role="img" aria-label={t("statsView.stackedLabel")} onPointerMove={onMove} onPointerLeave={onLeave} className="block touch-none select-none">
        <Grid ticks={m.yTicks} left={m.plot.left} right={m.plot.right} zero="$0.00" />
        {m.segments.map((s) => {
          const op = hover < 0 || days[hover].date === s.date ? 0.9 : 0.55;
          // An estimate is the same hue, washed out and dash-outlined: never read as reported dollars.
          return s.est ? (
            <rect key={`${s.date}${s.series}~est`} data-est x={s.x + 0.5} y={s.y + 0.5} width={Math.max(0, s.w - 1)} height={Math.max(0.5, s.h - 1)} fill={color(s.series)} fillOpacity={op * 0.3} stroke={color(s.series)} strokeOpacity={op} strokeDasharray="3 2" />
          ) : (
            <rect key={`${s.date}${s.series}`} x={s.x} y={s.y} width={s.w} height={Math.max(0.5, s.h)} fill={color(s.series)} opacity={op} />
          );
        })}
        <DayLabels ticks={m.xTicks} />
      </svg>
      {d && (
        <Tip x={m.centers[hover]} width={w}>
          <div className="font-medium">{shortDate(d.date, lang)}</div>
          {Object.entries(d.byStep).filter(([, v]) => v.costUsd + (v.estUsd ?? 0) > 0 || (v.energyKwh ?? 0) > 0).sort((a, b) => b[1].costUsd + (b[1].estUsd ?? 0) - a[1].costUsd - (a[1].estUsd ?? 0)).map(([k, v]) => (
            <div key={k} className="font-mono text-muted">
              {k} {formatSpend({ reported: v.costUsd, est: v.estUsd })} · {t("chart.runs", { count: v.runs })}
              {(v.energyKwh ?? 0) > 0 && ` · ${formatEnergy(v)}`}
            </div>
          ))}
          {!d.costUsd && !d.estUsd && <div className="font-mono text-muted">{t("chart.noSpend")}</div>}
          {(d.energyKwh ?? 0) > 0 && <div className="font-mono text-muted" data-day-energy>{formatEnergy(d)}</div>}
          {d.unestimatedRuns > 0 && <div className="font-mono text-muted">{t("stats.noEstimate", { count: d.unestimatedRuns })}</div>}
        </Tip>
      )}
      <Legend items={m.legend.map((l) => ({ label: `${l.series === OTHER_STEPS ? t("statsView.otherSteps") : l.series} ${formatSpend({ reported: l.total, est: l.est }) || formatCost(0, lang)}`, color: l.color }))} />
      {(m.legend.some((l) => l.est > 0) || m.unestimatedRuns > 0) && (
        <p className="mt-1 text-meta text-muted" data-est-note>
          {m.legend.some((l) => l.est > 0) && t("statsView.estNote")}
          {m.legend.some((l) => l.est > 0) && m.unestimatedRuns > 0 && " "}
          {m.unestimatedRuns > 0 && t("statsView.unestimatedNote", { count: m.unestimatedRuns })}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- 2. how runs ended

export function Diverging({ days }: { days: DayStats[] }) {
  const { t, lang } = useT();
  const [ref, w] = useWidth();
  const m = divergingModel(days, w, H, lang);
  const { hover, onMove, onLeave } = usePointerDay(w, m);
  const d = hover >= 0 ? days[hover] : null;
  return (
    <div ref={ref} className="relative" data-chart="outcomes">
      <svg viewBox={`0 0 ${w} ${H}`} width="100%" height={H} role="img" aria-label={t("statsView.divergingLabel")} onPointerMove={onMove} onPointerLeave={onLeave} className="block touch-none select-none">
        <Grid ticks={m.yTicks} left={m.plot.left} right={m.plot.right} zero="0" />
        {m.segments.map((s) => (
          <rect key={`${s.date}${s.outcome}`} x={s.x} y={s.y} width={s.w} height={Math.max(0.5, s.h)} fill={OUTCOME_COLOR[s.outcome]} opacity={hover < 0 || days[hover].date === s.date ? 0.9 : 0.55} />
        ))}
        <line x1={m.plot.left} x2={m.plot.right} y1={m.baseline} y2={m.baseline} stroke="var(--color-border-strong, var(--color-border))" />
        <DayLabels ticks={m.xTicks} />
      </svg>
      {d && (
        <Tip x={m.centers[hover]} width={w}>
          <div className="font-medium">{shortDate(d.date, lang)}</div>
          {[...UP, ...DOWN].map((o) => (
            <div key={o} className="font-mono text-muted">
              {d.outcomes[o]} {t(OUTCOME_LABEL[o])}
            </div>
          ))}
        </Tip>
      )}
      <Legend items={[...UP, ...DOWN].map((o) => ({ label: t(OUTCOME_LABEL[o]), color: OUTCOME_COLOR[o] }))} />
    </div>
  );
}

// ------------------------------------------------------------------- 3. calendar

export function Calendar({ days }: { days: DayStats[] }) {
  const { t, lang } = useT();
  const [ref, w] = useWidth();
  const m = calendarModel(days, w, lang);
  const [hover, setHover] = useState<string | null>(null);
  const cell = hover ? m.cells.find((c) => c.date === hover) : null;
  return (
    <div ref={ref} className="relative" data-chart="calendar">
      <svg viewBox={`0 0 ${Math.max(w, m.width)} ${m.height}`} width="100%" height={m.height} role="img" aria-label={t("statsView.calendarLabel")} className="block">
        {m.months.map((tk) => (
          <text key={`${tk.pos}${tk.label}`} x={tk.pos} y={10} className="fill-[var(--color-faint)] text-[10px]">
            {tk.label}
          </text>
        ))}
        {m.weekdays.map((tk) => (
          <text key={tk.pos} x={0} y={tk.pos} dy="0.32em" className="fill-[var(--color-faint)] text-[10px]">
            {tk.label}
          </text>
        ))}
        {m.cells.map((c) => (
          <g key={c.date} onPointerEnter={() => setHover(c.date)} onPointerLeave={() => setHover(null)}>
            <rect x={c.x} y={c.y} width={c.size} height={c.size} rx={2} fill="var(--color-surface-raised)" />
            {c.opacity > 0 && <rect data-cell={c.date} x={c.x} y={c.y} width={c.size} height={c.size} rx={2} fill="var(--profile-accent, var(--color-accent))" opacity={c.opacity} />}
            {hover === c.date && <rect x={c.x} y={c.y} width={c.size} height={c.size} rx={2} fill="none" stroke="var(--color-fg)" />}
          </g>
        ))}
      </svg>
      {cell && (
        <Tip x={cell.x} width={Math.max(w, m.width)}>
          <div className="font-medium">{shortDate(cell.date, lang)}</div>
          <div className="font-mono text-muted">{t("stats.finished", { count: cell.finished })}</div>
        </Tip>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- 4. cost of a finished ticket

export function Range({ days }: { days: DayStats[] }) {
  const { t, lang } = useT();
  const [ref, w] = useWidth();
  const m = rangeModel(days, w, H, lang);
  const { hover, onMove, onLeave } = usePointerDay(w, m);
  const d = hover >= 0 ? days[hover] : null;
  const bw = Math.max(4, Math.min(12, m.bandwidth * 0.5));
  return (
    <div ref={ref} className="relative" data-chart="ticket-cost">
      <svg viewBox={`0 0 ${w} ${H}`} width="100%" height={H} role="img" aria-label={t("statsView.rangeLabel")} onPointerMove={onMove} onPointerLeave={onLeave} className="block touch-none select-none">
        <Grid ticks={m.yTicks} left={m.plot.left} right={m.plot.right} zero="$0.00" />
        {m.trend && <path d={m.trend} fill="none" stroke="var(--color-border-strong, var(--color-border))" strokeWidth={1} strokeDasharray="3 3" />}
        {m.points.map((p) => (
          <g key={p.date} opacity={hover < 0 || days[hover].date === p.date ? 1 : 0.5}>
            <rect x={p.x - bw / 2} y={p.yHigh} width={bw} height={Math.max(1, p.yLow - p.yHigh)} rx={bw / 2} fill="var(--profile-accent, var(--color-accent))" opacity={0.35} />
            <circle data-median={p.date} cx={p.x} cy={p.yMid} r={3} fill="var(--color-fg)" />
          </g>
        ))}
        <DayLabels ticks={m.xTicks} />
      </svg>
      {d && (
        <Tip x={m.centers[hover]} width={w}>
          <div className="font-medium">{shortDate(d.date, lang)}</div>
          {d.ticketCost ? (
            <>
              <div className="font-mono text-muted">{t("statsView.median", { value: axisDollars(d.ticketCost.p50) })}</div>
              <div className="font-mono text-muted">
                p10 {axisDollars(d.ticketCost.p10)} · p90 {axisDollars(d.ticketCost.p90)}
              </div>
              <div className="font-mono text-muted">{t("statsView.tickets", { count: d.ticketCost.n })}</div>
            </>
          ) : (
            <div className="font-mono text-muted">{t("statsView.noCostedTickets")}</div>
          )}
          {d.ticketEst && (
            <div className="font-mono text-muted">
              {t("statsView.estMedian", { value: axisDollars(d.ticketEst.p50), count: d.ticketEst.n })}
            </div>
          )}
        </Tip>
      )}
      <Legend items={[{ label: t("statsView.legendMedian"), color: "var(--color-fg)" }, { label: t("statsView.legendSpread"), color: "color-mix(in srgb, var(--profile-accent, var(--color-accent)) 35%, transparent)" }]} />
    </div>
  );
}
