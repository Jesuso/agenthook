import type { StageKeys, StageOption } from "./configEdit";

/**
 * Pure derivation of the Config pipeline graph (docs/web-ui.md § v3 "Pipeline graph") from the
 * live buffer's steps — no DOM, no fetch. Mirrors src/pipeline.js's `stepForStage` match rule and
 * `prevStep` default so the graph agrees with what the receiver actually does at runtime.
 *
 * Layers, top to bottom: the queue-stage row (only when a step has a queue stage), the step row,
 * then the sinks — a fail/hold/exit stage used by one step sits under that step's column, one used
 * by 2+ steps is a single pill in a lower row reached by orthogonal routes through a per-stage
 * channel track. The geometry (every edge's route) is computed here so it can be tested; the TSX
 * only draws it.
 */

export type StepNode = {
  kind: "step";
  id: string;
  stepKind: string;
  model?: string;
  effort?: string;
  manual: boolean;
  createsWorktree: boolean;
  drainWorktree: boolean;
  /** `manual`, or no `success*` binding — nothing moves the task out of this step on its own. */
  terminal: boolean;
  x: number;
  y: number;
};

export type StageNode = {
  kind: "stage";
  id: string;
  label: string;
  x: number;
  y: number;
  /** Pill width — narrower than STAGE_W when two private sinks share one step's column. */
  w: number;
};

export type GraphNode = StepNode | StageNode;

export type EdgeType = "advance" | "fail" | "hold" | "changes" | "queue";

export type GraphEdge = {
  from: string;
  to: string;
  type: EdgeType;
  label?: string;
};

export type Point = { x: number; y: number };

/**
 * An edge's drawn path: an orthogonal polyline through `points`, or — with `control` — the
 * quadratic curve `points[0]` → `points[1]` (the `changes` arc). `labelAt` is where its label sits:
 * on the curve's t=0.5 point, else the middle of the longest segment.
 */
export type EdgeRoute = { points: Point[]; control?: Point; labelAt: Point };

export type PipelineLayout = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Parallel to `edges`. */
  routes: EdgeRoute[];
  width: number;
  height: number;
  /** true when `keys` is null (tracker type unknown) — only step nodes + `changes` edges drawn. */
  unknownStageKeys: boolean;
};

export const STEP_W = 180;
export const STEP_H = 64;
export const STEP_GAP = 60;
export const STAGE_W = 140;
export const STAGE_H = 40;
export const MARGIN = 20;
/** Gap kept between an edge's arrow tip and the node border, so arrowheads never sit under it. */
export const END_GAP = 5;
/** Minimum gap between two pills in a row. */
const STAGE_GAP = 24;
/** Gap between the private pills sharing one step's column. */
const PILL_GAP = 8;
/** How far a step's private pills may reach into the gaps beside it (stays clear of the neighbour's). */
const COL_PAD = STEP_GAP / 2 - 5;
/** Spacing of a step's bottom ports and of the channel tracks. */
const LANE = 8;
/** Inset of a step's outermost side lane from its edge. */
const LANE_INSET = 6;
/** Queue row bottom → step row top. */
const QUEUE_GAP = 36;
/** A `changes` arc's apex height above the step row (its control point sits at twice this). */
const ARC_RISE = 24;
/** Space reserved above the step row for an arc + the label drawn on it. */
const ARC_CLEAR = 44;
/** A non-adjacent step→step `advance` runs this far above the step row. */
const SKIP_RISE = 14;
const SKIP_CLEAR = 24;
/** Step row bottom → private sink row. */
const PRIV_GAP = 32;
/** Gap above the first channel track and below the last one. */
const TRACK_PAD = 16;
const TRACK_DROP = 20;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function labelFor(id: string, stages?: StageOption[] | null): string {
  return stages?.find((s) => s.id === id)?.label ?? id;
}

/** `stepForStage`'s match rule: labels compare case-insensitively, gids/statuses exactly. */
function stageMatch(keys: StageKeys, a: string, b: string): boolean {
  return keys.source === "sourceLabel" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Mean of `xs`, or `fallback` when empty. */
function mean(xs: number[], fallback: number): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : fallback;
}

/** A node's box. */
export function nodeRect(n: GraphNode): { x: number; y: number; w: number; h: number } {
  return n.kind === "step" ? { x: n.x, y: n.y, w: STEP_W, h: STEP_H } : { x: n.x, y: n.y, w: n.w, h: STAGE_H };
}

/**
 * Lay out one row of pills: each starts centered on its desired x (`want`), then they're pushed
 * apart left→right so none overlap, and the row is shifted back so its mean center is unchanged.
 */
function placeRow(row: { node: StageNode; want: number }[], y: number): void {
  row.sort((a, b) => a.want - b.want);
  row.reduce((minX, r) => {
    r.node.x = Math.max(r.want - r.node.w / 2, minX);
    r.node.y = y;
    return r.node.x + r.node.w + STAGE_GAP;
  }, -Infinity);
  const shift = mean(row.map((r) => r.want - (r.node.x + r.node.w / 2)), 0);
  for (const r of row) r.node.x += shift;
}

/** Drop repeated / collinear interior points from an orthogonal polyline. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))) out.pop();
    out.push(p);
  }
  return out;
}

/** A polyline route, labelled at the middle of its longest segment. */
function polyline(points: Point[]): EdgeRoute {
  const pts = simplify(points);
  let best = { len: -1, at: { x: pts[0]?.x ?? 0, y: pts[0]?.y ?? 0 } };
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (len > best.len) best = { len, at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
  return { points: pts, labelAt: best.at };
}

/** The quadratic Bézier through `a` → `b` with control `c`, at t. */
export function quadAt(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

/** Where an edge's endpoints are: a step index, or a stage node. */
type End = { step: number } | { stage: StageNode };

export function layoutPipeline(steps: Record<string, unknown>[], keys: StageKeys | null, stages?: StageOption[] | null): PipelineLayout {
  const ids = steps.map((s, i) => str(s.id) ?? `step-${i}`);
  const manual = steps.map((s) => s.manual === true);
  const success = keys ? steps.map((s) => str(s[keys.success])) : steps.map(() => undefined);
  const terminal = steps.map((s, i) => manual[i] || (keys ? success[i] === undefined : false));

  const stageNodes = new Map<string, StageNode>();
  const stageOf = (id: string): StageNode => {
    let n = stageNodes.get(id);
    if (!n) {
      n = { kind: "stage", id, label: labelFor(id, stages), x: 0, y: 0, w: STAGE_W };
      stageNodes.set(id, n);
    }
    return n;
  };

  const edges: GraphEdge[] = [];
  const ends: { from: End; to: End }[] = [];
  const add = (edge: GraphEdge, from: End, to: End) => {
    edges.push(edge);
    ends.push({ from, to });
  };

  if (keys) {
    steps.forEach((_s, i) => {
      if (terminal[i]) return;
      const succ = success[i];
      if (succ === undefined) return;
      const target = ids.findIndex((_id, j) => {
        const src = str(steps[j][keys.source]);
        return src !== undefined && stageMatch(keys, src, succ);
      });
      if (target >= 0) {
        add({ from: ids[i], to: ids[target], type: "advance" }, { step: i }, { step: target });
      } else {
        const node = stageOf(succ);
        add({ from: ids[i], to: node.id, type: "advance" }, { step: i }, { stage: node });
      }
    });

    steps.forEach((s, i) => {
      if (manual[i]) return;
      const fail = str(s[keys.failure]);
      if (fail !== undefined) add({ from: ids[i], to: stageOf(fail).id, type: "fail" }, { step: i }, { stage: stageOf(fail) });
      const hold = str(s[keys.hold]);
      if (hold !== undefined) add({ from: ids[i], to: stageOf(hold).id, type: "hold" }, { step: i }, { stage: stageOf(hold) });
    });

    steps.forEach((s, i) => {
      const queue = str(s[keys.queue]);
      if (queue !== undefined) add({ from: stageOf(queue).id, to: ids[i], type: "queue" }, { stage: stageOf(queue) }, { step: i });
    });
  }

  steps.forEach((s, i) => {
    if (manual[i] || i === 0 || str(s.kind) !== "review") return;
    add({ from: ids[i], to: ids[i - 1], type: "changes", label: "changes (default target)" }, { step: i }, { step: i - 1 });
  });

  // --- Geometry. Built left-aligned at x = MARGIN, then shifted so the leftmost node sits at MARGIN.
  const stepOf = (e: End) => ("step" in e ? e.step : -1);
  const stageAt = (e: End) => ("stage" in e ? e.stage : null);
  const isSkip = (k: number) => edges[k].type === "advance" && stepOf(ends[k].to) >= 0 && stepOf(ends[k].to) !== stepOf(ends[k].from) + 1;

  const queueStages = new Set(edges.flatMap((e, k) => (e.type === "queue" ? [stageAt(ends[k].from)!] : [])));
  const hasArc = edges.some((e) => e.type === "changes");
  const hasSkip = edges.some((_e, k) => isSkip(k));
  const above = Math.max(queueStages.size ? QUEUE_GAP : 0, hasArc ? ARC_CLEAR : 0, hasSkip ? SKIP_CLEAR : 0);
  const stepY = MARGIN + (queueStages.size ? STAGE_H : 0) + above;
  const stepBottom = stepY + STEP_H;
  const midY = stepY + STEP_H / 2;

  const stepNodes: StepNode[] = steps.map((s, i) => ({
    kind: "step",
    id: ids[i],
    stepKind: str(s.kind) ?? "implement",
    model: str(s.model),
    effort: str(s.effort),
    manual: manual[i],
    createsWorktree: s.createsWorktree === true,
    drainWorktree: s.drainWorktree === true,
    terminal: terminal[i],
    x: MARGIN + i * (STEP_W + STEP_GAP),
    y: stepY,
  }));
  const cx = (i: number) => stepNodes[i].x + STEP_W / 2;

  // Sink edges: step → (non-queue) stage. Each such stage is a sink, keyed by the steps reaching it.
  const sinkEdges = edges.flatMap((_e, k) => (stepOf(ends[k].from) >= 0 && stageAt(ends[k].to) && !queueStages.has(stageAt(ends[k].to)!) ? [k] : []));
  const sinkSources = new Map<StageNode, Set<number>>();
  for (const k of sinkEdges) {
    const st = stageAt(ends[k].to)!;
    sinkSources.set(st, (sinkSources.get(st) ?? new Set()).add(stepOf(ends[k].from)));
  }
  // The success exit: a stage whose only edge in is the last step's `advance` sits inline at the end
  // of the step row, so its edge is a straight continuation of the advance chain and crosses nothing.
  const last = steps.length - 1;
  const inline = new Set(
    [...sinkSources.keys()].filter((st) => {
      const into = sinkEdges.filter((k) => stageAt(ends[k].to) === st);
      return into.length === 1 && edges[into[0]].type === "advance" && stepOf(ends[into[0]].from) === last;
    }),
  );
  for (const st of inline) {
    st.x = stepNodes[last].x + STEP_W + STEP_GAP;
    st.y = stepY + (STEP_H - STAGE_H) / 2;
  }
  const isPrivate = (st: StageNode) => !inline.has(st) && sinkSources.get(st)!.size === 1;
  const shared = [...sinkSources.keys()].filter((st) => !inline.has(st) && !isPrivate(st));

  // Shared sinks: one row, each centered under its sources; one channel track per shared stage.
  const privates = steps.map((_s, i) => [...sinkSources.keys()].filter((st) => isPrivate(st) && sinkSources.get(st)!.has(i)));
  const anyPrivate = privates.some((p) => p.length > 0);
  const privY = stepBottom + PRIV_GAP;
  const privBottom = anyPrivate ? privY + STAGE_H : stepBottom;
  const trackY = new Map(shared.map((st, t) => [st, privBottom + TRACK_PAD + t * LANE]));
  const sharedY = privBottom + TRACK_PAD + (shared.length - 1) * LANE + TRACK_DROP;
  placeRow(
    shared.map((st) => ({ node: st, want: mean([...sinkSources.get(st)!].map(cx), 0) })),
    sharedY,
  );
  const scx = (st: StageNode) => st.x + st.w / 2;

  // Per step: bottom ports for its shared edges, then its private pills in the space between them.
  const port = new Map<number, number>();
  steps.forEach((_s, i) => {
    const x = stepNodes[i].x;
    const out = sinkEdges.filter((k) => stepOf(ends[k].from) === i && shared.includes(stageAt(ends[k].to)!));
    const priv = privates[i];
    let lo = x - COL_PAD;
    let hi = x + STEP_W + COL_PAD;
    if (!priv.length) {
      // No pills under this step: spread the ports across its width, leftmost target leftmost.
      out.sort((a, b) => scx(stageAt(ends[a].to)!) - scx(stageAt(ends[b].to)!)).forEach((k, j) => port.set(k, x + (STEP_W * (j + 1)) / (out.length + 1)));
    } else {
      // Pills take the middle; shared edges drop down side lanes, toward their target's side.
      const left = out.filter((k) => scx(stageAt(ends[k].to)!) < cx(i)).sort((a, b) => scx(stageAt(ends[a].to)!) - scx(stageAt(ends[b].to)!));
      const right = out.filter((k) => !left.includes(k)).sort((a, b) => scx(stageAt(ends[b].to)!) - scx(stageAt(ends[a].to)!));
      left.forEach((k, j) => port.set(k, x + LANE_INSET + j * LANE));
      right.forEach((k, j) => port.set(k, x + STEP_W - LANE_INSET - j * LANE));
      if (left.length) lo = x + LANE_INSET + left.length * LANE;
      if (right.length) hi = x + STEP_W - LANE_INSET - right.length * LANE;
      const w = Math.min(STAGE_W, (hi - lo - (priv.length - 1) * PILL_GAP) / priv.length);
      const start = (lo + hi) / 2 - (priv.length * w + (priv.length - 1) * PILL_GAP) / 2;
      priv.forEach((st, j) => Object.assign(st, { x: start + j * (w + PILL_GAP), y: privY, w }));
    }
  });

  // Queue row: each queue stage centered over the step(s) it feeds.
  placeRow(
    [...queueStages].map((st) => ({
      node: st,
      want: mean(
        edges.flatMap((e, k) => (e.type === "queue" && stageAt(ends[k].from) === st ? [cx(stepOf(ends[k].to))] : [])),
        0,
      ),
    })),
    MARGIN,
  );

  const routes: EdgeRoute[] = edges.map((e, k) => {
    const fromStep = stepOf(ends[k].from);
    const toStep = stepOf(ends[k].to);
    const toStage = stageAt(ends[k].to);
    if (e.type === "changes") {
      const a = { x: stepNodes[fromStep].x + STEP_W * 0.25, y: stepY };
      const b = { x: stepNodes[toStep].x + STEP_W * 0.75, y: stepY - END_GAP };
      const control = { x: (a.x + b.x) / 2, y: stepY - 2 * ARC_RISE };
      return { points: [a, b], control, labelAt: quadAt(a, control, b, 0.5) };
    }
    if (e.type === "queue") {
      const st = stageAt(ends[k].from)!;
      const top = st.y + STAGE_H;
      return polyline([
        { x: scx(st), y: top },
        { x: scx(st), y: top + END_GAP * 2 },
        { x: cx(toStep), y: top + END_GAP * 2 },
        { x: cx(toStep), y: stepY - END_GAP },
      ]);
    }
    if (toStep >= 0) {
      const from = stepNodes[fromStep];
      const to = stepNodes[toStep];
      if (!isSkip(k)) return polyline([{ x: from.x + STEP_W, y: midY }, { x: to.x - END_GAP, y: midY }]);
      // Skipping (or going back over) a step: up and over the row.
      const y = stepY - SKIP_RISE;
      return polyline([{ x: from.x + STEP_W - 20, y: stepY }, { x: from.x + STEP_W - 20, y }, { x: to.x + 20, y }, { x: to.x + 20, y: stepY - END_GAP }]);
    }
    const st = toStage!;
    const from = stepNodes[fromStep];
    if (inline.has(st)) return polyline([{ x: from.x + STEP_W, y: midY }, { x: st.x - END_GAP, y: midY }]);
    if (queueStages.has(st)) {
      // A queue stage that's also a step's sink — an odd config; route it generically.
      const a = { x: cx(fromStep), y: stepY };
      const b = { x: scx(st), y: st.y + STAGE_H + END_GAP };
      return polyline([a, { x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 }, b]);
    }
    if (isPrivate(st)) return polyline([{ x: scx(st), y: stepBottom }, { x: scx(st), y: st.y - END_GAP }]);
    const px = port.get(k)!;
    const ty = trackY.get(st)!;
    return polyline([{ x: px, y: stepBottom }, { x: px, y: ty }, { x: scx(st), y: ty }, { x: scx(st), y: st.y - END_GAP }]);
  });

  const nodes: GraphNode[] = [...stepNodes, ...stageNodes.values()];
  // Shift right so nothing (e.g. a private pill reaching left of the first step) starts before MARGIN.
  const shift = MARGIN - nodes.reduce((m, n) => Math.min(m, n.x), MARGIN);
  if (shift) {
    for (const n of nodes) n.x += shift;
    for (const r of routes) {
      for (const p of [...r.points, r.labelAt, ...(r.control ? [r.control] : [])]) p.x += shift;
    }
  }
  const width = nodes.reduce((m, n) => Math.max(m, n.x + nodeRect(n).w), 0) + MARGIN;
  const height = nodes.reduce((m, n) => Math.max(m, n.y + nodeRect(n).h), 0) + MARGIN;

  return { nodes, edges, routes, width, height, unknownStageKeys: keys === null };
}
