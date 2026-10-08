import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BasicsForm } from "./ConfigForms";

// Renaming a profile forks its state dir (src/ui/config.js blocks it server-side); the Basics
// form's `name` field must be read-only so the UI doesn't invite a rename in the first place.
describe("BasicsForm", () => {
  it("renders the name input as read-only", () => {
    const raw = { name: "p", repoPath: "/repo", tracker: { type: "github" } };
    const html = renderToStaticMarkup(createElement(BasicsForm, { text: JSON.stringify(raw), onEdit: () => {}, raw }));
    const m = /<input[^>]*value="p"[^>]*>/.exec(html);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/readonly/i);
  });
});
