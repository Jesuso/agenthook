// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { Ago, Elapsed, LIVE_GRACE_MS, LiveContext, useLive } from "./LiveTime";
import type { ConnectionState } from "../connection";
import { mount } from "../domHarness";
import type { Mounted } from "../domHarness";

// #579: each label re-renders at its own next boundary, and holds while the stream is down.

const T0 = Date.parse("2026-10-27T10:00:00Z");
let m: Mounted | null = null;

const elapsed = () => document.querySelector<HTMLElement>("[data-elapsed]")!;
const shown = () => elapsed().querySelector("[aria-hidden]")!.textContent;
const spoken = () => elapsed().querySelector(".sr-only")!.textContent;
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
    expect(shown()).toBe("58s");
    await advance(500);
    expect(shown()).toBe("59s");
    await advance(1000);
    expect(shown()).toBe("1m");
    await advance(59_000);
    expect(shown()).toBe("1m");
    await advance(1000);
    expect(shown()).toBe("2m");
  });

  it("schedules one timer per label, not a per-second clock, past the first minute", async () => {
    m = await mount(tree(true, new Date(T0 - 5 * 60_000).toISOString()));
    const before = vi.getTimerCount();
    expect(before).toBe(2); // the elapsed label and the relative label, each waiting for its own boundary
    await advance(30_000);
    expect(shown()).toBe("5m");
  });

  it("freezes and dims while the stream is down, then catches up on reconnect", async () => {
    const start = new Date(T0 - 10_000).toISOString();
    m = await mount(tree(true, start));
    expect(shown()).toBe("10s");
    await m.rerender(tree(false, start));
    await advance(5000);
    // Held, and marked in text — not by colour alone.
    expect(shown()).toBe("~10s");
    expect(elapsed().dataset.live).toBe("false");
    expect(elapsed().className).toContain("text-muted");
    expect(elapsed().title).toMatch(/live updates disconnected/);
    expect(spoken()).toMatch(/^running for 10 seconds, As of .* live updates disconnected$/);
    expect(document.querySelector("[data-ago]")!.textContent).toBe("~just now");
    await m.rerender(tree(true, start));
    expect(shown()).toBe("15s");
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

describe("Elapsed for screen readers", () => {
  it("speaks whole words (\"4m\" reads as metres) and carries a machine duration", async () => {
    m = await mount(tree(true, new Date(T0 - 64 * 60_000).toISOString()));
    expect(shown()).toBe("1h 04m");
    expect(spoken()).toBe("running for 1 hour 4 minutes");
    expect(elapsed().tagName).toBe("TIME");
    expect(elapsed().getAttribute("datetime")).toBe("PT3840S");
  });
});

describe("useLive", () => {
  let value: boolean | null = null;
  const Probe = ({ c }: { c: ConnectionState }) => {
    value = useLive(c);
    return null;
  };
  it("counts reconnecting as live for the grace period, closed as down at once", async () => {
    m = await mount(createElement(Probe, { c: "reconnecting" }));
    expect(value).toBe(true); // before the first open, on load
    await advance(LIVE_GRACE_MS - 1);
    expect(value).toBe(true);
    await advance(1);
    expect(value).toBe(false);
    await m.rerender(createElement(Probe, { c: "connected" }));
    expect(value).toBe(true);
    await m.rerender(createElement(Probe, { c: "reconnecting" }));
    expect(value).toBe(true); // a fresh blip gets a fresh grace
    await m.rerender(createElement(Probe, { c: "closed" }));
    expect(value).toBe(false);
  });
});
