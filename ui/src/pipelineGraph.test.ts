import { describe, it, expect } from "vitest";
import { MARGIN, STEP_GAP, STEP_W, layoutPipeline, nodeRect, quadAt } from "./pipelineGraph";
import type { GraphEdge, PipelineLayout, Point, StageNode, StepNode } from "./pipelineGraph";
import { stageKeysFor } from "./configEdit";

const GITHUB = stageKeysFor(null, "github")!; // {source:"sourceLabel", success:"successLabel", failure:"failureLabel", hold:"holdLabel", queue:"queueLabel"}
const ASANA = stageKeysFor(null, "asana")!; // {source:"sourceSectionGid", ...}

const edgesOf = (type: GraphEdge["type"], edges: GraphEdge[]) => edges.filter((e) => e.type === type);
const stepNodes = (nodes: (StepNode | StageNode)[]) => nodes.filter((n): n is StepNode => n.kind === "step");
const stageNodes = (nodes: (StepNode | StageNode)[]) => nodes.filter((n): n is StageNode => n.kind === "stage");

describe("layoutPipeline — advance chain", () => {
  it("chains 3 steps and routes the last unmatched success to an exit stage node", () => {
    const steps = [
      { id: "a", sourceLabel: "src-a", successLabel: "src-b" },
      { id: "b", sourceLabel: "src-b", successLabel: "src-c" },
      { id: "c", sourceLabel: "src-c", successLabel: "done" },
    ];
    const { nodes, edges } = layoutPipeline(steps, GITHUB);
    const advance = edgesOf("advance", edges);
    expect(advance).toContainEqual({ from: "a", to: "b", type: "advance" });
    expect(advance).toContainEqual({ from: "b", to: "c", type: "advance" });
    const toExit = advance.find((e) => e.from === "c");
    expect(toExit?.to).not.toBe("a");
    expect(toExit?.to).not.toBe("b");
    expect(toExit?.to).not.toBe("c");
    const exitNode = stageNodes(nodes).find((n) => n.id === toExit?.to);
    expect(exitNode).toBeTruthy();
    expect(exitNode?.id).toBe("done");
  });
});

describe("layoutPipeline — shared failure stage", () => {
  it("dedups a shared failure stage into one node with two edges", () => {
    const steps = [
      { id: "a", sourceLabel: "src-a", successLabel: "src-b", failureLabel: "oops" },
      { id: "b", sourceLabel: "src-b", successLabel: "src-c", failureLabel: "oops" },
    ];
    const { nodes, edges } = layoutPipeline(steps, GITHUB);
    const fail = edgesOf("fail", edges);
    expect(fail).toHaveLength(2);
    expect(fail.every((e) => e.to === "oops")).toBe(true);
    expect(stageNodes(nodes).filter((n) => n.id === "oops")).toHaveLength(1);
  });
});

describe("layoutPipeline — changes edge", () => {
  it("draws review -> previous step, none when review is first", () => {
    const steps = [
      { id: "code", kind: "implement", sourceLabel: "s1", successLabel: "s2" },
      { id: "review", kind: "review", sourceLabel: "s2", successLabel: "s3" },
    ];
    const { edges } = layoutPipeline(steps, GITHUB);
    const changes = edgesOf("changes", edges);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: "review", to: "code", type: "changes" });
    expect(changes[0].label).toMatch(/default target/);

    const firstReview = [{ id: "review", kind: "review", sourceLabel: "s1", successLabel: "s2" }];
    expect(edgesOf("changes", layoutPipeline(firstReview, GITHUB).edges)).toHaveLength(0);
  });
});

describe("layoutPipeline — manual / terminal", () => {
  it("manual steps are terminal with no fail/hold/changes edges; no success is terminal too", () => {
    const steps = [
      { id: "a", kind: "review", manual: true, sourceLabel: "s1", successLabel: "s2", failureLabel: "f", holdLabel: "h" },
      { id: "b", kind: "implement", sourceLabel: "s2" },
    ];
    const { nodes, edges } = layoutPipeline(steps, GITHUB);
    const a = stepNodes(nodes).find((n) => n.id === "a")!;
    const b = stepNodes(nodes).find((n) => n.id === "b")!;
    expect(a.terminal).toBe(true);
    expect(b.terminal).toBe(true); // no successLabel
    expect(edges.filter((e) => e.from === "a")).toHaveLength(0);
  });
});

describe("layoutPipeline — hold + queue", () => {
  it("draws hold -> stage and queue stage -> step", () => {
    const steps = [{ id: "a", sourceLabel: "s1", holdLabel: "waiting", queueLabel: "backlog" }];
    const { nodes, edges } = layoutPipeline(steps, GITHUB);
    expect(edgesOf("hold", edges)).toContainEqual({ from: "a", to: "waiting", type: "hold" });
    expect(edgesOf("queue", edges)).toContainEqual({ from: "backlog", to: "a", type: "queue" });
    expect(stageNodes(nodes).map((n) => n.id).sort()).toEqual(["backlog", "waiting"]);
  });
});

describe("layoutPipeline — labels", () => {
  it("uses the discover label when present, else the raw id", () => {
    const steps = [{ id: "a", sourceLabel: "s1", failureLabel: "fail-stage" }];
    const { nodes } = layoutPipeline(steps, GITHUB, [{ id: "fail-stage", label: "Failed" }]);
    expect(stageNodes(nodes)[0].label).toBe("Failed");
    const noLabel = layoutPipeline(steps, GITHUB, null);
    expect(stageNodes(noLabel.nodes)[0].label).toBe("fail-stage");
  });
});

describe("layoutPipeline — case sensitivity by tracker", () => {
  it("GitHub labels match case-insensitively; Asana gids match exactly", () => {
    const ghSteps = [
      { id: "code", sourceLabel: "agent:code", successLabel: "Agent:Review" },
      { id: "review", sourceLabel: "agent:review", successLabel: "agent:done" },
    ];
    const gh = layoutPipeline(ghSteps, GITHUB);
    expect(edgesOf("advance", gh.edges)).toContainEqual({ from: "code", to: "review", type: "advance" });

    const asanaSteps = [
      { id: "code", sourceSectionGid: "111", successSectionGid: "222" },
      { id: "review", sourceSectionGid: "222-other", successSectionGid: "333" },
    ];
    const asana = layoutPipeline(asanaSteps, ASANA);
    const advance = edgesOf("advance", asana.edges).find((e) => e.from === "code");
    expect(advance?.to).not.toBe("review"); // "222" !== "222-other": exact match required
  });
});

describe("layoutPipeline — unknown tracker", () => {
  it("returns step nodes and only changes edges, no stage nodes", () => {
    const steps = [
      { id: "code", kind: "implement" },
      { id: "review", kind: "review" },
    ];
    const { nodes, edges, unknownStageKeys } = layoutPipeline(steps, null);
    expect(unknownStageKeys).toBe(true);
    expect(stageNodes(nodes)).toHaveLength(0);
    expect(edges.every((e) => e.type === "changes")).toBe(true);
    expect(edges).toHaveLength(1);
  });
});

// --- Geometry invariants -------------------------------------------------------------------------

/** The dogfood pipeline: three agent steps sharing one fail + one hold label, then a manual done. */
const agentStep = (id: string, kind: string, next: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  sourceLabel: `agent:${id}`,
  successLabel: `agent:${next}`,
  failureLabel: "agent:blocked",
  holdLabel: "agent:needs-info",
  ...extra,
});
const DOGFOOD = [
  agentStep("triage", "triage", "code"),
  agentStep("code", "implement", "review"),
  agentStep("review", "review", "done"),
  { id: "done", manual: true, drainWorktree: true, sourceLabel: "agent:done" },
];
/** Same chain with no done step, so `agent:done` is an exit stage. */
const DOGFOOD_EXIT = DOGFOOD.slice(0, 3);
/** Every step has its own fail and hold stages. */
const PRIVATE = ["a", "b", "c"].map((id, i, all) => ({
  id,
  sourceLabel: `s-${id}`,
  successLabel: all[i + 1] ? `s-${all[i + 1]}` : "done",
  failureLabel: `${id}-failed`,
  holdLabel: `${id}-waiting`,
}));
/** Dogfood with a queue stage on triage, plus a step with one private sink alongside the shared ones. */
const QUEUED = [
  agentStep("triage", "triage", "code", { queueLabel: "agent:backlog" }),
  agentStep("code", "implement", "review", { failureLabel: "code-broke" }),
  agentStep("review", "review", "done"),
  { id: "done", manual: true, sourceLabel: "agent:done" },
];

const SHAPES: [string, Record<string, unknown>[]][] = [
  ["dogfood", DOGFOOD],
  ["dogfood with exit stage", DOGFOOD_EXIT],
  ["private sinks", PRIVATE],
  ["queue stage + mixed sinks", QUEUED],
];

type Seg = [Point, Point];
const segments = (pts: Point[]): Seg[] => pts.slice(1).map((p, i) => [pts[i], p]);
const rectOf = (layout: PipelineLayout, id: string, kind: "step" | "stage") => nodeRect(layout.nodes.find((n) => n.id === id && n.kind === kind)!);
/** Does an axis-aligned segment enter the open interior of rect `r`? */
function hitsRect([a, b]: Seg, r: { x: number; y: number; w: number; h: number }): boolean {
  const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return x1 > r.x && x0 < r.x + r.w && y1 > r.y && y0 < r.y + r.h;
}
/** Do two axis-aligned segments touch or cross? */
function crosses([a, b]: Seg, [c, d]: Seg): boolean {
  const box = (p: Point, q: Point) => ({ x0: Math.min(p.x, q.x), x1: Math.max(p.x, q.x), y0: Math.min(p.y, q.y), y1: Math.max(p.y, q.y) });
  const [s, t] = [box(a, b), box(c, d)];
  return s.x0 <= t.x1 && t.x0 <= s.x1 && s.y0 <= t.y1 && t.y0 <= s.y1;
}
const routesOf = (layout: PipelineLayout, types: GraphEdge["type"][]) =>
  layout.edges.flatMap((e, i) => (types.includes(e.type) ? [{ edge: e, route: layout.routes[i] }] : []));

describe("layoutPipeline — geometry", () => {
  it.each(SHAPES)("%s: returns one route per edge", (_n, steps) => {
    const layout = layoutPipeline(steps, GITHUB);
    expect(layout.routes).toHaveLength(layout.edges.length);
    for (const r of layout.routes) expect(r.points.length).toBeGreaterThanOrEqual(2);
  });

  it.each(SHAPES)("%s: no two nodes overlap", (_n, steps) => {
    const { nodes } = layoutPipeline(steps, GITHUB);
    for (const [i, a] of nodes.entries()) {
      for (const b of nodes.slice(i + 1)) {
        const [p, q] = [nodeRect(a), nodeRect(b)];
        const overlap = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it.each(SHAPES)("%s: fail/hold/queue routes are orthogonal, cross no advance line and no other step", (_n, steps) => {
    const layout = layoutPipeline(steps, GITHUB);
    const advance = routesOf(layout, ["advance"])
      .filter(({ edge }) => layout.nodes.some((n) => n.kind === "step" && n.id === edge.to))
      .flatMap(({ route }) => segments(route.points));
    expect(advance.length).toBeGreaterThan(0);
    const sinks = routesOf(layout, ["fail", "hold", "queue"]);
    expect(sinks.length).toBeGreaterThan(0);
    for (const { edge, route } of sinks) {
      for (const seg of segments(route.points)) {
        expect(seg[0].x === seg[1].x || seg[0].y === seg[1].y, `${edge.type} ${edge.from}→${edge.to} is diagonal`).toBe(true);
        for (const adv of advance) expect(crosses(seg, adv), `${edge.type} ${edge.from}→${edge.to} crosses an advance line`).toBe(false);
        for (const n of stepNodes(layout.nodes)) {
          if (n.id === edge.from || n.id === edge.to) continue;
          expect(hitsRect(seg, nodeRect(n)), `${edge.type} ${edge.from}→${edge.to} passes through ${n.id}`).toBe(false);
        }
      }
    }
  });

  it("a shared sink stays one node, centered under its sources", () => {
    const layout = layoutPipeline(DOGFOOD, GITHUB);
    expect(stageNodes(layout.nodes).map((n) => n.id).sort()).toEqual(["agent:blocked", "agent:needs-info"]);
    const steps = stepNodes(layout.nodes).filter((n) => !n.manual);
    const sourceMid = steps.reduce((m, n) => m + n.x + STEP_W / 2, 0) / steps.length;
    const [blocked, needs] = [rectOf(layout, "agent:blocked", "stage"), rectOf(layout, "agent:needs-info", "stage")];
    expect((blocked.x + blocked.w / 2 + needs.x + needs.w / 2) / 2).toBeCloseTo(sourceMid, 5);
    // Below the step row, with every edge into it coming off a step's bottom edge.
    const stepBottom = steps[0].y + nodeRect(steps[0]).h;
    expect(blocked.y).toBeGreaterThan(stepBottom);
    for (const { route } of routesOf(layout, ["fail", "hold"])) expect(route.points[0].y).toBe(stepBottom);
    // Fail and hold leave each step at different x.
    for (const n of steps) {
      const starts = routesOf(layout, ["fail", "hold"]).filter(({ edge }) => edge.from === n.id).map(({ route }) => route.points[0].x);
      expect(new Set(starts).size).toBe(starts.length);
    }
  });

  it("a private sink sits under its step's column", () => {
    for (const steps of [PRIVATE, QUEUED]) {
      const layout = layoutPipeline(steps, GITHUB);
      const privates = layout.edges.filter((e) => (e.type === "fail" || e.type === "hold") && layout.edges.filter((f) => f.to === e.to && f.type !== "queue").length === 1);
      expect(privates.length).toBeGreaterThan(0);
      for (const e of privates) {
        const step = rectOf(layout, e.from, "step");
        const pill = rectOf(layout, e.to, "stage");
        expect(pill.x).toBeGreaterThanOrEqual(step.x - STEP_GAP / 2);
        expect(pill.x + pill.w).toBeLessThanOrEqual(step.x + STEP_W + STEP_GAP / 2);
        expect(pill.y).toBeGreaterThan(step.y + step.h);
      }
    }
  });

  it("the success exit sits inline at the end of the step row", () => {
    const layout = layoutPipeline(DOGFOOD_EXIT, GITHUB);
    const review = rectOf(layout, "review", "step");
    const done = rectOf(layout, "agent:done", "stage");
    expect(done.x).toBeGreaterThan(review.x + review.w);
    expect(done.y + done.h / 2).toBe(review.y + review.h / 2);
    const route = layout.routes[layout.edges.findIndex((e) => e.to === "agent:done")];
    expect(route.points).toHaveLength(2);
    expect(route.points[0].y).toBe(route.points[1].y);
  });

  it("the changes label lies on the arc (its t=0.5 point), not at the control point", () => {
    const layout = layoutPipeline(DOGFOOD, GITHUB);
    const i = layout.edges.findIndex((e) => e.type === "changes");
    const { points, control, labelAt } = layout.routes[i];
    expect(control).toBeTruthy();
    const mid = quadAt(points[0], control!, points[points.length - 1], 0.5);
    expect(Math.hypot(labelAt.x - mid.x, labelAt.y - mid.y)).toBeLessThan(1);
    expect(labelAt.y).toBeGreaterThan(control!.y);
    // The arc clears the top of the step row.
    expect(labelAt.y).toBeLessThan(rectOf(layout, "code", "step").y);
  });

  it("with no queue stage and no changes edge the step row sits at MARGIN and the height is tight", () => {
    const layout = layoutPipeline(PRIVATE, GITHUB);
    for (const n of stepNodes(layout.nodes)) expect(n.y).toBe(MARGIN);
    const bottom = Math.max(...layout.nodes.map((n) => nodeRect(n).y + nodeRect(n).h));
    expect(layout.height).toBe(bottom + MARGIN);
    const right = Math.max(...layout.nodes.map((n) => nodeRect(n).x + nodeRect(n).w));
    expect(layout.width).toBe(right + MARGIN);
    expect(Math.min(...layout.nodes.map((n) => n.x))).toBe(MARGIN);
  });

  it("reserves a queue row above the steps only when a queue stage exists", () => {
    const queued = layoutPipeline(QUEUED, GITHUB);
    const backlog = rectOf(queued, "agent:backlog", "stage");
    const triage = rectOf(queued, "triage", "step");
    expect(backlog.y).toBe(MARGIN);
    expect(backlog.y + backlog.h).toBeLessThan(triage.y);
    expect(backlog.x + backlog.w / 2).toBe(triage.x + triage.w / 2);
    const plain = layoutPipeline(DOGFOOD, GITHUB); // changes arc, no queue: less headroom
    expect(rectOf(plain, "triage", "step").y).toBeLessThan(triage.y);
  });
});
