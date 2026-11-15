// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { BoardFrame, BoardHead, BoardRows, pipelineStepIds } from "./Departures";
import { board } from "./board";
import type { TicketRow } from "./contract";
import { click, mount } from "./domHarness";
import type { Mounted } from "./domHarness";

// The Overview's board (#696): one row per ticket, the pipeline's steps as columns.

const ticket = (over: Partial<TicketRow> & { ref: string; status: TicketRow["status"] }): TicketRow =>
  ({
    profile: "dev", displayId: over.ref, title: `Title ${over.ref}`, step: null, model: null, startedAt: null, costUsd: 0, estUsd: 0,
    trackerUrl: null, prUrl: null, summary: null, plain: null, options: null, heldReason: null, heldAt: null, failReason: null,
    prState: null, prNeeds: null, finishedAt: null, queuePos: null, queuedAt: null, epic: null,
    ...over,
  }) as TicketRow;

const STEPS = ["triage", "code", "review"];
const NOW = Date.now();

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.restoreAllMocks();
});

type Handlers = { onOpen?: (t: { profile: string; ref: string }) => void; onStep?: (step: string) => void; onMore?: (status: string) => void };

async function render(tickets: TicketRow[], { steps = STEPS, manual = [] as string[], free = 0, up = true, ...on }: Handlers & { steps?: string[]; manual?: string[]; free?: number; up?: boolean } = {}) {
  const b = board(tickets, steps, manual, NOW);
  m = await mount(
    createElement(
      BoardFrame,
      { columns: b.columns },
      createElement(BoardHead, { board: b, free, up, onStep: on.onStep ?? (() => {}) }),
      createElement(BoardRows, { board: b, now: NOW, onOpen: on.onOpen ?? (() => {}), onMore: on.onMore ?? (() => {}) }),
    ),
  );
  return m.root;
}

const track = (root: HTMLElement, ref: string) => [...root.querySelector(`[data-now-row="${ref}"]`)!.querySelectorAll("[data-track]")].map((e) => e.getAttribute("data-track"));

describe("pipelineStepIds", () => {
  it("keeps the named steps in order and says which are manual", () => {
    expect(pipelineStepIds([{ id: "triage" }, { id: "" }, { id: "ship", manual: true }, {}])).toEqual({ ids: ["triage", "ship"], manual: ["ship"] });
  });
});

describe("the board", () => {
  it("heads a column per step, with how many tickets sit in each", async () => {
    const root = await render([ticket({ ref: "a", status: "running", step: "code" }), ticket({ ref: "b", status: "queued", step: "code", queuePos: 1 })]);
    const heads = [...root.querySelectorAll("[data-board-step]")];
    expect(heads.map((h) => h.getAttribute("data-board-step"))).toEqual(STEPS);
    expect(heads.map((h) => h.querySelector("[data-board-count]")?.textContent ?? "")).toEqual(["", "2", ""]);
    expect(root.querySelector("[data-now-summary]")!.textContent).toBe("1 running · 1 queued");
  });

  it("draws each row up to its step: a line behind it, a mark on it, nothing ahead", async () => {
    const root = await render([ticket({ ref: "a", status: "running", step: "code" }), ticket({ ref: "b", status: "queued", step: "triage", queuePos: 1 })]);
    expect(track(root, "a")).toEqual(["past", "at", "ahead"]);
    expect(track(root, "b")).toEqual(["at", "ahead", "ahead"]);
  });

  it("names the step in words too: read out when a column says it, shown when none does", async () => {
    const root = await render([ticket({ ref: "a", status: "running", step: "code" }), ticket({ ref: "b", status: "running", step: "elsewhere" })]);
    const name = (ref: string) => root.querySelector(`[data-now-row="${ref}"] [data-row-step]`)!;
    expect(name("a").className).toContain("@4xl:sr-only");
    expect(name("b").className).not.toContain("sr-only");
    expect(track(root, "b")).toEqual(["ahead", "ahead", "ahead"]);
  });

  it("without steps there are no columns, and every row names its step", async () => {
    const root = await render([ticket({ ref: "a", status: "running", step: "code" })], { steps: [] });
    expect(root.querySelector("[data-board]")!.getAttribute("data-board-steps")).toBe("0");
    expect(root.querySelectorAll("[data-board-step], [data-track]")).toHaveLength(0);
    expect(root.querySelector("[data-row-step]")!.textContent).toBe("code");
  });

  it("says the row's state in a word, not by the dot alone", async () => {
    const root = await render([ticket({ ref: "a", status: "running", step: "code" }), ticket({ ref: "b", status: "queued", step: "code", queuePos: 1 })]);
    expect(root.querySelector('[data-now-row="a"]')!.textContent).toContain("running");
    expect(root.querySelector('[data-now-row="b"]')!.textContent).toContain("queued");
  });

  it("idle says so, with the free slots beside it", async () => {
    const root = await render([], { free: 3 });
    expect(root.querySelector("[data-now-summary]")!.textContent).toBe("Nothing in flight.");
    expect(root.querySelector("[data-free-slots]")!.getAttribute("data-free-slots")).toBe("3");
    expect(root.querySelector("[data-now-rows], [data-finished-today]")).toBeNull();
  });

  it("a title opens the drawer; a step's name and the +N more rows open All tickets", async () => {
    const onOpen = vi.fn();
    const onStep = vi.fn();
    const onMore = vi.fn();
    const queued = Array.from({ length: 10 }, (_, i) => ticket({ ref: `q${i}`, status: "queued", step: "code", queuePos: i + 1 }));
    const root = await render([ticket({ ref: "r1", status: "running", step: "code" }), ...queued], { onOpen, onStep, onMore });
    await click(root.querySelector('[data-now-row="r1"] [data-now-open]')!);
    expect(onOpen).toHaveBeenCalledWith({ profile: "dev", ref: "r1" });
    await click(root.querySelector('[data-board-step="code"] button')!);
    expect(onStep).toHaveBeenCalledWith("code");
    const more = root.querySelector('[data-board-more="queued"]')!;
    expect(more.textContent).toBe("+2 more queued");
    await click(more);
    expect(onMore).toHaveBeenCalledWith("queued");
  });

  it("lists what finished today under the rows, quiet, with its count", async () => {
    const root = await render([ticket({ ref: "d1", status: "done", finishedAt: new Date(NOW - 60_000).toISOString() }), ticket({ ref: "r", status: "running", step: "code" })]);
    const finished = root.querySelector("[data-finished-today]")!;
    expect(finished.querySelector("h3")!.textContent).toBe("Finished today 1");
    expect([...finished.querySelectorAll("[data-finished-row]")].map((e) => e.getAttribute("data-finished-row"))).toEqual(["d1"]);
    expect(root.querySelector('[data-now-row="d1"]')).toBeNull();
  });
});
