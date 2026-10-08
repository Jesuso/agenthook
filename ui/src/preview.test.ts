import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";

// The Instructions preview renders the live buffer with react-markdown and no rehype-raw:
// raw HTML in a buffer must come out as text, never as elements.
const render = (md: string) => renderToStaticMarkup(createElement(Markdown, null, md));

describe("instructions preview", () => {
  it("renders markdown", () => {
    expect(render("# Title\n\n**bold**")).toContain("<h1>Title</h1>");
  });

  it("does not render raw HTML", () => {
    const html = render("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
  });

  it("drops javascript: link targets", () => {
    expect(render("[x](javascript:alert(1))")).not.toContain("javascript:");
  });
});
