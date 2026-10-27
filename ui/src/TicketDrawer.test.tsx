import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TicketDrawer } from "./TicketDrawer";
import type { TicketRow } from "./contract";
import type { ReleaseOutcome } from "./config";

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
  summary: null, plain: null, options: null, heldReason: null,
  heldAt: null,
  failReason: null,
  prState: null, prNeeds: null,
  finishedAt: null,
  queuePos: null, epic: null,
};

const render = (ticket: TicketRow | undefined) =>
  renderToStaticMarkup(createElement(TicketDrawer, { profile: "agenthook", ticketRef: "221", ticket, runsNonce: 0, onClose: () => {} }));

describe("TicketDrawer", () => {
  it("shows the full failure reason (or the held question) under the header", () => {
    expect(render({ ...row, status: "failed", failReason: 'service "bad" not ready within 5s' })).toMatch(/data-drawer-reason[\s\S]*Why it failed[\s\S]*service &quot;bad&quot; not ready within 5s/);
    expect(render({ ...row, status: "held", heldReason: "Which DB?" })).toMatch(/data-drawer-reason[\s\S]*What the agent is asking[\s\S]*Which DB\?/);
    expect(render(row)).not.toContain("data-drawer-reason");
  });

  it("leads the reason block with the agent's plain sentence, as prose, above the unchanged full reason", () => {
    const html = render({ ...row, status: "held", heldReason: "Which DB? Postgres or SQLite (see src/db.js:12)", plain: "It needs you to pick a database." });
    expect(html).toMatch(/data-drawer-reason[\s\S]*What the agent is asking<\/p><p data-drawer-plain="true" class="mb-1 text-body text-fg">It needs you to pick a database\.<\/p><p class="[^"]*font-mono[^"]*">Which DB\? Postgres or SQLite \(see src\/db\.js:12\)<\/p>/);
    expect(render({ ...row, status: "held", heldReason: "Which DB?" })).not.toContain("data-drawer-plain");
  });

  it("shows answer-option buttons under the held reason only when options + onRelease are both set (#565)", () => {
    const held = { ...row, status: "held" as const, heldReason: "Which DB?", options: ["Postgres", "SQLite"] };
    const withRelease = renderToStaticMarkup(createElement(TicketDrawer, { profile: "agenthook", ticketRef: "221", ticket: held, runsNonce: 0, onClose: () => {}, onRelease: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }) }));
    expect(withRelease).toContain("data-drawer-answer");
    expect(withRelease).toContain("data-answer-options");
    expect(withRelease).toContain("Postgres");
    expect(render(held)).not.toContain("data-drawer-answer"); // no onRelease: no answer form
    expect(render({ ...row, status: "held", heldReason: "Which DB?" })).not.toContain("data-drawer-answer"); // no options
    expect(render(row)).not.toContain("data-drawer-answer"); // not held
  });

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
