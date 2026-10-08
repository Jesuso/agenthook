import type { StageKeys, StageOption } from "./configEdit";

/**
 * Pure derivation of the Config pipeline graph (docs/web-ui.md § v3 "Pipeline graph") from the
 * live buffer's steps — no DOM, no fetch. Mirrors src/pipeline.js's `stepForStage` match rule and
 * `prevStep` default so the graph agrees with what the receiver actually does at runtime.
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
};

export type GraphNode = StepNode | StageNode;

export type EdgeType = "advance" | "fail" | "hold" | "changes" | "queue";

export type GraphEdge = {
  from: string;
  to: string;
  type: EdgeType;
  label?: string;
};

export type PipelineLayout = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
  /** true when `keys` is null (tracker type unknown) — only step nodes + `changes` edges drawn. */
  unknownStageKeys: boolean;
};

const STEP_W = 180;
const STEP_H = 64;
const STEP_GAP = 60;
const ROW_GAP = 110;
const STAGE_W = 140;
const STAGE_GAP = 24;
const MARGIN = 20;

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

/** Spread nodes left→right (by their current x) so none overlap by less than STAGE_W + STAGE_GAP. */
function spread(nodes: StageNode[]): void {
  nodes
    .sort((a, b) => a.x - b.x)
    .reduce((minX, n) => {
      n.x = Math.max(n.x, minX);
      return n.x + STAGE_W + STAGE_GAP;
    }, -Infinity);
}

export function layoutPipeline(steps: Record<string, unknown>[], keys: StageKeys | null, stages?: StageOption[] | null): PipelineLayout {
  const ids = steps.map((s, i) => str(s.id) ?? `step-${i}`);
  const manual = steps.map((s) => s.manual === true);
  const success = keys ? steps.map((s) => str(s[keys.success])) : steps.map(() => undefined);
  const terminal = steps.map((s, i) => manual[i] || (keys ? success[i] === undefined : false));

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
    x: i * (STEP_W + STEP_GAP) + MARGIN,
    y: ROW_GAP,
  }));
  const stepX = new Map(stepNodes.map((n) => [n.id, n.x + STEP_W / 2]));

  const stageNodes = new Map<string, StageNode>();
  const stageOf = (id: string): StageNode => {
    let n = stageNodes.get(id);
    if (!n) {
      n = { kind: "stage", id, label: labelFor(id, stages), x: 0, y: 0 };
      stageNodes.set(id, n);
    }
    return n;
  };

  const edges: GraphEdge[] = [];
  const belowSources = new Map<string, number[]>();
  const aboveTargets = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, id: string, x: number) => m.set(id, [...(m.get(id) ?? []), x]);

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
        edges.push({ from: ids[i], to: ids[target], type: "advance" });
      } else {
        const node = stageOf(succ);
        edges.push({ from: ids[i], to: node.id, type: "advance" });
        push(belowSources, node.id, stepX.get(ids[i])!);
      }
    });

    steps.forEach((s, i) => {
      if (manual[i]) return;
      const fail = str(s[keys.failure]);
      if (fail !== undefined) {
        edges.push({ from: ids[i], to: stageOf(fail).id, type: "fail" });
        push(belowSources, fail, stepX.get(ids[i])!);
      }
      const hold = str(s[keys.hold]);
      if (hold !== undefined) {
        edges.push({ from: ids[i], to: stageOf(hold).id, type: "hold" });
        push(belowSources, hold, stepX.get(ids[i])!);
      }
    });

    steps.forEach((s, i) => {
      const queue = str(s[keys.queue]);
      if (queue !== undefined) {
        edges.push({ from: stageOf(queue).id, to: ids[i], type: "queue" });
        push(aboveTargets, queue, stepX.get(ids[i])!);
      }
    });
  }

  steps.forEach((s, i) => {
    if (manual[i] || i === 0 || str(s.kind) !== "review") return;
    edges.push({ from: ids[i], to: ids[i - 1], type: "changes", label: "changes (default target)" });
  });

  const belowRow: StageNode[] = [];
  const aboveRow: StageNode[] = [];
  for (const [id, xs] of belowSources) {
    const n = stageOf(id);
    n.x = mean(xs, 0);
    n.y = ROW_GAP * 2;
    belowRow.push(n);
  }
  for (const [id, xs] of aboveTargets) {
    const n = stageOf(id);
    n.x = mean(xs, 0);
    n.y = 0;
    aboveRow.push(n);
  }
  spread(belowRow);
  spread(aboveRow);

  const nodes: GraphNode[] = [...stepNodes, ...belowRow, ...aboveRow];
  const maxX = nodes.reduce((m, n) => Math.max(m, n.x + (n.kind === "step" ? STEP_W : STAGE_W)), 0);
  const maxY = nodes.reduce((m, n) => Math.max(m, n.y + STEP_H), 0);

  return { nodes, edges, width: maxX + MARGIN, height: maxY + MARGIN, unknownStageKeys: keys === null };
}
