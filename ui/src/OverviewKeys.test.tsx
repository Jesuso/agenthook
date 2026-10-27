// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { act, createElement } from "react";
import { Overview } from "./Overview";
import type { ReleaseOutcome } from "./config";
import type { ProfileView, TicketRow } from "./contract";
import { mount } from "./domHarness";
import type { Mounted } from "./domHarness";

const p = { name: "dev", label: "dev", up: true, pid: 1, port: null, tracker: "github", ingress: null, fullAuto: null, color: "teal", emoji: "🚀", forge: null, maxConcurrent: 3,
  startedAt: null, updatedAt: null, active: 0, queued: 0, paused: false, restartPending: false, lastEvent: null, configPath: null, createdAt: null,
  lastSeenAt: null, ghost: false, configMissing: false, recentCosts: [], recentRuns: [], quotaPaused: null, quota: null } as ProfileView;
const t = (ref: string, status: TicketRow["status"]): TicketRow => ({
  profile: "dev", ref, displayId: `#${ref}`, title: `Title ${ref}`, step: "code", status, model: null, startedAt: null, costUsd: 0, estUsd: 0, trackerUrl: null,
  prUrl: null, summary: null, plain: null, options: null, heldReason: status === "held" ? "?" : null, heldAt: null, failReason: status === "failed" ? "x" : null, prState: null, prNeeds: null, finishedAt: null, queuePos: null, epic: null,
});

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
});

const press = (k: string, target: EventTarget = document.activeElement ?? document.body) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
const focusedRow = () => {
  const row = (document.activeElement as HTMLElement | null)?.closest("[data-needs-row], [data-now-row]");
  return row?.getAttribute("data-needs-row") ?? row?.getAttribute("data-now-row") ?? undefined;
};

async function render(onDismiss: (r: { ref: string }) => void = () => {}, onRetry: (r: { ref: string }) => Promise<ReleaseOutcome> = async () => ({ ok: true, text: "" })) {
  m = await mount(
    createElement(Overview, {
      profile: p, snapshot: { profiles: [p], tickets: [t("1", "failed"), t("2", "failed"), t("3", "held"), t("4", "running")] }, now: Date.now(), feed: [], statusFilter: "", setStatusFilter: () => {}, epicFilter: "", setEpicFilter: () => {}, showAll: false, setShowAll: () => {},
      open: null, onOpen: () => {}, displayIdFor: () => null, menuItems: [], note: "", onDismiss, onRelease: async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" }), onRetry,
    }),
  );
}

describe("Overview keyboard shortcuts", () => {
  it("j/k walk the Needs-you rows, then on into Now, and stop at the ends", async () => {
    await render();
    await press("j");
    expect(focusedRow()).toBe("1");
    await press("j");
    await press("j");
    expect(focusedRow()).toBe("3");
    await press("j");
    expect(focusedRow()).toBe("4");
    await press("j");
    expect(focusedRow()).toBe("4");
    await press("d"); // a running row has nothing to dismiss
    expect(focusedRow()).toBe("4");
    await press("k");
    expect(focusedRow()).toBe("3");
  });

  it("d dismisses the focused failed row and keeps focus in the list; r opens the held row's answer box", async () => {
    const dismissed: string[] = [];
    await render((r) => dismissed.push(r.ref));
    await press("j");
    await press("d");
    expect(dismissed).toEqual(["1"]);
    expect(focusedRow()).toBe("2");
    await press("j");
    await press("d"); // held: no Dismiss button, nothing happens
    expect(dismissed).toEqual(["1"]);
    await press("r");
    expect(document.querySelector("[data-needs-row='3'] textarea")).not.toBeNull();
  });

  it("r re-runs the focused failed row: busy, then Started; a refusal shows why and re-enables it", async () => {
    const asked: string[] = [];
    let answer: ReleaseOutcome = { ok: false, error: "1 is not assigned to us" };
    await render(undefined, async (r) => (asked.push(r.ref), answer));
    await press("j");
    await press("r");
    expect(asked).toEqual(["1"]);
    expect(document.querySelector("[data-retry-error]")?.textContent).toBe("Couldn't re-run #1: 1 is not assigned to us");
    const button = () => document.querySelector<HTMLButtonElement>("[data-needs-row='1'] [data-needs-retry]")!;
    expect(button().disabled).toBe(false);
    answer = { ok: true, text: "Re-running #1 · code" };
    await act(async () => button().click());
    expect(asked).toEqual(["1", "1"]);
    expect(button().textContent).toBe("Started");
    expect(button().disabled).toBe(true);
    expect(document.querySelector("[data-retry-error]")).toBeNull();
  });

  it("? opens the shortcut sheet, and keys go nowhere while it is open", async () => {
    await render();
    await press("?");
    expect(document.querySelector("[data-shortcuts]")?.textContent).toContain("Dismiss the focused failed ticket");
    await press("j", document.body);
    expect(focusedRow()).toBeUndefined();
  });
});
