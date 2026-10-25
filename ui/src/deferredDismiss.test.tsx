// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, createElement } from "react";
import { UNDO_MS, dismissKey, useDeferredDismiss } from "./deferredDismiss";
import { mount } from "./domHarness";
import type { Mounted } from "./domHarness";

type Api = ReturnType<typeof useDeferredDismiss>;
let api: Api;
let m: Mounted | null = null;
const sent: string[] = [];
function Probe() {
  api = useDeferredDismiss((t) => sent.push(t.ref));
  return createElement("span", null, [...api.pending].length);
}
const T = { profile: "dev", ref: "7" };

beforeEach(async () => {
  vi.useFakeTimers();
  sent.length = 0;
  m = await mount(createElement(Probe));
});
afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.useRealTimers();
});

describe("useDeferredDismiss", () => {
  it("holds a dismiss for UNDO_MS, then sends it once", async () => {
    await act(async () => api.dismiss(T));
    await act(async () => api.dismiss(T)); // a second click while pending is ignored
    expect(api.pending.has(dismissKey(T))).toBe(true);
    await act(async () => vi.advanceTimersByTime(UNDO_MS - 1));
    expect(sent).toEqual([]);
    await act(async () => vi.advanceTimersByTime(1));
    expect(sent).toEqual(["7"]);
    expect(api.pending.size).toBe(0);
  });

  it("undo cancels it: nothing is sent", async () => {
    await act(async () => api.dismiss(T));
    await act(async () => api.undo(T));
    await act(async () => vi.advanceTimersByTime(UNDO_MS * 2));
    expect(sent).toEqual([]);
    expect(api.pending.size).toBe(0);
  });

  it("undoLast takes back the most recent pending dismiss first", async () => {
    await act(async () => api.dismiss(T));
    await act(async () => api.dismiss({ profile: "dev", ref: "8" }));
    let got: unknown;
    await act(async () => {
      got = api.undoLast();
    });
    expect(got).toEqual({ profile: "dev", ref: "8" });
    expect(api.pending.has(dismissKey(T))).toBe(true);
    await act(async () => vi.advanceTimersByTime(UNDO_MS));
    expect(sent).toEqual(["7"]);
    await act(async () => {
      got = api.undoLast();
    });
    expect(got).toBeNull();
  });

  it("leaving the page sends what is still pending", async () => {
    await act(async () => api.dismiss(T));
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(sent).toEqual(["7"]);
    await act(async () => vi.advanceTimersByTime(UNDO_MS));
    expect(sent).toEqual(["7"]);
  });
});
