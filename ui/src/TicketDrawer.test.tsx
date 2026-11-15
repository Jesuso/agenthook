// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TicketDrawer } from "./TicketDrawer";
import type { RunView, TicketRow } from "./contract";
import type { ReleaseOutcome } from "./config";
import { click, mount } from "./domHarness";

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
  failReason: null, reasonHarness: null,
  prState: null, prNeeds: null,
  finishedAt: null,
  queuePos: null, queuedAt: null, epic: null,
};

const render = (ticket: TicketRow | undefined) =>
  renderToStaticMarkup(createElement(TicketDrawer, { profile: "agenthook", ticketRef: "221", ticket, runsNonce: 0, onClose: () => {} }));

const runView = (over: Partial<RunView> = {}): RunView => ({
  run: "2026-01-01T00-00-00-000Z-step-code-221.log",
  step: "code",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
  outcome: null,
  costUsd: null,
  unpriced: false,
  estUsd: null,
  costBasis: null,
  running: false,
  bytes: 0,
  ...over,
});

// Only the tests that exercise the selected run (model/context header, the run caption) need a
// mounted drawer with a stubbed /api/runs — every other test below renders statically with no
// runs at all (selected stays null), which never fires an effect or a real fetch.
let runs: RunView[] = [];
beforeEach(() => {
  runs = [];
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ runs }) })));
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

async function openDrawer(ticket: TicketRow | undefined) {
  const m = await mount(createElement(TicketDrawer, { profile: "agenthook", ticketRef: "221", ticket, runsNonce: 0, onClose: () => {} }));
  await act(async () => {}); // flush the runs fetch
  return m;
}

describe("TicketDrawer", () => {
  it("the header's model/context follow the selected run, never the ticket's live figures when it isn't selected", async () => {
    runs = [runView({ running: true })];
    const m1 = await openDrawer({ ...row, model: "claude-sonnet-5", ctx: 212000, ctxMax: 200000 });
    expect(m1.root.innerHTML).toMatch(/data-drawer-model="true"[^>]*title="claude-sonnet-5">sonnet 5</);
    expect(m1.root.innerHTML).toMatch(/data-drawer-ctx="true" class="[^"]*text-muted[^"]*" title="context in use on the last turn: 212,000 tokens">212K</);
    await m1.unmount();

    runs = [runView({ running: true })];
    const m2 = await openDrawer({ ...row, ctx: 54000, ctxMax: 200000 });
    expect(m2.root.innerHTML).toMatch(/data-drawer-ctx="true"[^>]*>54K\/200K</);
    await m2.unmount();

    runs = [runView({ running: true })];
    const m3 = await openDrawer(row);
    expect(m3.root.innerHTML).not.toContain("data-drawer-ctx"); // no context reading: nothing shown
    await m3.unmount();

    runs = [runView({ running: false, outcome: "advance" })];
    const m4 = await openDrawer({ ...row, status: "done", ctx: 54000, ctxMax: 200000 });
    expect(m4.root.innerHTML).not.toContain("data-drawer-ctx");
    expect(m4.root.innerHTML).not.toContain("data-drawer-model");
    await m4.unmount();
  });

  it("selecting a past run shows its own model/harness on the caption and the header, never the live run's (#706)", async () => {
    runs = [
      runView({ run: "b.log", startedAt: "2026-01-01T01:00:00.000Z", running: true }),
      runView({ run: "a.log", startedAt: "2026-01-01T00:00:00.000Z", running: false, outcome: "changes", model: "qwen3-coder", harness: "qwen" }),
    ];
    const { root, unmount } = await openDrawer({ ...row, model: "claude-sonnet-5", ctx: 212000, ctxMax: 200000, status: "running" });
    // The newest (live) run is selected by default: live model/context, as today.
    expect(root.innerHTML).toContain("sonnet 5");
    expect(root.innerHTML).toContain("212K");

    await click(root.querySelector('button[aria-label^="code changes"]')!);
    const caption = root.querySelector("[data-run-caption]")!;
    expect(caption.querySelector("[data-run-harness]")!.textContent).toBe("qwen");
    expect(caption.querySelector("[data-run-model]")!.textContent).toBe("qwen3-coder");
    // The header now shows the selected (past) run's own model, hides context, never the live run's.
    expect(root.innerHTML).toMatch(/data-drawer-model="true"[^>]*>qwen3-coder</);
    expect(root.innerHTML).not.toContain("sonnet 5");
    expect(root.innerHTML).not.toContain("data-drawer-ctx");
    await unmount();
  });

  it("shows the full failure reason (or the held question) under the header", () => {
    expect(render({ ...row, status: "failed", failReason: 'service "bad" not ready within 5s' })).toMatch(/data-drawer-reason[\s\S]*Why it failed[\s\S]*service &quot;bad&quot; not ready within 5s/);
    expect(render({ ...row, status: "held", heldReason: "Which DB?" })).toMatch(/data-drawer-reason[\s\S]*What the agent is asking[\s\S]*Which DB\?/);
    expect(render(row)).not.toContain("data-drawer-reason");
  });

  it("prefixes the reason with the harness that produced it, only when one is recorded (#706)", () => {
    const html = render({ ...row, status: "failed", failReason: "tests red", reasonHarness: "local" });
    expect(html).toMatch(/data-drawer-reason[\s\S]*<span data-reason-harness="true">on local: <\/span>tests red/);
    expect(render({ ...row, status: "failed", failReason: "tests red" })).not.toContain("data-reason-harness");
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

  it("ticket total is labelled and reads a dash when only unpriced (non-Claude / local-model) runs exist", () => {
    // run_end of an unpriced run carries no costUsd, so the ticket's summed cost stays 0.
    const html = render({ ...row, costUsd: 0, estUsd: 0 });
    expect(html).toMatch(/title="total cost:[^"]*">total —</);
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
