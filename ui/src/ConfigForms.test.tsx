import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BasicsForm, ModelField, modelSelectState, summarizeStep } from "./ConfigForms";

/** Depth-first search of a React element tree for a node whose `props[key] === value`. */
function findByProp(node: any, key: string, value: string): any {
  if (!node || typeof node !== "object") return null;
  if (node.props?.[key] === value) return node;
  const children = node.props?.children;
  for (const c of Array.isArray(children) ? children : [children]) {
    const found = findByProp(c, key, value);
    if (found) return found;
  }
  return null;
}

// A rename now keeps the state dir in place by inserting "stateId" (src/ui/config.js guards the
// save server-side), so the Basics form's `name` field is editable again — unlike the #192
// read-only stopgap this replaces.
describe("BasicsForm", () => {
  it("renders the name input as editable (not read-only)", () => {
    const raw = { name: "p", repoPath: "/repo", tracker: { type: "github" } };
    const html = renderToStaticMarkup(createElement(BasicsForm, { text: JSON.stringify(raw), onEdit: () => {}, raw, stateKey: "p" }));
    const m = /<input[^>]*name="name"[^>]*>/.exec(html);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/value="p"/);
    expect(m![0]).not.toMatch(/readonly/i);
  });

  it("editing the name field emits a buffer with stateId set to the passed state key", () => {
    const text = JSON.stringify({ name: "p", repoPath: "/repo" });
    const onEdit = vi.fn();
    const el: any = BasicsForm({ text, onEdit, raw: JSON.parse(text), stateKey: "p" });
    const input = findByProp(el, "name", "name");
    input.props.onChange({ target: { value: "renamed" } });

    expect(onEdit).toHaveBeenCalledTimes(1);
    const next = JSON.parse(onEdit.mock.calls[0][0]);
    expect(next).toEqual({ name: "renamed", repoPath: "/repo", stateId: "p" });
  });

  it("does not insert a second stateId when one is already present", () => {
    const text = JSON.stringify({ name: "p", repoPath: "/repo", stateId: "p" });
    const onEdit = vi.fn();
    const el: any = BasicsForm({ text, onEdit, raw: JSON.parse(text), stateKey: "p" });
    const input = findByProp(el, "name", "name");
    input.props.onChange({ target: { value: "renamed" } });

    const next = JSON.parse(onEdit.mock.calls[0][0]);
    expect(next).toEqual({ name: "renamed", repoPath: "/repo", stateId: "p" });
  });
});

describe("modelSelectState", () => {
  it("selects a known model directly", () => {
    expect(modelSelectState("claude-opus-5-5")).toEqual({ selectValue: "claude-opus-5-5", showCustom: false });
  });

  it("selects (default) for an empty value", () => {
    expect(modelSelectState("")).toEqual({ selectValue: "", showCustom: false });
  });

  it("routes an unknown value to the custom input without altering it", () => {
    expect(modelSelectState("sonnet")).toEqual({ selectValue: "__custom__", showCustom: true });
    expect(modelSelectState("claude-opus-4-8")).toEqual({ selectValue: "__custom__", showCustom: true });
  });
});

describe("ModelField", () => {
  it("renders a known value as the selected option, no custom input", () => {
    const onEdit = vi.fn();
    const html = renderToStaticMarkup(createElement(ModelField, { text: "{}", onEdit, label: "Model", path: ["model"], value: "claude-sonnet-5" }));
    expect(html).toMatch(/<option value="claude-sonnet-5"[^>]*selected[^>]*>/);
    expect(html).not.toContain('placeholder="model name"');
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("renders an unrecognized value in the custom input, unchanged, without editing on render", () => {
    const onEdit = vi.fn();
    const html = renderToStaticMarkup(createElement(ModelField, { text: "{}", onEdit, label: "Model", path: ["model"], value: "sonnet" }));
    expect(html).toMatch(/<input[^>]*placeholder="model name"[^>]*value="sonnet"[^>]*>/);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("(default) is the select's empty-value option, which removes the key via textEdit", () => {
    const onEdit = vi.fn();
    const el: any = createElement(ModelField, { text: '{"model":"claude-sonnet-5"}', onEdit, label: "Model", path: ["model"], value: "claude-sonnet-5" });
    // The rendered <select>'s first option is always "(default)" at value="".
    const html = renderToStaticMarkup(el);
    expect(html).toMatch(/<option value="">\(default\)<\/option>/);
  });
});

describe("summarizeStep", () => {
  it("omits absent parts and joins the rest with · ", () => {
    expect(summarizeStep({ kind: "implement", model: "claude-opus-5-5" }, null, null)).toBe("implement · claude-opus-5-5");
  });

  it("returns empty string when nothing is set", () => {
    expect(summarizeStep({}, null, null)).toBe("");
  });

  it("renders a source → success transition via the discovered label when available", () => {
    const keys = { source: "sourceLabel", success: "successLabel", failure: "failureLabel", hold: "holdLabel", queue: "queueLabel" };
    const stageList = [{ id: "agent:code", label: "Code" }, { id: "agent:review", label: "Review" }];
    const s = { kind: "implement", sourceLabel: "agent:code", successLabel: "agent:review" };
    expect(summarizeStep(s, keys, stageList)).toBe("implement · Code → Review");
  });

  it("falls back to the raw id when the stage isn't in the discovered list", () => {
    const keys = { source: "sourceLabel", success: "successLabel", failure: "failureLabel", hold: "holdLabel", queue: "queueLabel" };
    const s = { sourceLabel: "agent:code" };
    expect(summarizeStep(s, keys, null)).toBe("agent:code");
  });
});
