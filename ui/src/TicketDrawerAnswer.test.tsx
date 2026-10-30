// @vitest-environment happy-dom
// TicketDrawer's inline answer flow needs real clicks (AnswerOptions' pick → confirm → send);
// the rest of TicketDrawer's markup is covered by TicketDrawer.test.tsx (static, node env).
import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { TicketDrawer } from "./TicketDrawer";
import type { TicketRow } from "./contract";
import type { ReleaseOutcome } from "./config";
import { click, mount } from "./domHarness";
import type { Mounted } from "./domHarness";

const row: TicketRow = {
  profile: "agenthook", ref: "221", displayId: "#221", title: "t", step: "code", status: "held", model: null, startedAt: null, costUsd: 0, estUsd: 0,
  trackerUrl: null, prUrl: null, summary: null, plain: null, options: ["Postgres", "SQLite"], heldReason: "Which DB?", heldAt: null, failReason: null, prState: null, prNeeds: null, finishedAt: null, queuePos: null, queuedAt: null, epic: null,
};

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.unstubAllGlobals();
});

describe("TicketDrawer answer flow", () => {
  it("Confirm releases with {profile, ref} and the option text verbatim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ runs: [] }), { status: 200 })));
    const calls: Array<{ t: { profile: string; ref: string }; comment: string }> = [];
    m = await mount(
      createElement(TicketDrawer, {
        profile: "agenthook",
        ticketRef: "221",
        ticket: row,
        runsNonce: 0,
        onClose: () => {},
        onRelease: async (t, comment): Promise<ReleaseOutcome> => {
          calls.push({ t, comment });
          return { ok: true, text: "" };
        },
      }),
    );
    await click(m.root.querySelector("[data-drawer-answer] [data-answer-options] button")!);
    await click(m.root.querySelector("[data-answer-confirm-send]")!);
    expect(calls).toEqual([{ t: { profile: "agenthook", ref: "221" }, comment: "Postgres" }]);
  });

  it("an error keeps the confirm step open and shows it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ runs: [] }), { status: 200 })));
    m = await mount(
      createElement(TicketDrawer, {
        profile: "agenthook",
        ticketRef: "221",
        ticket: row,
        runsNonce: 0,
        onClose: () => {},
        onRelease: async (): Promise<ReleaseOutcome> => ({ ok: false, error: "the receiver is not running" }),
      }),
    );
    await click(m.root.querySelector("[data-drawer-answer] [data-answer-options] button")!);
    await click(m.root.querySelector("[data-answer-confirm-send]")!);
    expect(m.root.querySelector("[data-drawer-answer] [role='alert']")?.textContent).toBe("the receiver is not running");
  });

  it("re-enables the option buttons once a successful release leaves held, even if it holds again with new options (#565 rework)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ runs: [] }), { status: 200 })));
    m = await mount(
      createElement(TicketDrawer, {
        profile: "agenthook",
        ticketRef: "221",
        ticket: row,
        runsNonce: 0,
        onClose: () => {},
        onRelease: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }),
      }),
    );
    await click(m.root.querySelector("[data-drawer-answer] [data-answer-options] button")!);
    await click(m.root.querySelector("[data-answer-confirm-send]")!);

    const running: TicketRow = { ...row, status: "running", heldReason: null, options: null };
    await m.rerender(
      createElement(TicketDrawer, {
        profile: "agenthook",
        ticketRef: "221",
        ticket: running,
        runsNonce: 0,
        onClose: () => {},
        onRelease: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }),
      }),
    );

    const heldAgain: TicketRow = { ...row, heldReason: "Which region?", options: ["us-east", "eu-west"] };
    await m.rerender(
      createElement(TicketDrawer, {
        profile: "agenthook",
        ticketRef: "221",
        ticket: heldAgain,
        runsNonce: 0,
        onClose: () => {},
        onRelease: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }),
      }),
    );

    const buttons = m.root.querySelectorAll<HTMLButtonElement>("[data-drawer-answer] [data-answer-options] button");
    expect(buttons.length).toBe(2);
    buttons.forEach((b) => expect(b.disabled).toBe(false));
  });
});
