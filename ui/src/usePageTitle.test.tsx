// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePageTitle } from "./usePageTitle";
import { mount, until } from "./domHarness";
import type { Mounted } from "./domHarness";
import EpicsView from "./EpicsView";
import { epicDetail } from "./epicsFixtures";
import type { ProfileView } from "./contract";
import { I18nProvider } from "./i18n/react";

const profile = { name: "dev", label: "dev", up: true, color: "teal", emoji: "🚀", forge: null } as unknown as ProfileView;

describe("usePageTitle (#757)", () => {
  let m: Mounted | null = null;
  afterEach(async () => {
    await m?.unmount();
    m = null;
  });

  const Title = ({ a, b }: { a?: string; b?: string }) => {
    usePageTitle([a, b]);
    return null;
  };

  it("joins the non-empty parts with agenthook and resets to agenthook on unmount", async () => {
    m = await mount(createElement(Title, { a: "Stats", b: "dev" }));
    expect(document.title).toBe("Stats · dev · agenthook");
    // A null part leaves no empty segment and no stray separator.
    await m.rerender(createElement(Title, { a: "Config" }));
    expect(document.title).toBe("Config · agenthook");
    await m.unmount();
    m = null;
    expect(document.title).toBe("agenthook");
  });
});

// The Epics view's tab-title test lives here rather than in EpicsView.test.tsx (already over the
// 25 KB test-size rule): the hook replaced Epics' hand-rolled effect, and its output must not
// change.
describe("EpicsView tab title (#757)", () => {
  let m: Mounted | null = null;
  afterEach(async () => {
    await m?.unmount();
    m = null;
    vi.unstubAllGlobals();
  });

  const mountEpics = (over: { epic?: string }) =>
    mount(createElement(I18nProvider, null, createElement(EpicsView, { profile, rows: [], ticketsNonce: 0, onOpen: () => {}, ...over })));

  const fetchStub = vi.fn(async (url: string) => {
    if (String(url).includes("/api/epics/E1")) {
      return new Response(JSON.stringify({ at: "t", live: true, supported: true, epic: epicDetail({ ref: "E1", name: "Checkout revamp" }, []) }), { status: 200 });
    }
    return new Response(JSON.stringify({ at: "t", live: true, supported: true, epics: [] }), { status: 200 });
  });

  it("with an open epic: <epic> · Epics · <profile> · agenthook", async () => {
    vi.stubGlobal("fetch", fetchStub);
    m = await mountEpics({ epic: "E1" });
    await until(() => document.title === "Checkout revamp · Epics · dev · agenthook");
    await m.unmount();
    m = null;
    expect(document.title).toBe("agenthook");
  });

  it("on the list (no epic): Epics · <profile> · agenthook", async () => {
    vi.stubGlobal("fetch", fetchStub);
    m = await mountEpics({});
    await until(() => document.title === "Epics · dev · agenthook");
    await m.unmount();
    m = null;
    expect(document.title).toBe("agenthook");
  });
});
