// @vitest-environment happy-dom
import { afterEach, describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineGraph } from "./PipelineGraph";
import { layoutPipeline } from "./pipelineGraph";
import { stageKeysFor } from "./configEdit";
import { I18nProvider } from "./i18n/react";
import { setLangSetting } from "./i18n";
import { mount } from "./domHarness";

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

  it("names an opencode step with its provider/model", () => {
    expect(render([{ id: "code", kind: "implement", agent: "opencode", model: "ollama/qwen3.8:27b-64k" }])).toContain("implement · opencode · ollama/qwen3.8:27b-64k");
  });
});

describe("PipelineGraph in Spanish", () => {
  afterEach(() => setLangSetting("en", []));

  it("renders the legend, aria label and the changes arc in Spanish", async () => {
    setLangSetting("es", []);
    const steps = [{ id: "code", kind: "implement" }, { id: "review", kind: "review" }];
    const layout = layoutPipeline(steps, GITHUB, null, undefined, "es");
    const m = await mount(createElement(I18nProvider, null, createElement(PipelineGraph, { layout, onSelectStep: () => {} })));
    const html = m.root.innerHTML;
    await m.unmount();
    expect(html).toContain('aria-label="grafo del pipeline"');
    expect(html).toContain("cambios (destino predeterminado)");
    expect(html).toContain("pasa el cursor sobre una arista");
    expect(html).toContain('aria-label="editar paso code"');
  });
});
