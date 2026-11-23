// @vitest-environment happy-dom
// #708: the docked drawer — a live column beside the page, not a modal overlay. Overlay mode must
// keep today's exact markup; the frame swaps tickets in place (no remount) and Esc closes only
// when no modal sits on top.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TicketDrawer } from "./TicketDrawer";
import type { TicketRow } from "./contract";
import { mount } from "./domHarness";
import type { Mounted } from "./domHarness";

const row = (ref: string): TicketRow => ({
  profile: "dev",
  ref,
  displayId: `#${ref}`,
  title: `Ticket ${ref}`,
  step: "code",
  status: "running",
  model: null,
  startedAt: null,
  costUsd: 0,
  estUsd: 0,
  trackerUrl: null,
  prUrl: null,
  summary: null,
  plain: null,
  options: null,
  heldReason: null,
  heldAt: null,
  failReason: null,
  reasonHarness: null,
  prState: null,
  prNeeds: null,
  finishedAt: null,
  queuePos: null,
  queuedAt: null,
  epic: null,
});

const props = (over: { ticketRef?: string; ticket?: TicketRow; docked?: boolean } = {}) => ({
  profile: "dev",
  ticketRef: over.ticketRef ?? "1",
  ticket: over.ticket ?? row(over.ticketRef ?? "1"),
  runsNonce: 0,
  onClose: () => {},
  ...(over.docked === undefined ? {} : { docked: over.docked }),
});

const el = <T extends HTMLElement>(html: string, tag: string = "div") => {
  const host = document.createElement(tag);
  host.innerHTML = html;
  return host.querySelector<T>(`[data-drawer]`) ?? (host.querySelector<T>(tag) as T);
};

let m: Mounted | null = null;
let extras: HTMLElement[] = [];
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ runs: [] }) })));
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
afterEach(async () => {
  await m?.unmount();
  m = null;
  extras.forEach((e) => e.remove());
  extras = [];
  vi.unstubAllGlobals();
});

const esc = () => act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

describe("docked markup", () => {
  it("has no scrim, is a named region, not a modal, and is not fixed", () => {
    const html = renderToStaticMarkup(createElement(TicketDrawer, props({ docked: true })));
    expect(html).not.toContain("drawer-scrim");
    const aside = el<HTMLElement>(html);
    expect(aside.getAttribute("role")).toBe("region");
    expect(aside.hasAttribute("aria-modal")).toBe(false);
    expect(aside.getAttribute("aria-label")).toBeTruthy();
    expect(aside.hasAttribute("data-docked")).toBe(true);
    expect(aside.className).not.toContain("fixed");
    expect(aside.className).not.toContain("shadow-xl");
  });

  it("overlay keeps today's exact modal markup", () => {
    const html = renderToStaticMarkup(createElement(TicketDrawer, props()));
    expect(html).toContain("drawer-scrim");
    const aside = el<HTMLElement>(html);
    expect(aside.getAttribute("role")).toBe("dialog");
    expect(aside.hasAttribute("aria-modal")).toBe(true);
    expect(aside.hasAttribute("data-docked")).toBe(false);
    expect(aside.className).toContain("fixed");
    expect(aside.className).toContain("md:w-[720px]");
    expect(aside.className).toContain("shadow-xl");
  });
});

describe("swap in place", () => {
  it("a ticket swap keeps the same drawer node and moves focus in again", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    m = await mount(createElement(TicketDrawer, props({ docked: true })));
    await act(async () => {});
    expect(m!.root.contains(document.activeElement!)).toBe(true); // open moved focus in
    const first = m!.root.querySelector("[data-drawer]")!;
    const secondRow = document.createElement("button");
    document.body.appendChild(secondRow);
    secondRow.focus(); // the operator clicked the other row
    await m!.rerender(createElement(TicketDrawer, props({ ticketRef: "2", ticket: row("2"), docked: true })));
    const second = m!.root.querySelector("[data-drawer]")!;
    expect(second).toBe(first); // no remount, no second slide
    expect(second.textContent).toContain("Ticket 2");
    expect(m!.root.contains(document.activeElement!)).toBe(true); // focus is in the drawer again
  });

  it("Esc closes and returns focus to the row that opened the current ticket, also after a swap", async () => {
    const onClose = vi.fn();
    const rowA = document.createElement("button");
    const rowB = document.createElement("button");
    document.body.append(rowA, rowB);
    rowA.focus();
    m = await mount(
      createElement(TicketDrawer, { ...props({ docked: true }), onClose }),
    );
    await act(async () => {});
    rowB.focus();
    await m!.rerender(createElement(TicketDrawer, { ...props({ ticketRef: "2", ticket: row("2"), docked: true }), onClose }));
    await act(async () => {});
    await esc();
    expect(onClose).toHaveBeenCalledTimes(1);
    await m!.unmount();
    m = null;
    expect(document.activeElement).toBe(rowB);
  });
});

describe("Esc and modals", () => {
  it("a modal on top of the docked drawer owns its Esc", async () => {
    const onClose = vi.fn();
    m = await mount(createElement(TicketDrawer, { ...props({ docked: true }), onClose }));
    await act(async () => {});
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    extras.push(modal);
    await esc();
    expect(onClose).not.toHaveBeenCalled(); // the drawer stays, the modal closes it
    modal.remove();
    await esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("in overlay mode the drawer's own aria-modal does not swallow its Esc", async () => {
    const onClose = vi.fn();
    m = await mount(createElement(TicketDrawer, { ...props(), onClose }));
    await act(async () => {});
    await esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
