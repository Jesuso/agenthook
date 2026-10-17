import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BasicsForm, ModelField, modelSelectState, openAfterMove, openAfterRemove, summarizeStep } from "./ConfigForms";

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
    const html = renderToStaticMarkup(createElement(ModelField, { text: "{}", onEdit, path: ["tracker", "pipeline", 0, "model"], value: "claude-sonnet-5" }));
    expect(html).toMatch(/<option value="claude-sonnet-5"[^>]*selected[^>]*>/);
    expect(html).not.toContain('placeholder="model name"');
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("renders an unrecognized value in the custom input, unchanged, without editing on render", () => {
    const onEdit = vi.fn();
    const html = renderToStaticMarkup(createElement(ModelField, { text: "{}", onEdit, path: ["tracker", "pipeline", 0, "model"], value: "sonnet" }));
    expect(html).toMatch(/<input[^>]*placeholder="model name"[^>]*value="sonnet"[^>]*>/);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("(default) is the select's empty-value option, which removes the key via textEdit", () => {
    const onEdit = vi.fn();
    const el: any = createElement(ModelField, { text: '{"model":"claude-sonnet-5"}', onEdit, path: ["tracker", "pipeline", 0, "model"], value: "claude-sonnet-5" });
    // The rendered <select>'s first option is always "(default)" at value="".
    const html = renderToStaticMarkup(el);
    expect(html).toMatch(/<option value="">\(default\)<\/option>/);
  });
});

describe("summarizeStep", () => {
  const asana = { source: "sourceSectionGid", success: "successSectionGid", failure: "failureSectionGid", hold: "holdSectionGid", queue: "queueSectionGid" };
  const jira = { source: "sourceStatus", success: "successStatus", failure: "failureStatus", hold: "holdStatus", queue: "queueStatus" };
  const github = { source: "sourceLabel", success: "successLabel", failure: "failureLabel", hold: "holdLabel", queue: "queueLabel" };

  it("returns empty string when nothing is set", () => {
    expect(summarizeStep({}, null, null)).toBe("");
    expect(summarizeStep({}, github, null)).toBe("");
  });

  it("asana: resolves section gids to their names through the stage list", () => {
    const stageList = [
      { id: "1201", label: "Ready" },
      { id: "1202", label: "In review" },
      { id: "1203", label: "Blocked" },
    ];
    const s = { kind: "implement", sourceSectionGid: "1201", successSectionGid: "1202", failureSectionGid: "1203" };
    expect(summarizeStep(s, asana, stageList)).toBe("implement · Ready → In review / Blocked");
  });

  it("jira: statuses, with the failure lane only when set", () => {
    const stageList = [
      { id: "To Do", label: "To Do" },
      { id: "In Review", label: "In Review" },
    ];
    expect(summarizeStep({ kind: "review", sourceStatus: "In Review", successStatus: "Done" }, jira, stageList)).toBe("review · In Review → Done");
    expect(summarizeStep({ sourceStatus: "To Do", successStatus: "In Review", failureStatus: "Failed" }, jira, stageList)).toBe("To Do → In Review / Failed");
  });

  it("github: labels, raw values when there is no stage list", () => {
    const s = { kind: "implement", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:failed" };
    expect(summarizeStep(s, github, null)).toBe("implement · agent:code → agent:review / agent:failed");
    expect(summarizeStep({ sourceLabel: "agent:code" }, github, null)).toBe("agent:code");
    expect(summarizeStep({ successLabel: "agent:review" }, github, null)).toBe("→ agent:review");
    expect(summarizeStep({ failureLabel: "agent:failed" }, github, null)).toBe("→ — / agent:failed");
  });

  it("uses the discovered label when known and the raw value otherwise", () => {
    const stageList = [{ id: "agent:code", label: "Code" }];
    expect(summarizeStep({ sourceLabel: "agent:code", successLabel: "agent:review" }, github, stageList)).toBe("Code → agent:review");
  });

  it("flags follow the lanes; model / effort only when the step overrides them", () => {
    const s = { kind: "triage", sourceLabel: "a", successLabel: "b", manual: true, createsWorktree: true, drainWorktree: true, model: "claude-opus-5-5", effort: "high" };
    expect(summarizeStep(s, github, null)).toBe("triage · a → b · manual · worktree · drain · claude-opus-5-5 · high");
    expect(summarizeStep({ kind: "implement", manual: false, createsWorktree: false }, github, null)).toBe("implement");
    expect(summarizeStep({ kind: "implement", effort: "low" }, null, null)).toBe("implement · low");
  });

  it("does not repeat the step id", () => {
    expect(summarizeStep({ id: "code", kind: "implement" }, null, null)).toBe("implement");
  });

  it("appends +N advanced only when N > 0; leaves the summary unchanged when N is 0 or omitted", () => {
    expect(summarizeStep({ kind: "implement" }, null, null, 0)).toBe("implement");
    expect(summarizeStep({ kind: "implement" }, null, null)).toBe("implement");
    expect(summarizeStep({ kind: "implement" }, null, null, 2)).toBe("implement · +2 advanced");
  });
});

describe("openAfterMove / openAfterRemove", () => {
  it("swaps the two moved cards' open state", () => {
    expect([...openAfterMove(new Set([0, 3]), 0, 1)].sort()).toEqual([1, 3]);
    expect([...openAfterMove(new Set([1, 2]), 2, -1)].sort()).toEqual([1, 2]);
  });

  it("drops the removed card and shifts the later ones up", () => {
    expect([...openAfterRemove(new Set([0, 2, 4]), 2)].sort()).toEqual([0, 3]);
  });
});

describe("AppearanceFields (in BasicsForm)", () => {
  const render = (raw: object) => renderToStaticMarkup(createElement(BasicsForm, { text: JSON.stringify(raw), onEdit: () => {}, raw, stateKey: "p" }));

  it("renders the palette, marks 'automatic' when no colour is set and the chosen swatch when one is", () => {
    const auto = render({ name: "p", repoPath: "/r" });
    expect(auto).toContain("data-appearance");
    expect(auto.match(/data-color="/g)).toHaveLength(8);
    expect(auto).toMatch(/aria-checked="true"[^>]*>automatic</);
    expect(auto).toContain("automatic · shows on Home");
    const set = render({ name: "p", repoPath: "/r", ui: { color: "teal" } });
    expect(set).toMatch(/aria-checked="true"[^>]*aria-label="teal"/);
    expect(set).toContain("custom · shows on Home");
  });

  it("previews the configured emoji, else the derived one", () => {
    expect(render({ name: "p", repoPath: "/r", ui: { emoji: "🦊" } })).toContain(">🦊</span>");
  });
});
