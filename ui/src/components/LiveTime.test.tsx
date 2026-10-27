// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { Ago, Elapsed, LiveContext } from "./LiveTime";
import { mount } from "../domHarness";
import type { Mounted } from "../domHarness";

// #579: each label re-renders at its own next boundary, and holds while the stream is down.

const T0 = Date.parse("2026-10-27T10:00:00Z");
let m: Mounted | null = null;

const elapsed = () => document.querySelector<HTMLElement>("[data-elapsed]")!;
const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
const tree = (live: boolean, startIso: string) =>
  createElement(LiveContext.Provider, { value: live }, createElement(Elapsed, { iso: startIso, seed: T0 }), createElement("i", { "data-ago": "" }, createElement(Ago, { iso: startIso, seed: T0 })));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.useRealTimers();
});

describe("Elapsed", () => {
  it("ticks each second for the first minute, then on each minute boundary", async () => {
    m = await mount(tree(true, new Date(T0 - 58_500).toISOString()));
    expect(elapsed().textContent).toBe("58s");
    await advance(500);
    expect(elapsed().textContent).toBe("59s");
    await advance(1000);
    expect(elapsed().textContent).toBe("1m");
    await advance(59_000);
    expect(elapsed().textContent).toBe("1m");
    await advance(1000);
    expect(elapsed().textContent).toBe("2m");
  });

  it("schedules one timer per label, not a per-second clock, past the first minute", async () => {
    m = await mount(tree(true, new Date(T0 - 5 * 60_000).toISOString()));
    const before = vi.getTimerCount();
    expect(before).toBe(2); // the elapsed label and the relative label, each waiting for its own boundary
    await advance(30_000);
    expect(elapsed().textContent).toBe("5m");
  });

  it("freezes and dims while the stream is down, then catches up on reconnect", async () => {
    const start = new Date(T0 - 10_000).toISOString();
    m = await mount(tree(true, start));
    expect(elapsed().textContent).toBe("10s");
    await m.rerender(tree(false, start));
    await advance(5000);
    expect(elapsed().textContent).toBe("10s");
    expect(elapsed().dataset.live).toBe("false");
    expect(elapsed().className).toContain("text-muted");
    expect(elapsed().title).toMatch(/live updates disconnected/);
    await m.rerender(tree(true, start));
    expect(elapsed().textContent).toBe("15s");
    expect(elapsed().getAttribute("aria-live")).toBeNull();
  });
});

describe("Ago", () => {
  it("moves at its own minute boundary", async () => {
    m = await mount(tree(true, new Date(T0 - 119_000).toISOString()));
    const ago = () => document.querySelector("[data-ago]")!.textContent;
    expect(ago()).toBe("1m ago");
    await advance(999);
    expect(ago()).toBe("1m ago");
    await advance(1);
    expect(ago()).toBe("2m ago");
  });
});
