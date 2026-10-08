import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BasicsForm } from "./ConfigForms";

// A rename now keeps the state dir in place by inserting "stateId" (src/ui/config.js guards the
// save server-side), so the Basics form's `name` field is editable again — unlike the #192
// read-only stopgap this replaces.
describe("BasicsForm", () => {
  it("renders the name input as editable (not read-only)", () => {
    const raw = { name: "p", repoPath: "/repo", tracker: { type: "github" } };
    const html = renderToStaticMarkup(
      createElement(BasicsForm, { text: JSON.stringify(raw), onEdit: () => {}, raw, stateKey: "p" }),
    );
    const m = /<input[^>]*value="p"[^>]*>/.exec(html);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/readonly/i);
  });

  it("editing the name field emits a buffer with stateId set to the passed state key", () => {
    const text = JSON.stringify({ name: "p", repoPath: "/repo" });
    const onEdit = vi.fn();
    // BasicsForm and the plain `<Field>` it wraps the name input in use no hooks, so the element
    // tree can be read directly without a DOM: the name field is the form's first child, and its
    // single child is the input we want to drive.
    const el: any = BasicsForm({ text, onEdit, raw: JSON.parse(text), stateKey: "p" });
    const nameField = el.props.children[0];
    const input = nameField.props.children;
    input.props.onChange({ target: { value: "renamed" } });

    expect(onEdit).toHaveBeenCalledTimes(1);
    const next = JSON.parse(onEdit.mock.calls[0][0]);
    expect(next).toEqual({ name: "renamed", repoPath: "/repo", stateId: "p" });
  });

  it("does not insert a second stateId when one is already present", () => {
    const text = JSON.stringify({ name: "p", repoPath: "/repo", stateId: "p" });
    const onEdit = vi.fn();
    const el: any = BasicsForm({ text, onEdit, raw: JSON.parse(text), stateKey: "p" });
    const input = el.props.children[0].props.children;
    input.props.onChange({ target: { value: "renamed" } });

    const next = JSON.parse(onEdit.mock.calls[0][0]);
    expect(next).toEqual({ name: "renamed", repoPath: "/repo", stateId: "p" });
  });
});
