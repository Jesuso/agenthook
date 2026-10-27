// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";
import { mount, until } from "./domHarness";
import type { Mounted } from "./domHarness";

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
});

describe("MarkdownEditor live mode", () => {
  it("renders headings and emphasis in place, with the markup hidden off the edited line", async () => {
    m = await mount(createElement(MarkdownEditor, { live: true, initial: "# Title\n\nbody **bold** `code`", onChange: () => {} }));
    const h1 = (await until(() => m!.root.querySelector(".cm-live-h1")))!;
    expect(h1.textContent).toBe("Title");
    expect(m.root.querySelector(".cm-live-code")!.textContent).toBe("code");
    expect(m.root.querySelector(".cm-content")!.textContent).not.toContain("**");
  });
});
