// @vitest-environment happy-dom
// The drawer's localized summary: the regex extract first, swapped for the receiver's summary in
// the UI language once `POST /api/summary` answers; refetched on a language switch; any failure
// keeps the extract with no error shown.
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { TicketDrawer } from "./TicketDrawer";
import type { TicketRow } from "./contract";
import { I18nProvider } from "./i18n/react";
import { setLangSetting } from "./i18n/index";
import { mount, until } from "./domHarness";
import type { Mounted } from "./domHarness";

const row: TicketRow = {
  profile: "agenthook", ref: "221", displayId: "#221", title: "t", step: "code", status: "running", model: null, startedAt: null, costUsd: 0, estUsd: 0,
  trackerUrl: null, prUrl: null, summary: "Fix the login form.", plain: null, options: null, heldReason: null, heldAt: null, failReason: null, prState: null, prNeeds: null, finishedAt: null, queuePos: null, queuedAt: null, epic: null,
};

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.unstubAllGlobals();
  setLangSetting("auto", ["en-US"]);
});

type Call = { url: string; body: any };
/** fetch stub: runs → []; /api/summary → `answer(body)` (a status + JSON body, or a throw). */
function stubFetch(answer: (body: any) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url !== "/api/summary") return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      const a = await answer(body);
      return new Response(JSON.stringify(a.body), { status: a.status });
    }),
  );
  return calls;
}

const summaryText = () => m!.root.querySelector("[data-drawer-summary]")?.textContent;
const drawer = (ticket: TicketRow = row) => createElement(I18nProvider, null, createElement(TicketDrawer, { profile: "agenthook", ticketRef: "221", ticket, runsNonce: 0, onClose: () => {} }));

describe("TicketDrawer localized summary", () => {
  it("shows the extract first, then the summary in the UI language; a language switch refetches", async () => {
    setLangSetting("es", ["en-US"]);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls = stubFetch(async (b) => {
      if (b.lang === "es") await gate;
      return { status: 200, body: { ref: "221", lang: b.lang, text: b.lang === "es" ? "Arregla el formulario de acceso." : "Fixes the login form.", generatedAt: "t" } };
    });
    m = await mount(drawer());
    expect(summaryText()).toBe("Fix the login form.");
    expect(calls.find((c) => c.url === "/api/summary")?.body).toEqual({ profile: "agenthook", ref: "221", lang: "es" });
    await act(async () => release());
    await until(() => summaryText() === "Arregla el formulario de acceso.");

    await act(async () => setLangSetting("en", ["en-US"]));
    await until(() => summaryText() === "Fixes the login form.");
    expect(calls.filter((c) => c.url === "/api/summary").map((c) => c.body.lang)).toEqual(["es", "en"]);
  });

  it("a refusal or a network error keeps the extract and shows no error", async () => {
    stubFetch(() => ({ status: 502, body: { error: "221 is not assigned to us" } }));
    m = await mount(drawer());
    await act(async () => {});
    expect(summaryText()).toBe("Fix the login form.");
    expect(m.root.querySelector("[data-drawer-summary] [role='alert']")).toBeNull();
    await m.unmount();

    stubFetch(() => Promise.reject(new Error("offline")));
    m = await mount(drawer());
    await act(async () => {});
    expect(summaryText()).toBe("Fix the login form.");
  });

  it("no extract (no description) → no summary request", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { text: "x" } }));
    m = await mount(drawer({ ...row, summary: null }));
    await act(async () => {});
    expect(calls.some((c) => c.url === "/api/summary")).toBe(false);
    expect(summaryText()).toBeUndefined();
  });
});
