import type { GraphEdge, GraphNode, PipelineLayout, StageNode, StepNode } from "./pipelineGraph";

/** Inline SVG render of `layoutPipeline`'s output (docs/web-ui.md § v3 "Pipeline graph"). */

const STEP_W = 180;
const STEP_H = 64;
const STAGE_W = 140;
const STAGE_H = 40;

const EDGE_STYLE: Record<GraphEdge["type"], { stroke: string; dash?: string }> = {
  advance: { stroke: "var(--color-accent)" },
  fail: { stroke: "var(--color-err)" },
  hold: { stroke: "var(--color-warn)" },
  changes: { stroke: "var(--color-accent)", dash: "5 4" },
  queue: { stroke: "var(--color-muted)", dash: "2 3" },
};

const EDGE_LABEL: Record<GraphEdge["type"], string> = {
  advance: "advance",
  fail: "fail",
  hold: "hold",
  changes: "changes (default target)",
  queue: "queue",
};

const isStep = (n: GraphNode): n is StepNode => n.kind === "step";
const isStage = (n: GraphNode): n is StageNode => n.kind === "stage";

function center(n: GraphNode): { x: number; y: number } {
  const [w, h] = isStep(n) ? [STEP_W, STEP_H] : [STAGE_W, STAGE_H];
  return { x: n.x + w / 2, y: n.y + h / 2 };
}

function EdgePath(props: { edge: GraphEdge; from: GraphNode; to: GraphNode; sameRow: boolean }) {
  const { edge, from, to, sameRow } = props;
  const a = center(from);
  const b = center(to);
  const style = EDGE_STYLE[edge.type];
  // `changes` arcs above the row (toward smaller y); everything else is a straight line.
  const d = sameRow ? `M${a.x},${a.y} Q${(a.x + b.x) / 2},${Math.min(a.y, b.y) - 46} ${b.x},${b.y}` : `M${a.x},${a.y} L${b.x},${b.y}`;
  const mid = sameRow ? { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 46 } : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return (
    <g>
      <path d={d} fill="none" stroke={style.stroke} strokeWidth={1.5} strokeDasharray={style.dash} markerEnd={`url(#ah-arrow-${edge.type})`} />
      {edge.label && (
        <text x={mid.x} y={mid.y - 4} textAnchor="middle" fontSize={10} fill={style.stroke}>
          {edge.label}
        </text>
      )}
    </g>
  );
}

function StepCard(props: { node: StepNode }) {
  const n = props.node;
  const badges = [n.manual && "manual", n.createsWorktree && "worktree", n.drainWorktree && "drain"].filter(Boolean) as string[];
  return (
    <g transform={`translate(${n.x},${n.y})`}>
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
        {n.stepKind}
        {n.model ? ` · ${n.model}` : ""}
        {n.effort ? ` · ${n.effort}` : ""}
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
  return (
    <g transform={`translate(${n.x},${n.y})`}>
      <rect width={STAGE_W} height={STAGE_H} rx={STAGE_H / 2} fill="var(--color-bg)" stroke="var(--color-border)" strokeWidth={1.5} />
      <text x={STAGE_W / 2} y={STAGE_H / 2 + 4} textAnchor="middle" fontSize={10} fill="var(--color-fg)">
        {n.label}
      </text>
    </g>
  );
}

function Legend() {
  const types: GraphEdge["type"][] = ["advance", "fail", "hold", "changes", "queue"];
  return (
    <div className="flex flex-wrap gap-3 text-xs text-[var(--color-muted)]">
      {types.map((t) => (
        <span key={t} className="flex items-center gap-1">
          <svg width={20} height={8}>
            <line x1={0} y1={4} x2={20} y2={4} stroke={EDGE_STYLE[t].stroke} strokeWidth={2} strokeDasharray={EDGE_STYLE[t].dash} />
          </svg>
          {EDGE_LABEL[t]}
        </span>
      ))}
    </div>
  );
}

export function PipelineGraph(props: { layout: PipelineLayout }) {
  const { layout } = props;
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const stepIds = new Set(layout.nodes.filter(isStep).map((n) => n.id));
  return (
    <div className="flex flex-col gap-2">
      {layout.unknownStageKeys && (
        <p className="text-xs text-[var(--color-warn)]">stage bindings unknown for this tracker — showing steps and `changes` edges only</p>
      )}
      <div className="overflow-auto rounded border border-[var(--color-border)]">
        <svg width={layout.width} height={layout.height} role="img" aria-label="pipeline graph">
          <defs>
            {(["advance", "fail", "hold", "changes", "queue"] as const).map((t) => (
              <marker key={t} id={`ah-arrow-${t}`} viewBox="0 0 10 10" refX={8} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={EDGE_STYLE[t].stroke} />
              </marker>
            ))}
          </defs>
          {layout.edges.map((e, i) => {
            const from = byId.get(e.from);
            const to = byId.get(e.to);
            if (!from || !to) return null;
            return <EdgePath key={i} edge={e} from={from} to={to} sameRow={stepIds.has(e.from) && stepIds.has(e.to)} />;
          })}
          {layout.nodes.map((n) => (isStep(n) ? <StepCard key={`s:${n.id}`} node={n} /> : <StagePill key={`g:${n.id}`} node={n as StageNode} />))}
        </svg>
      </div>
      <Legend />
    </div>
  );
}
