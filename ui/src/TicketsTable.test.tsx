import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TicketsTable } from "./TicketsTable";
import type { TicketsTableProps } from "./TicketsTable";
import type { TicketRow } from "./contract";

const NOW = Date.parse("2026-10-08T12:00:00Z");

function ticket(overrides: Partial<TicketRow> & { ref: string }): TicketRow {
  return {
    profile: "agenthook",
    displayId: `#${overrides.ref}`,
    title: `Ticket ${overrides.ref}`,
    step: "code",
    status: "done",
    model: null,
    startedAt: new Date(NOW - 60_000).toISOString(),
    costUsd: 0,
    trackerUrl: null,
    prUrl: null,
    heldReason: null,
    ...overrides,
  };
}

const render = (tickets: TicketRow[], over: Partial<TicketsTableProps> = {}) =>
  renderToStaticMarkup(
    createElement(TicketsTable, {
      tickets,
      profiles: [],
      now: NOW,
      profileFilter: "",
      onProfileFilter: () => {},
      statusFilter: "",
      onStatusFilter: () => {},
      showAll: false,
      onShowAll: () => {},
      open: null,
      onOpen: () => {},
      ...over,
    }),
  );

const rowCount = (html: string) => (html.match(/data-ticket-row=/g) ?? []).length;
const many = (n: number) => Array.from({ length: n }, (_, i) => ticket({ ref: String(1000 + i) }));

describe("TicketsTable", () => {
  it("renders the first 50 rows and a show-more button with the remainder", () => {
    const html = render(many(60));
    expect(rowCount(html)).toBe(50);
    expect(html).toMatch(/show (<!-- -->)?50(<!-- -->)? more \((<!-- -->)?10(<!-- -->)? remaining\)/);
    expect(html).toMatch(/50(<!-- -->)? shown \/ (<!-- -->)?60(<!-- -->)? total/);
  });

  it("no show-more button when everything fits", () => {
    const html = render(many(12));
    expect(rowCount(html)).toBe(12);
    expect(html).not.toContain("remaining)");
  });

  it("scrolls in its own region under a sticky header", () => {
    const html = render(many(3));
    expect(html).toMatch(/<div class="[^"]*max-h-\[60vh\] overflow-auto[^"]*" data-tickets-scroll/);
    expect(html).toMatch(/<thead class="sticky top-0[^"]*bg-surface/);
  });

  it("links the id with ↗ and the PR as #n (falling back to PR)", () => {
    const html = render([
      ticket({ ref: "221", trackerUrl: "https://github.com/Jesuso/agenthook/issues/221", prUrl: "https://github.com/Jesuso/agenthook/pull/230" }),
      ticket({ ref: "222", prUrl: "https://example.com/merge-requests/9" }),
    ]);
    expect(html).toMatch(/<a class="text-accent hover:underline" href="https:\/\/github.com\/Jesuso\/agenthook\/issues\/221"[^>]*>#221<span aria-hidden="true"> ↗<\/span><\/a>/);
    expect(html).toMatch(/href="https:\/\/github.com\/Jesuso\/agenthook\/pull\/230"[^>]*>#230<\/a>/);
    expect(html).toMatch(/href="https:\/\/example.com\/merge-requests\/9"[^>]*>PR<\/a>/);
  });

  it("pins and tints needs-attention rows", () => {
    const html = render([
      ticket({ ref: "1", status: "running" }),
      ticket({ ref: "2", status: "held", heldReason: "x".repeat(150) }),
      ticket({ ref: "3", status: "interrupted" }),
    ]);
    const order = [...html.matchAll(/data-ticket-row="(\d+)"/g)].map((m) => m[1]);
    expect(order.slice(0, 2).sort()).toEqual(["2", "3"]);
    expect(order[2]).toBe("1");
    expect(html).toMatch(/data-ticket-row="2" class="[^"]*bg-status-held-bg\/40/);
    expect(html).toMatch(/data-ticket-row="3" class="[^"]*bg-status-failed-bg\/40/);
    expect(html).not.toMatch(/data-ticket-row="1" class="[^"]*bg-status-/);
  });

  it("keeps the held reason and title to one line, full text in the title", () => {
    const reason = "y".repeat(150);
    const html = render([ticket({ ref: "2", status: "held", heldReason: reason, title: "A long title" })]);
    expect(html).toContain(`<span title="${reason}"><span class="block max-w-64 truncate">${reason}</span></span>`);
    expect(html).toMatch(/<div title="A long title" class="min-w-40 max-w-md truncate max-lg:max-w-64 max-lg:whitespace-normal max-lg:line-clamp-2 ">A long title<\/div>/);
  });

  it("shows the model alias with the full id as its tooltip", () => {
    const html = render([ticket({ ref: "1", model: "claude-opus-5-5" })]);
    expect(html).toContain('title="claude-opus-5-5">opus 5.5</td>');
  });

  it("labels each present status chip with its count; needs you = held + failed", () => {
    const html = render([ticket({ ref: "1", status: "held" }), ticket({ ref: "2", status: "failed" }), ticket({ ref: "3", status: "interrupted" }), ticket({ ref: "4" })]);
    const chip = (label: string, n: number) => new RegExp(`role="radio"[^>]*>${label} <span class="font-mono opacity-70">${n}</span></button>`);
    expect(html).toMatch(chip("all", 4));
    expect(html).toMatch(chip("needs you", 2));
    expect(html).toMatch(chip("held", 1));
    expect(html).toMatch(chip("interrupted", 1));
    expect(html).toMatch(chip("done", 1));
    expect(html).not.toMatch(/>running <span/);
  });
});
