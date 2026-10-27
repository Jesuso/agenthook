// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReleasePanel } from "./ReleasePanel";
import type { TicketRow } from "./contract";
import type { ReleaseOutcome } from "./config";
import { click, mount } from "./domHarness";
import type { Mounted } from "./domHarness";

const ticket = (over: Partial<TicketRow> = {}): TicketRow => ({
  profile: "dev", ref: "7", displayId: "#7", title: "t", step: "code", status: "held", model: null, startedAt: null, costUsd: 0, estUsd: 0, trackerUrl: null,
  prUrl: null, summary: null, plain: null, options: null, heldReason: "?", heldAt: null, failReason: null, prState: null, prNeeds: null, finishedAt: null, queuePos: null, epic: null, ...over,
});

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
});

describe("ReleasePanel", () => {
  it("with no options, renders exactly as on master: textarea + Release/Cancel, no option buttons", () => {
    const html = renderToStaticMarkup(createElement(ReleasePanel, { ticket: ticket(), onRelease: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }), onClose: () => {} }));
    expect(html).not.toContain("data-answer-options");
    expect(html).not.toContain("data-answer-confirm");
    expect(html).toMatch(/<textarea/);
    expect(html).toMatch(/>Release</);
  });

  it("with options, renders the pick buttons above the textarea", () => {
    const html = renderToStaticMarkup(createElement(ReleasePanel, { ticket: ticket({ options: ["Postgres", "SQLite"] }), onRelease: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }), onClose: () => {} }));
    expect(html).toContain("data-answer-options");
    expect(html.indexOf("data-answer-options")).toBeLessThan(html.indexOf("<textarea"));
  });

  it("Confirm releases with the option as the comment, verbatim, then closes", async () => {
    const calls: Array<{ t: { profile: string; ref: string }; comment: string }> = [];
    let closed = false;
    m = await mount(
      createElement(ReleasePanel, {
        ticket: ticket({ options: ["Postgres", "SQLite"] }),
        onRelease: async (t, comment): Promise<ReleaseOutcome> => {
          calls.push({ t, comment });
          return { ok: true, text: "" };
        },
        onClose: () => (closed = true),
      }),
    );
    await click(m.root.querySelector("[data-answer-options] button")!);
    await click(m.root.querySelector("[data-answer-confirm-send]")!);
    expect(calls).toEqual([{ t: { profile: "dev", ref: "7" }, comment: "Postgres" }]);
    expect(closed).toBe(true);
  });

  it("Cancel on the confirm never calls onRelease", async () => {
    const calls: unknown[] = [];
    m = await mount(
      createElement(ReleasePanel, {
        ticket: ticket({ options: ["Postgres", "SQLite"] }),
        onRelease: async (): Promise<ReleaseOutcome> => {
          calls.push(1);
          return { ok: true, text: "" };
        },
        onClose: () => {},
      }),
    );
    await click(m.root.querySelector("[data-answer-options] button")!);
    const cancel = [...m.root.querySelectorAll("[data-answer-confirm] button")].find((b) => b.textContent === "Cancel")!;
    await click(cancel);
    expect(calls).toEqual([]);
    expect(m.root.querySelector("[data-answer-options]")).not.toBeNull();
  });

  it("an error from onRelease keeps the panel open and shows it, without affecting the free-text fallback", async () => {
    m = await mount(
      createElement(ReleasePanel, {
        ticket: ticket({ options: ["Postgres", "SQLite"] }),
        onRelease: async (): Promise<ReleaseOutcome> => ({ ok: false, error: "the receiver is not running" }),
        onClose: () => {},
      }),
    );
    await click(m.root.querySelector("[data-answer-options] button")!);
    await click(m.root.querySelector("[data-answer-confirm-send]")!);
    expect(m.root.querySelector('[role="alert"]')?.textContent).toBe("the receiver is not running");
    expect(m.root.querySelector("textarea")).not.toBeNull();
  });
});
