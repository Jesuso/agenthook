import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusBadge, STATUS_CLASS, Pill, IconButton, Menu, Card, EmptyState, Tooltip, Segmented } from "./index";
import { STATUS_ORDER } from "../tickets";

describe("StatusBadge", () => {
  for (const status of STATUS_ORDER) {
    it(`${status}: renders its label and status colour`, () => {
      const html = renderToStaticMarkup(createElement(StatusBadge, { status }));
      expect(html).toContain(`>${status}</span>`);
      expect(html).toContain(`text-status-${status} bg-status-${status}-bg`);
      expect(html).toContain(`data-status="${status}"`);
    });
  }

  it("only running pulses", () => {
    for (const status of STATUS_ORDER) {
      const html = renderToStaticMarkup(createElement(StatusBadge, { status }));
      expect(html.includes("animate-status-pulse"), status).toBe(status === "running");
    }
  });

  it("has a class for every status", () => {
    expect(Object.keys(STATUS_CLASS).sort()).toEqual([...STATUS_ORDER].sort());
  });
});

describe("Menu", () => {
  it("renders a closed ⋯ trigger with an accessible label", () => {
    const html = renderToStaticMarkup(createElement(Menu, { label: "profile actions", items: [{ label: "Remove…", onSelect: () => {}, danger: true }] }));
    expect(html).toMatch(/<button[^>]*aria-label="profile actions"[^>]*>⋯<\/button>/);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });
});

describe("IconButton", () => {
  it("names itself via aria-label and title", () => {
    const html = renderToStaticMarkup(createElement(IconButton, { label: "close" }, "×"));
    expect(html).toContain('aria-label="close"');
    expect(html).toContain('title="close"');
    expect(html).toContain('type="button"');
  });
});

describe("the rest", () => {
  it("Pill takes a status tone", () => {
    expect(renderToStaticMarkup(<Pill tone="held">2</Pill>)).toContain("text-status-held");
  });
  it("Card renders its title and body", () => {
    const html = renderToStaticMarkup(<Card title="tickets">body</Card>);
    expect(html).toContain("tickets");
    expect(html).toContain("body");
  });
  it("EmptyState renders title + hint", () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { title: "No tickets", hint: "Nothing is running." }));
    expect(html).toContain("No tickets");
    expect(html).toContain("Nothing is running.");
  });
  it("Tooltip is title-based", () => {
    expect(renderToStaticMarkup(<Tooltip text="why">x</Tooltip>)).toBe('<span title="why">x</span>');
  });
});

describe("Segmented", () => {
  const options = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ];
  it("is a radiogroup with one aria-checked option", () => {
    const html = renderToStaticMarkup(createElement(Segmented, { value: "b", options, onChange: () => {} }));
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/role="radio"[^>]*aria-checked="false"[^>]*>A<\/button>/);
    expect(html).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>B<\/button>/);
  });
});
