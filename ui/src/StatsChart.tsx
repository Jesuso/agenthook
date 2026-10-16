import { useEffect, useRef, useState } from "react";
import type { DayStats } from "./contract";
import { formatCost } from "./format";
import { shortDate } from "./stats";
import { axisDollars, chartModel, costPerTicket, dayAt } from "./statsChart";

const HEIGHT = 190;

/**
 * Finished tickets per day (bars, left axis) and cost per finished ticket (line, right axis) in one
 * chart. d3 does the scales and paths (`statsChart.ts`); React renders the SVG. Loaded lazily.
 */
export default function StatsChart({ days }: { days: DayStats[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState(-1);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const m = chartModel(days, width, HEIGHT);
  const d = hover >= 0 ? days[hover] : null;
  const cpt = d ? costPerTicket(d) : null;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(dayAt(m, ((e.clientX - r.left) / r.width) * width));
  };

  return (
    <div ref={box} className="relative" data-stats-chart>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" aria-label="Tickets finished per day, with cost per finished ticket" onPointerMove={onMove} onPointerLeave={() => setHover(-1)} className="block touch-none select-none">
        {m.leftTicks.map((t) => (
          <g key={`l${t.pos}`}>
            <line x1={m.plot.left} x2={m.plot.right} y1={t.pos} y2={t.pos} stroke="var(--color-border-subtle)" strokeDasharray={t.label === "0" ? undefined : "2 3"} />
            <text x={m.plot.left - 6} y={t.pos} dy="0.32em" textAnchor="end" className="fill-[var(--color-muted)] font-mono text-[10px]">
              {t.label}
            </text>
          </g>
        ))}
        {m.rightTicks.map((t) => (
          <text key={`r${t.pos}`} x={m.plot.right + 6} y={t.pos} dy="0.32em" className="fill-[var(--color-muted)] font-mono text-[10px]">
            {t.label}
          </text>
        ))}
        {m.bars.map((b, i) => (
          <rect key={b.date} data-bar={b.date} x={b.x} y={b.y} width={b.w} height={b.h} rx={2} fill="var(--profile-accent, var(--color-accent))" opacity={i === hover ? 1 : b.today ? 0.55 : 0.8} />
        ))}
        {m.line && <path d={m.line} fill="none" stroke="var(--color-fg)" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" data-cost-line />}
        {m.dots.map((p) => (
          <circle key={p.date} cx={p.x} cy={p.y} r={2.5} fill="var(--color-surface)" stroke="var(--color-fg)" strokeWidth={1.5} />
        ))}
        {m.xTicks.map((t) => (
          <text key={t.pos} x={t.pos} y={HEIGHT - 6} textAnchor="middle" className="fill-[var(--color-faint)] text-[10px]">
            {t.label}
          </text>
        ))}
        {hover >= 0 && <line x1={m.centers[hover]} x2={m.centers[hover]} y1={m.plot.top} y2={m.plot.bottom} stroke="var(--color-border)" />}
      </svg>
      {d && (
        <div data-stats-tip role="status" className="pointer-events-none absolute top-0 z-10 rounded-md border border-border bg-surface-raised px-2 py-1 text-label shadow-lg" style={{ left: Math.min(Math.max(0, m.centers[hover] - 70), Math.max(0, width - 150)), maxWidth: 150 }}>
          <div className="font-medium">{shortDate(d.date)}</div>
          <div className="font-mono text-muted">
            {d.finished} finished · {d.runs} runs
          </div>
          <div className="font-mono text-muted">{d.costUsd ? `${formatCost(d.costUsd)}${cpt ? ` · ${axisDollars(cpt)}/ticket` : ""}` : "no spend"}</div>
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-meta text-faint" aria-hidden="true">
        <span className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-sm bg-[var(--profile-accent,var(--color-accent))]" /> tickets finished
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 rounded bg-fg" /> spend per finished ticket
        </span>
      </div>
    </div>
  );
}
