import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineGraph } from "./PipelineGraph";
import { layoutPipeline } from "./pipelineGraph";
import { stageKeysFor } from "./configEdit";

const GITHUB = stageKeysFor(null, "github")!;
const render = (steps: Record<string, unknown>[], defaultAgent?: string) =>
  renderToStaticMarkup(createElement(PipelineGraph, { layout: layoutPipeline(steps, GITHUB, null, defaultAgent) }));

describe("PipelineGraph — step card meta", () => {
  it("names a non-claude agent, hides claude", () => {
    const html = render([
      { id: "code", kind: "implement", agent: "claude" },
      { id: "review", kind: "review", agent: "cursor", model: "auto" },
    ]);
    expect(html).toContain("review · cursor · auto");
    expect(html).toContain(">implement<");
    expect(html).not.toContain("claude");
  });

  it("falls back to the profile's agent", () => {
    expect(render([{ id: "triage", kind: "triage" }], "hermes")).toContain("triage · hermes");
  });
});
