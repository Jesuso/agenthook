import { useState } from "react";
import { STAGE_H, STEP_H, STEP_W } from "./pipelineGraph";
import type { EdgeRoute, GraphEdge, PipelineLayout, StageNode, StepNode } from "./pipelineGraph";

/** Inline SVG render of `layoutPipeline`'s output (docs/web-ui.md § v3 "Pipeline graph"). Draws
 *  the routes the layout computed — no geometry decisions here. */

const EDGE_STYLE: Record<GraphEdge["type"], { stroke: string; dash?: string }> = {
  advance: { stroke: "var(--color-accent)" },
  fail: { stroke: "var(--color-err)" },
  hold: { stroke: "var(--color-warn)" },
  changes: { stroke: "var(--color-ok)", dash: "5 4" },
  queue: { stroke: "var(--color-muted)", dash: "2 3" },
};

const EDGE_LABEL: Record<GraphEdge["type"], string> = {
  advance: "advance",
  fail: "fail",
  hold: "hold",
  changes: "changes (default target)",
  queue: "queue",
};

/** Corner radius of an orthogonal route's bends. */
const BEND_R = 6;
/** Approximate glyph width at the 10px label size — sizes a label's backing rect and pill truncation. */
const CHAR_W = 6;

const isStep = (n: { kind: string }): n is StepNode => n.kind === "step";

/** `text` cut with an ellipsis to fit `width` px at the 10px label size. */
function fit(text: string, width: number): string {
  const max = Math.max(3, Math.floor(width / CHAR_W));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** SVG path data for a route: the `changes` quadratic, or a polyline with rounded bends. */
function pathOf(r: EdgeRoute): string {
  const [a, ...rest] = r.points;
  if (!a) return "";
  if (r.control) return `M${a.x},${a.y} Q${r.control.x},${r.control.y} ${rest[0].x},${rest[0].y}`;
  let d = `M${a.x},${a.y}`;
  r.points.forEach((p, i) => {
    if (i === 0) return;
    const next = r.points[i + 1];
    if (!next) return void (d += ` L${p.x},${p.y}`);
    const prev = r.points[i - 1];
    // Cut the corner by up to BEND_R (half of the shorter leg) and curve through the bend point.
    const rIn = Math.min(BEND_R, Math.hypot(p.x - prev.x, p.y - prev.y) / 2);
    const rOut = Math.min(BEND_R, Math.hypot(next.x - p.x, next.y - p.y) / 2);
    const inDir = { x: Math.sign(p.x - prev.x), y: Math.sign(p.y - prev.y) };
    const outDir = { x: Math.sign(next.x - p.x), y: Math.sign(next.y - p.y) };
    d += ` L${p.x - inDir.x * rIn},${p.y - inDir.y * rIn} Q${p.x},${p.y} ${p.x + outDir.x * rOut},${p.y + outDir.y * rOut}`;
  });
  return d;
}

/** A label on a backing rect (so it reads on top of the line it sits on). */
function EdgeLabel(props: { at: { x: number; y: number }; text: string; color: string }) {
  const { at, text, color } = props;
  const w = text.length * CHAR_W + 8;
  return (
    <g pointerEvents="none">
      <rect x={at.x - w / 2} y={at.y - 8} width={w} height={16} rx={3} fill="var(--color-bg)" stroke={color} strokeWidth={0.75} />
      <text x={at.x} y={at.y + 3.5} textAnchor="middle" fontSize={10} fill={color}>
        {text}
      </text>
    </g>
  );
}

function EdgePath(props: { edge: GraphEdge; route: EdgeRoute; hover: boolean; onHover: (on: boolean) => void }) {
  const { edge, route, hover, onHover } = props;
  const style = EDGE_STYLE[edge.type];
  const d = pathOf(route);
  return (
    <g onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
      <path d={d} fill="none" stroke={style.stroke} strokeWidth={hover ? 2.5 : 1.5} strokeDasharray={style.dash} markerEnd={`url(#ah-arrow-${edge.type})`} />
      {/* Wide invisible hit-stroke: a 1.5px line is too thin to hover. */}
      <path d={d} fill="none" stroke="transparent" strokeWidth={12} pointerEvents="stroke" />
    </g>
  );
}

function StepCard(props: { node: StepNode }) {
  const n = props.node;
  const badges = [n.manual && "manual", n.createsWorktree && "worktree", n.drainWorktree && "drain"].filter(Boolean) as string[];
  const meta = [n.stepKind, n.model, n.effort].filter(Boolean).join(" · ");
  return (
    <g transform={`translate(${n.x},${n.y})`}>
      <title>{`${n.id}\n${meta}`}</title>
      <rect
        width={STEP_W}
        height={STEP_H}
        rx={6}
        fill="var(--color-bg)"
        stroke={n.terminal ? "var(--color-muted)" : "var(--color-accent)"}
        strokeDasharray={n.terminal ? "4 3" : undefined}
        strokeWidth={1.5}
      />
      <text x={10} y={18} fontSize={12} fontWeight={600} fill="var(--color-fg)">
        {n.id}
      </text>
      <text x={10} y={34} fontSize={10} fill="var(--color-muted)">
        {fit(meta, STEP_W - 20)}
      </text>
      {badges.length > 0 && (
        <text x={10} y={50} fontSize={9} fill="var(--color-muted)">
          {badges.join(" · ")}
        </text>
      )}
    </g>
  );
}

function StagePill(props: { node: StageNode }) {
  const n = props.node;
  // A narrowed pill (two private sinks in one column) truncates; the full label is the tooltip.
  const text = fit(n.label, n.w - 12);
  return (
    <g transform={`translate(${n.x},${n.y})`}>
      <title>{n.label}</title>
      <rect width={n.w} height={STAGE_H} rx={STAGE_H / 2} fill="var(--color-bg)" stroke="var(--color-border)" strokeWidth={1.5} />
      <text x={n.w / 2} y={STAGE_H / 2 + 4} textAnchor="middle" fontSize={10} fill="var(--color-fg)">
        {text}
      </text>
    </g>
  );
}

function Legend() {
  const types: GraphEdge["type"][] = ["advance", "fail", "hold", "changes", "queue"];
  return (
    <div className="flex flex-wrap justify-center gap-3 text-xs text-[var(--color-muted)]">
      {types.map((t) => (
        <span key={t} className="flex items-center gap-1">
          <svg width={20} height={8}>
            <line x1={0} y1={4} x2={20} y2={4} stroke={EDGE_STYLE[t].stroke} strokeWidth={2} strokeDasharray={EDGE_STYLE[t].dash} />
          </svg>
          {EDGE_LABEL[t]}
        </span>
      ))}
      <span>· hover an edge for its label</span>
    </div>
  );
}

export function PipelineGraph(props: { layout: PipelineLayout }) {
  const { layout } = props;
  const [hovered, setHovered] = useState<number | null>(null);
  if (!layout.nodes.length) return <p className="text-sm text-[var(--color-muted)]">no pipeline steps yet</p>;
  return (
    <div className="flex flex-col gap-2">
      {layout.unknownStageKeys && (
        <p className="text-xs text-[var(--color-warn)]">stage bindings unknown for this tracker — showing steps and `changes` edges only</p>
      )}
      <div className="overflow-auto">
        <svg className="mx-auto block" width={layout.width} height={layout.height} role="img" aria-label="pipeline graph">
          <defs>
            {(["advance", "fail", "hold", "changes", "queue"] as const).map((t) => (
              <marker key={t} id={`ah-arrow-${t}`} viewBox="0 0 10 10" refX={8} refY={5} markerUnits="userSpaceOnUse" markerWidth={10} markerHeight={10} orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={EDGE_STYLE[t].stroke} />
              </marker>
            ))}
          </defs>
          {layout.edges.map((e, i) => (
            <EdgePath key={i} edge={e} route={layout.routes[i]} hover={hovered === i} onHover={(on) => setHovered((h) => (on ? i : h === i ? null : h))} />
          ))}
          {layout.nodes.map((n) => (isStep(n) ? <StepCard key={`s:${n.id}`} node={n} /> : <StagePill key={`g:${n.id}`} node={n} />))}
          {/* Labels last, over the cards: the `changes` arc's short label is persistent; hover shows the full one. */}
          {layout.edges.map((e, i) =>
            hovered === i ? (
              <EdgeLabel key={`l:${i}`} at={layout.routes[i].labelAt} text={e.label ?? EDGE_LABEL[e.type]} color={EDGE_STYLE[e.type].stroke} />
            ) : e.type === "changes" ? (
              <EdgeLabel key={`l:${i}`} at={layout.routes[i].labelAt} text="changes" color={EDGE_STYLE[e.type].stroke} />
            ) : null,
          )}
        </svg>
      </div>
      <Legend />
    </div>
  );
}
