// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { BoardView } from "./BoardView";
import type { BoardViewProps } from "./BoardView";
import type { ReleaseOutcome } from "./config";
import type { ProfileView, TicketRow } from "./contract";
import { click, mount, pressEnter, until } from "./domHarness";
import type { Mounted } from "./domHarness";

// #697 ticket 1 of 3: the profile Board. Fixtures below cover a `local` tracker profile (down,
// so stage labels fall back to ids) and a forge profile (a `prNeeds` row in Needs you).

const LOCAL_CONFIG = {
  agent: "claude",
  tracker: {
    type: "local",
    pipeline: [
      { id: "triage", kind: "triage", sourceStatus: "Triage", successStatus: "Code" },
      { id: "code", kind: "implement", sourceStatus: "Code", successStatus: "Review", harness: ["main"] },
      { id: "review", kind: "review", sourceStatus: "Review", successStatus: "Done", failureStatus: "Failed", holdStatus: "Held" },
    ],
  },
};

const profile = (over: Partial<ProfileView> = {}): ProfileView =>
  ({
    name: "dev", label: "dev", up: false, pid: null, port: null, tracker: "local", ingress: null, fullAuto: null, color: "teal", emoji: "🚀", forge: null,
    maxConcurrent: 3, startedAt: null, updatedAt: null, active: 0, queued: 0, paused: false, restartPending: false, lastEvent: null, configPath: null,
    createdAt: null, lastSeenAt: null, ghost: false, configMissing: false, recentCosts: [], recentRuns: [], quotaPaused: null, quota: null,
    ...over,
  }) as ProfileView;

const ticket = (over: Partial<TicketRow> & { ref: string; status: TicketRow["status"] }): TicketRow =>
  ({
    profile: "dev", displayId: over.ref, title: `Title ${over.ref}`, step: null, model: null, startedAt: null, costUsd: 0, estUsd: 0,
    trackerUrl: null, prUrl: null, summary: null, plain: null, options: null, heldReason: null, heldAt: null, failReason: null,
    prState: null, prNeeds: null, finishedAt: null, queuePos: null, queuedAt: null, epic: null,
    ...over,
  }) as TicketRow;

function stubMatchMedia(wide: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (media: string) => ({ matches: wide, media, addEventListener: () => {}, removeEventListener: () => {}, onchange: null, dispatchEvent: () => false }) as unknown as MediaQueryList,
  );
}

function stubConfigFetch(config: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/config")) return new Response(JSON.stringify({ path: "/x/agenthook.config.json", text: JSON.stringify(config), hash: "h", errors: [], literalSecrets: [] }), { status: 200 });
      return new Response(JSON.stringify({ error: "down" }), { status: 503 });
    }),
  );
}

let m: Mounted | null = null;
beforeEach(() => stubMatchMedia(true));
afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ok = async (): Promise<ReleaseOutcome> => ({ ok: true, text: "" });

async function render(tickets: TicketRow[], over: Partial<BoardViewProps> = {}, config: unknown = LOCAL_CONFIG, prof?: ProfileView) {
  stubConfigFetch(config);
  const p = prof ?? profile();
  m = await mount(
    createElement(BoardView, {
      profile: p, tickets, now: Date.now(), onOpen: () => {}, onStepFilter: () => {}, onDismiss: () => {}, onRelease: ok, onRetry: ok,
      ...over,
    }),
  );
  await until(() => m!.root.querySelector("[data-board-section]"));
  return m!.root;
}

describe("BoardView", () => {
  it("one section per pipeline step, ids matching the config's steps", async () => {
    const root = await render([]);
    const ids = [...root.querySelectorAll("[data-board-section]")].map((e) => e.getAttribute("data-board-section"));
    expect(ids).toEqual(["triage", "code", "review", "done"]);
  });

  it("a running ticket shows in its step's section with a live clock; a queued one follows, muted", async () => {
    const running = ticket({ ref: "r1", status: "running", step: "code", startedAt: new Date().toISOString() });
    const queued = ticket({ ref: "q1", status: "queued", step: "code", queuePos: 0, queuedAt: new Date().toISOString() });
    const root = await render([queued, running]);
    const section = root.querySelector('[data-board-section="code"]')!;
    const entries = [...section.querySelectorAll("[data-board-entry]")].map((e) => e.getAttribute("data-board-entry"));
    expect(entries).toEqual(["r1", "q1"]);
  });

  it("held and failed tickets never appear in a step section", async () => {
    const held = ticket({ ref: "h1", status: "held", step: "code" });
    const failed = ticket({ ref: "f1", status: "failed", step: "code" });
    const root = await render([held, failed]);
    const section = root.querySelector('[data-board-section="code"]')!;
    expect(section.querySelectorAll("[data-board-entry]")).toHaveLength(0);
  });

  it("Needs you is absent with nothing pending, present with one held ticket", async () => {
    const empty = await render([]);
    expect(empty.querySelector("[data-needs-you-zone]")).toBeNull();
    expect(empty.querySelector("[data-all-clear]")).toBeNull();

    const held = ticket({ ref: "h1", status: "held", step: "code" });
    const withHeld = await render([held]);
    expect(withHeld.querySelectorAll("[data-needs-row]")).toHaveLength(1);
  });

  it("a down harness alone renders Needs you", async () => {
    const root = await render([], {}, LOCAL_CONFIG, profile({ harnesses: { main: { active: 0, max: 1, state: "down", reason: "boom" } } }));
    expect(root.querySelectorAll("[data-needs-row]")).toHaveLength(1);
  });

  it("caps a step's section at 6 entries, with a +N more that calls onStepFilter", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ticket({ ref: `r${i}`, status: "running", step: "code", startedAt: new Date(Date.now() - i * 1000).toISOString() }));
    const onStepFilter = vi.fn();
    const root = await render(rows, { onStepFilter });
    const section = root.querySelector('[data-board-section="code"]')!;
    expect(section.querySelectorAll("[data-board-entry]")).toHaveLength(6);
    const more = section.querySelector("button")!;
    expect(more.textContent).toContain("+2");
    await click(more);
    expect(onStepFilter).toHaveBeenCalledWith("code");
  });

  it("clicking an entry (or Enter) opens the drawer; clicking the id link does not", async () => {
    const onOpen = vi.fn();
    const running = ticket({ ref: "r1", status: "running", step: "code", trackerUrl: "/ticket/1" });
    const root = await render([running], { onOpen });
    const entry = root.querySelector('[data-board-entry="r1"]')!;
    await click(entry.querySelector("a")!);
    expect(onOpen).not.toHaveBeenCalled();
    await click(entry);
    expect(onOpen).toHaveBeenCalledWith({ profile: "dev", ref: "r1" });
    onOpen.mockClear();
    (entry as HTMLElement).focus();
    await pressEnter(entry);
    expect(onOpen).toHaveBeenCalledWith({ profile: "dev", ref: "r1" });
  });

  it("Done today lists only rows finished since local midnight, with the count", async () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const today = ticket({ ref: "t1", status: "done", step: "review", finishedAt: new Date(midnight.getTime() + 1000).toISOString() });
    const yesterday = ticket({ ref: "t2", status: "done", step: "review", finishedAt: new Date(midnight.getTime() - 1000).toISOString() });
    const root = await render([today, yesterday]);
    const done = root.querySelector('[data-board-section="done"]')!;
    expect([...done.querySelectorAll("[data-board-entry]")].map((e) => e.getAttribute("data-board-entry"))).toEqual(["t1"]);
    expect(done.textContent).toContain("1");
  });

  it("a forge profile's flagged PR row lands in Needs you", async () => {
    const pr = ticket({ ref: "p1", status: "idle", step: "review", prUrl: "https://github.com/o/r/pull/9", prNeeds: "awaitingMerge" });
    const root = await render([pr], {}, LOCAL_CONFIG, profile({ forge: "github" }));
    expect(root.querySelectorAll("[data-needs-row]")).toHaveLength(1);
  });

  it("below lg: sections stack and no connector SVG is rendered", async () => {
    stubMatchMedia(false);
    const root = await render([]);
    expect(root.querySelector("svg")).toBeNull();
    expect(root.querySelector("[data-board-narrow]")).not.toBeNull();
    expect(root.querySelector("[data-board-wide]")).toBeNull();
  });

  it("string harness on a step config shows the harness label in the section header", async () => {
    const stringConfig = {
      agent: "claude",
      tracker: {
        type: "local",
        pipeline: [
          { id: "code", kind: "implement", sourceStatus: "Code", successStatus: "Done", harness: "main" },
        ],
      },
    };
    const root = await render([], {}, stringConfig);
    const section = root.querySelector('[data-board-section="code"]')!;
    expect(section.textContent).toContain("main");
  });
});
