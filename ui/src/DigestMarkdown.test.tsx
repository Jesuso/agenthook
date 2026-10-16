import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DigestMarkdown from "./DigestMarkdown";

const render = (text: string) => renderToStaticMarkup(createElement(DigestMarkdown, { text }));

describe("DigestMarkdown", () => {
  it("renders headings, bold and lists instead of raw markdown", () => {
    const html = render("## Title\n\n**Needs you**\n\n- one\n- two");
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<strong>Needs you</strong>");
    expect(html).toContain("<li>one</li>");
    expect(html).not.toContain("##");
  });
  it("escapes raw HTML and drops script URLs (the text is built from third-party ticket content)", () => {
    const html = render('<img src=x onerror="alert(1)"> [x](javascript:alert(1))');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
  });
});
