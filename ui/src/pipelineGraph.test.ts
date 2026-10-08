import { describe, it, expect } from "vitest";
import { layoutPipeline } from "./pipelineGraph";
import type { GraphEdge, StageNode, StepNode } from "./pipelineGraph";
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
