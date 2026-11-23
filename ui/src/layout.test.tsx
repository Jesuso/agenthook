// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, createElement } from "react";
import { mount } from "./domHarness";
import type { Mounted } from "./domHarness";
import { DOCK_MIN_PX, useDocked } from "./layout";

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.unstubAllGlobals();
});

const mark = () => createElement(() => (useDocked() ? "docked" : "overlay"));

describe("useDocked (#708)", () => {
  it("reads the min-width query for the single DOCK_MIN_PX constant", async () => {
    const seen: string[] = [];
    vi.stubGlobal("matchMedia", (q: string) => {
      seen.push(q);
      return { matches: true, addEventListener() {}, removeEventListener() {} };
    });
    m = await mount(mark());
    expect(seen).toContain(`(min-width: ${DOCK_MIN_PX}px)`);
    expect(m!.root.textContent).toBe("docked");
  });

  it("starts from the query's matches and flips on change", async () => {
    let matches = false;
    const changes: Array<() => void> = [];
    // The real MediaQueryList keeps `matches` current; read it live, not at call time.
    const mql = {
      get matches() {
        return matches;
      },
      addEventListener(_t: string, f: () => void) {
        changes.push(f);
      },
      removeEventListener() {},
    };
    vi.stubGlobal("matchMedia", (q: string) => mql);
    m = await mount(mark());
    expect(m!.root.textContent).toBe("overlay");
    matches = true;
    await act(async () => changes.forEach((f) => f()));
    expect(m!.root.textContent).toBe("docked");
  });
});
