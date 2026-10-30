// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { Overview } from "./Overview";
import type { OverviewProps } from "./Overview";
import type { ReleaseOutcome } from "./config";
import type { PrNeeds, ProfileView, TicketRow } from "./contract";
import { click, mount } from "./domHarness";
import type { Mounted } from "./domHarness";

// #598: a PR row in Needs you (code and board disagree) gets a ⋯ menu — Re-check, Close on board
// (only where the code shipped), Dismiss, Open PR, Open ticket — and the zone a Re-check all.

const p = (up = true) =>
  ({ name: "dev", label: "dev", up, pid: up ? 1 : null, port: null, tracker: "github", ingress: null, fullAuto: null, color: "teal", emoji: "🚀", forge: "github", maxConcurrent: 3,
    startedAt: null, updatedAt: null, active: 0, queued: 0, paused: false, restartPending: false, lastEvent: null, configPath: null, createdAt: null,
    lastSeenAt: null, ghost: false, configMissing: false, recentCosts: [], recentRuns: [], quotaPaused: null, quota: null }) as ProfileView;
const pr = (ref: string, prNeeds: PrNeeds): TicketRow => ({
  profile: "dev", ref, displayId: `#${ref}`, title: `Title ${ref}`, step: "code", status: prNeeds === "openOnDone" ? "done" : "idle", model: null, startedAt: null, costUsd: 0, estUsd: 0,
  trackerUrl: `https://github.com/o/r/issues/${ref}`, prUrl: `https://github.com/o/r/pull/${ref}0`, summary: null, plain: null, options: null, heldReason: null, heldAt: null, failReason: null,
  prState: prNeeds === "mergedOpen" ? "merged" : prNeeds === "closedUnmerged" ? "closed" : "ready", prNeeds, finishedAt: null, queuePos: null, epic: null,
});

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
});

const ok = async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" });

async function render(tickets: TicketRow[], over: Partial<OverviewProps> = {}, up = true) {
  const profile = p(up);
  m = await mount(
    createElement(Overview, {
      profile, snapshot: { profiles: [profile], tickets }, now: Date.now(), feed: [], statusFilter: "", setStatusFilter: () => {}, epicFilter: "", setEpicFilter: () => {}, showAll: false, setShowAll: () => {},
      open: null, onOpen: () => {}, displayIdFor: () => null, menuItems: [], note: "", onDismiss: () => {}, onRelease: ok, onRetry: ok, ...over,
    }),
  );
}

const row = (ref: string) => document.querySelector(`[data-needs-row="${ref}"]`) as HTMLElement;
/** Open a row's ⋯ menu and return its items' labels → buttons. */
async function openMenu(ref: string) {
  await click(row(ref).querySelector("[data-needs-pr-menu] button[aria-haspopup]")!);
  return new Map([...row(ref).querySelectorAll<HTMLButtonElement>("[role=menuitem]")].map((b) => [b.textContent ?? "", b]));
}

describe("Needs you: PR row actions", () => {
  it("the ⋯ menu leads with Re-check; Close on board only on mergedOpen / openOnDone", async () => {
    await render([pr("1", "mergedOpen"), pr("2", "openOnDone"), pr("3", "awaitingMerge"), pr("4", "closedUnmerged")]);
    expect(row("1").querySelector("[data-needs-pr-menu] button")?.getAttribute("aria-label")).toBe("More actions for #1");
    expect([...(await openMenu("1")).keys()]).toEqual(["Re-check", "Close on board", "Dismiss", "Open PR", "Open ticket"]);
    expect([...(await openMenu("2")).keys()]).toEqual(["Re-check", "Close on board", "Dismiss", "Open PR", "Open ticket"]);
    expect([...(await openMenu("3")).keys()]).toEqual(["Re-check", "Dismiss", "Open PR", "Open ticket"]);
    expect([...(await openMenu("4")).keys()]).toEqual(["Re-check", "Dismiss", "Open PR", "Open ticket"]);
  });

  it("Re-check, Close on board and Dismiss call their handlers with the row's ref", async () => {
    const calls: string[] = [];
    await render([pr("1", "mergedOpen")], {
      onRecheck: async (profile, ref) => (calls.push(`recheck ${profile} ${ref}`), { ok: true, text: "" }),
      onCloseOnBoard: async (r) => (calls.push(`close ${r.ref}`), { ok: true, text: "" }),
      onDismiss: (r) => void calls.push(`dismiss ${r.ref}`),
    });
    await click((await openMenu("1")).get("Re-check")!);
    await click((await openMenu("1")).get("Close on board")!);
    await click((await openMenu("1")).get("Dismiss")!);
    expect(calls).toEqual(["recheck dev 1", "close 1", "dismiss 1"]);
  });

  it("a refusal shows under the row; the next try clears it", async () => {
    let answer: ReleaseOutcome = { ok: false, error: "1 is not assigned to us — nothing recorded" };
    await render([pr("1", "mergedOpen")], { onRecheck: async () => answer });
    await click((await openMenu("1")).get("Re-check")!);
    expect(row("1").querySelector("[data-pr-action-error]")?.textContent).toBe("Couldn't update #1: 1 is not assigned to us — nothing recorded");
    answer = { ok: true, text: "" };
    await click((await openMenu("1")).get("Re-check")!);
    expect(row("1").querySelector("[data-pr-action-error]")).toBeNull();
  });

  it("Re-check all re-checks the profile's flagged rows (ref null); shown only with a PR row and the receiver up", async () => {
    const calls: Array<[string, string | null]> = [];
    await render([pr("1", "awaitingMerge")], { onRecheck: async (profile, ref) => (calls.push([profile, ref]), { ok: true, text: "" }) });
    await click(document.querySelector("[data-recheck-all]")!);
    expect(calls).toEqual([["dev", null]]);
    await m?.unmount();
    await render([pr("1", "awaitingMerge")], { onRecheck: ok }, false);
    expect(document.querySelector("[data-recheck-all]")).toBeNull();
    expect((await openMenu("1")).get("Re-check")?.disabled).toBe(true);
    await m?.unmount();
    const failed = { ...pr("9", "awaitingMerge"), status: "failed" as const, prNeeds: null, failReason: "x" };
    await render([failed], { onRecheck: ok });
    expect(document.querySelector("[data-recheck-all]")).toBeNull();
    expect(document.querySelector("[data-needs-pr-menu]")).toBeNull();
  });
});
