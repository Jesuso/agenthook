// @vitest-environment happy-dom
// App-level: the open drawer is the route's `?t=` (deep link, Back closes it, reload keeps it, #766).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import App from "./App";
import { click, mount, until } from "./domHarness";
import type { ProfileView, TicketRow, Snapshot } from "./contract";

const profile: ProfileView = {
  name: "dev", label: "dev", up: true, pid: 1, port: null, tracker: "github", ticketSteps: null, ingress: null, fullAuto: false, color: "teal", emoji: "🚀", forge: null, maxConcurrent: 3,
  startedAt: null, updatedAt: null, active: 0, queued: 0, paused: false, restartPending: false, lastEvent: null, configPath: null, createdAt: null,
  lastSeenAt: null, ghost: false, configMissing: false, died: false, recentCosts: [], recentRuns: [], quotaPaused: null, quota: null,
};
const ticket: TicketRow = {
  profile: "dev", ref: "T-1", displayId: "T-1", title: "Fix the drawer", step: "code", status: "running", model: "claude-opus-5-5", startedAt: "2026-09-08T09:00:00.000Z",
  costUsd: 1.5, estUsd: 0, trackerUrl: null, prUrl: null, summary: null, plain: null, options: null, heldReason: null, heldAt: null, failReason: null,
  prState: null, prNeeds: null, finishedAt: null, queuePos: null, queuedAt: null, epic: null,
};
const cfgJson = { name: "dev", repoPath: "/repo", tracker: { type: "github", pipeline: [{ id: "code", kind: "implement", sourceLabel: "agent:code", successLabel: "agent:review" }] } };

class FakeSource {
  static last: FakeSource | null = null;
  listeners = new Map<string, (ev: MessageEvent) => void>();
  readyState = 1;
  constructor(public url: string) {
    FakeSource.last = this;
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, fn);
  }
  close() {}
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

let m: { unmount: () => Promise<void> } | null = null;
let snapshot: Snapshot;
let cfgFile: { path: string; text: string; hash: string; errors: string[]; literalSecrets: unknown[] };

beforeEach(() => {
  FakeSource.last = null;
  snapshot = { profiles: [profile], tickets: [ticket] };
  cfgFile = { path: "/cfg/agenthook.config.json", text: JSON.stringify(cfgJson, null, 2), hash: "h1", errors: [], literalSecrets: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/snapshot")) return { status: 200, ok: true, json: async () => snapshot };
      if (u.startsWith("/api/config")) return { status: 200, ok: true, json: async () => cfgFile };
      return { status: 200, ok: true, json: async () => ({ runs: [] }) };
    }),
  );
  vi.stubGlobal("EventSource", FakeSource);
});
afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.unstubAllGlobals();
});

const waitOverview = () => until(() => document.querySelector("[data-all-tickets]"));
const drawer = () => document.querySelector("[data-drawer]");

const mountApp = async (hash: string) => {
  window.history.replaceState(null, "", hash);
  m = await mount(createElement(App));
  return m;
};

/** What the browser does on a link / back: the URL changes, then hashchange fires. */
const navigate = async (hash: string) => {
  await act(async () => {
    window.history.pushState(null, "", hash);
    window.dispatchEvent(new Event("hashchange"));
  });
};

/** What the browser does on Back: the URL steps back, then hashchange fires. */
const back = async () => {
  await act(async () => {
    window.history.back();
    window.dispatchEvent(new Event("hashchange"));
  });
};

describe("the open drawer lives in the URL", () => {
  it("opening a ticket from an Overview row sets ?t=<encoded ref> and renders the drawer", async () => {
    await mountApp("#/p/dev");
    await waitOverview();
    await click(document.querySelector("[data-tickets-toggle]")!);
    await click(document.querySelector("[data-ticket-open]")!);
    expect(window.location.hash).toBe("#/p/dev?t=T-1");
    await until(() => drawer());
    expect(drawer()!.textContent).toContain("T-1");
    // A ref that needs encoding lands in the URL encoded; back/forward to it keeps today's
    // undefined-ticket drawer behaviour (no mount-time re-check).
    await navigate("#/p/dev?t=a%2Fb%3Fc%26d");
    expect(drawer()!.textContent).toContain("a/b?c&d");
    expect(window.location.hash).toBe("#/p/dev?t=a%2Fb%3Fc%26d");
  });

  it("a hashchange that removes t closes the drawer and keeps the view", async () => {
    await mountApp("#/p/dev");
    await waitOverview();
    await click(document.querySelector("[data-tickets-toggle]")!);
    await click(document.querySelector("[data-ticket-open]")!);
    await until(() => drawer());
    await navigate("#/p/dev");
    expect(drawer()).toBeNull();
    expect(document.querySelector("[data-all-tickets]")).not.toBeNull();
  });

  it("closing with × removes t from the hash", async () => {
    await mountApp("#/p/dev");
    await waitOverview();
    await click(document.querySelector("[data-tickets-toggle]")!);
    await click(document.querySelector("[data-ticket-open]")!);
    await until(() => drawer());
    expect(window.location.hash).toBe("#/p/dev?t=T-1");
    await click(drawer()!.querySelector('[aria-label="Close"]')!);
    expect(window.location.hash).toBe("#/p/dev");
    await until(() => drawer() === null);
  });

  it("mounting with ?t=<ref> for a known ticket renders that ticket's drawer", async () => {
    await mountApp("#/p/dev?t=T-1");
    await until(() => drawer());
    expect(drawer()!.textContent).toContain("T-1");
    expect(drawer()!.textContent).toContain("Fix the drawer");
    expect(window.location.hash).toBe("#/p/dev?t=T-1");
  });

  it("mounting with an unknown ref renders no drawer and clears t through replaceState, no push", async () => {
    const rs = vi.spyOn(window.history, "replaceState");
    const ps = vi.spyOn(window.history, "pushState");
    await mountApp("#/p/dev?t=ghost");
    await waitOverview();
    expect(drawer()).toBeNull();
    expect(window.location.hash).toBe("#/p/dev");
    expect(rs.mock.calls.some((c) => c[2] === "#/p/dev")).toBe(true);
    expect(ps.mock.calls.length).toBe(0);
    rs.mockRestore();
    ps.mockRestore();
  });

  it("changing the view or going Home drops t", async () => {
    await mountApp("#/p/dev?t=T-1");
    await until(() => drawer());
    await click(document.querySelector('[data-tab="stats"]')!);
    expect(window.location.hash).toBe("#/p/dev/stats");
    await until(() => drawer() === null);
    await click(document.querySelector("[data-home]")!);
    expect(window.location.hash).toBe("#/");
  });

  it("opening and closing the drawer keeps an active status filter", async () => {
    await mountApp("#/p/dev");
    await waitOverview();
    await click(document.querySelector("[data-tickets-toggle]")!);
    const idle = [...document.querySelectorAll<HTMLElement>('[data-tickets-toolbar] [role="radio"]')].find((b) => b.textContent!.includes("running"))!;
    await click(idle);
    expect(idle.getAttribute("aria-checked")).toBe("true");
    await click(document.querySelector("[data-ticket-open]")!);
    expect(window.location.hash).toBe("#/p/dev?t=T-1");
    await until(() => drawer());
    const idleAfter = [...document.querySelectorAll<HTMLElement>('[data-tickets-toolbar] [role="radio"]')].find((b) => b.textContent!.includes("running"))!;
    expect(idleAfter.getAttribute("aria-checked")).toBe("true");
    await click(drawer()!.querySelector('[aria-label="Close"]')!);
    expect(window.location.hash).toBe("#/p/dev");
    const idleClosed = [...document.querySelectorAll<HTMLElement>('[data-tickets-toolbar] [role="radio"]')].find((b) => b.textContent!.includes("running"))!;
    expect(idleClosed.getAttribute("aria-checked")).toBe("true");
  });

  it("a ticket-only hash change with a dirty Config buffer does not show the discard modal", async () => {
    await mountApp("#/p/dev/config?t=T-1");
    await until(() => document.querySelector("[data-config-pane]") && drawer(), 300);
    // Edit the name on Basics: the config buffer goes dirty.
    await click([...document.querySelectorAll<HTMLButtonElement>("[data-config-pane]")].find((b) => b.dataset.configPane === "basics")!);
    const input = document.querySelector<HTMLInputElement>('[name="name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "renamed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await until(() => document.body.textContent!.includes("● modified"));
    await navigate("#/p/dev/config"); // drop the ticket
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(drawer()).toBeNull();
    expect(window.location.hash).toBe("#/p/dev/config");
    expect(document.body.textContent).toContain("● modified"); // the buffer survived the close
  });
});

describe("docked at ≥ DOCK_MIN_PX (#708)", () => {
  const wide = () =>
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const esc = () => act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  const rowOpen = (ref: string) => document.querySelector<HTMLElement>(`[data-ticket-row='${ref}'] [data-ticket-open]`);

  it("docks beside the page: no scrim, a region, the rail hidden — and the page never remounts", async () => {
    wide();
    snapshot.tickets = [ticket, { ...ticket, ref: "T-2", displayId: "T-2", title: "Second ticket" }];
    await mountApp("#/p/dev");
    await waitOverview();
    const list = document.querySelector("[data-all-tickets]")!;
    const rail = document.querySelector("[data-overview-rail]")!;
    await click(document.querySelector("[data-tickets-toggle]")!);
    const opener = rowOpen("T-1")!;
    opener.focus();
    await click(opener);
    await until(() => drawer());
    const first = drawer()!;
    expect(first.getAttribute("role")).toBe("region");
    expect(first.hasAttribute("aria-modal")).toBe(false);
    expect(document.querySelector(".drawer-scrim")).toBeNull();
    // The docked column grows with the viewport inside the clamp, beside the page.
    expect(document.querySelector("[data-drawer-dock]")!.className).toContain("clamp(720px,calc(25vw+240px),880px)");
    expect(rail.hasAttribute("hidden")).toBe(true); // the rail gives the drawer its column…
    // …but the page did not remount: the same nodes, the list still expanded.
    expect(document.querySelector("[data-overview-rail]")).toBe(rail);
    expect(document.querySelector("[data-all-tickets]")).toBe(list);
    expect(list.getAttribute("data-open")).toBe("true");
    // Swap to the second ticket: same DOM node, new content, no scrim ever.
    const second = rowOpen("T-2")!;
    second.focus();
    await click(second);
    expect(window.location.hash).toBe("#/p/dev?t=T-2");
    await until(() => drawer()!.textContent!.includes("T-2"));
    expect(drawer()).toBe(first); // the frame did not remount
    expect(document.querySelector(".drawer-scrim")).toBeNull();
    // Back returns to T-1, Back again closes — as the URL did for the overlay.
    await back();
    expect(window.location.hash).toBe("#/p/dev?t=T-1");
    await until(() => drawer()!.textContent!.includes("T-1"));
    expect(drawer()).toBe(first);
    await back();
    expect(window.location.hash).toBe("#/p/dev");
    await until(() => drawer() === null);
    expect(document.querySelector("[data-drawer-dock]")).toBeNull();
    expect(rail.hasAttribute("hidden")).toBe(false); // and the rail is back
    expect(document.querySelector("[data-all-tickets]")).toBe(list);
    expect(list.getAttribute("data-open")).toBe("true");
  });

  it("Esc closes the docked drawer and returns focus to the row that opened the current ticket, also after a swap", async () => {
    wide();
    snapshot.tickets = [ticket, { ...ticket, ref: "T-2", displayId: "T-2", title: "Second ticket" }];
    await mountApp("#/p/dev");
    await waitOverview();
    await click(document.querySelector("[data-tickets-toggle]")!);
    const openerA = rowOpen("T-1")!;
    openerA.focus();
    await click(openerA);
    await until(() => drawer());
    expect(drawer()!.contains(document.activeElement as Node)).toBe(true); // open moved focus in
    const openerB = rowOpen("T-2")!;
    openerB.focus();
    await click(openerB);
    await until(() => drawer()!.textContent!.includes("T-2"));
    expect(drawer()!.contains(document.activeElement as Node)).toBe(true); // the swap moved focus in again
    await esc();
    await until(() => drawer() === null);
    expect(document.activeElement).toBe(openerB); // the row that opened the *current* ticket
  });

  it("below the breakpoint the same deep link keeps today's overlay", async () => {
    snapshot.tickets = [ticket];
    await mountApp("#/p/dev?t=T-1");
    await until(() => drawer());
    expect(drawer()!.getAttribute("role")).toBe("dialog");
    expect(drawer()!.hasAttribute("aria-modal")).toBe(true);
    expect(document.querySelector(".drawer-scrim")).not.toBeNull();
    expect(document.querySelector("[data-drawer-dock]")).toBeNull();
    expect(document.querySelector<HTMLElement>("[data-overview-rail]")!.hasAttribute("hidden")).toBe(false);
  });
});
