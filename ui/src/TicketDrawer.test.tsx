import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TicketDrawer } from "./TicketDrawer";
import type { TicketRow } from "./contract";

const row: TicketRow = {
  profile: "agenthook",
  ref: "221",
  displayId: "#221",
  title: "Polish (1/11): design tokens",
  step: "code",
  status: "running",
  model: "opus",
  startedAt: null,
  costUsd: 1.25, estUsd: 0,
  trackerUrl: "https://github.com/Jesuso/agenthook/issues/221",
  prUrl: "https://github.com/Jesuso/agenthook/pull/230",
  summary: null, heldReason: null,
  heldAt: null,
  failReason: null,
  prState: null,
  finishedAt: null,
  queuePos: null, epic: null,
};

const render = (ticket: TicketRow | undefined) =>
  renderToStaticMarkup(createElement(TicketDrawer, { profile: "agenthook", ticketRef: "221", ticket, runsNonce: 0, onClose: () => {} }));

describe("TicketDrawer", () => {
  it("shows the ticket's summary under the header, and nothing when it has none", () => {
    expect(render({ ...row, summary: "Why this ticket exists." })).toMatch(/data-drawer-summary[^>]*>Why this ticket exists\.</);
    expect(render(row)).not.toContain("data-drawer-summary");
  });

  it("is a labelled modal dialog over a backdrop", () => {
    const html = render(row);
    expect(html).toMatch(/^<div class="fixed inset-0 z-40 bg-black\/40">/);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Ticket #221"');
    expect(html).toContain("md:w-[720px]");
  });

  it("headers the ticket: tracker link, title, status, profile, PR #n, cost, close", () => {
    const html = render(row);
    expect(html).toMatch(/<a [^>]*href="https:\/\/github.com\/Jesuso\/agenthook\/issues\/221"[^>]*>#221 ↗<\/a>/);
    expect(html).toContain('title="Polish (1/11): design tokens"');
    expect(html).toContain('data-status="running"');
    expect(html).toMatch(/<a [^>]*href="https:\/\/github.com\/Jesuso\/agenthook\/pull\/230"[^>]*rel="noopener noreferrer"[^>]*>PR #(<!-- -->)?230<\/a>/);
    expect(html).toContain("$1.25");
    expect(html).toContain('aria-label="Close"');
  });

  it("ticket total is a dash when only unpriced (non-Claude / local-model) runs exist", () => {
    // run_end of an unpriced run carries no costUsd, so the ticket's summed cost stays 0.
    const html = render({ ...row, costUsd: 0, estUsd: 0 });
    expect(html).toMatch(/title="total cost:[^"]*">—</);
    expect(html).not.toContain("$");
  });

  it("falls back to the ref when the row is filtered out of the snapshot", () => {
    const html = render(undefined);
    expect(html).toContain('<span class="shrink-0 font-mono">221</span>');
    expect(html).not.toContain("PR #");
    expect(html).not.toContain("data-status");
  });

  it("no PR link without a prUrl, plain id without a trackerUrl", () => {
    const html = render({ ...row, prUrl: null, trackerUrl: null, title: null });
    expect(html).not.toContain("PR #");
    expect(html).toContain('<span class="shrink-0 font-mono">#221</span>');
    expect(html).toContain('<span class="text-muted">(title unknown — appears after its next run)</span>');
  });
});
