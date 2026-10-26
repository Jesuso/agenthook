// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, createElement } from "react";
import { TicketDrawer } from "./TicketDrawer";
import type { RunView } from "./contract";
import { click, mount } from "./domHarness";
import { ReleasePanel } from "./ReleasePanel";
import { I18nProvider } from "./i18n/react";
import { setLangSetting } from "./i18n";
import type { TicketRow } from "./contract";

const run = (step: string, startedAt: string, endedAt: string | null, outcome: string | null, extra: Partial<RunView> = {}): RunView => ({
  run: `${startedAt}-step-${step}-CAHUI-263.log`,
  step,
  startedAt,
  endedAt,
  outcome,
  costUsd: 0.25,
  unpriced: false,
  estUsd: null,
  costBasis: "reported",
  running: false,
  bytes: 10,
  ...extra,
});

// Newest first, as /api/runs lists them: review sent it back to code, code → review → qa (running).
const RUNS: RunView[] = [
  run("qa", "2026-10-25T17:33:29Z", null, null, { running: true, costUsd: null }),
  run("review", "2026-10-25T17:32:02Z", "2026-10-25T17:33:27Z", "advance"),
  run("code", "2026-10-25T17:31:15Z", "2026-10-25T17:32:00Z", "advance"),
  run("review", "2026-10-25T17:28:30Z", "2026-10-25T17:31:12Z", "changes", { plain: "Two doc links are broken; sent back to fix them." }),
];

const LOG = ["# CAHUI-263  docs", "Reading the diff.", "Two paths don't resolve.", "**Blocking:**", "- `AGENTS.md:24` cites the wrong path"].join("\n");

class FakeSource {
  static last: FakeSource | null = null;
  listeners = new Map<string, (ev: MessageEvent) => void>();
  readyState = 1;
  constructor(public url: string) {
    FakeSource.last = this;
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, fn);
  }
  close() {}
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe("TicketDrawer runs", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ runs: RUNS }) })));
    vi.stubGlobal("EventSource", FakeSource);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  const open = async () => {
    const m = await mount(createElement(TicketDrawer, { profile: "cahui", ticketRef: "CAHUI-263", ticket: undefined, runsNonce: 0, onClose: () => {} }));
    await act(async () => {});
    return m;
  };

  it("draws one lane per step in pipeline order, one bar per run, and a dashed curve for the bounce", async () => {
    const { root, unmount } = await open();
    const lanes = root.querySelector('section[aria-label="Runs by step over time"]')!;
    expect([...lanes.querySelectorAll(".truncate.text-label")].map((e) => e.textContent)).toEqual(["code", "review", "qa"]);
    expect(lanes.querySelectorAll("button")).toHaveLength(4);
    const paths = [...lanes.querySelectorAll("path")];
    expect(paths).toHaveLength(3);
    expect(paths.filter((p) => p.getAttribute("stroke-dasharray"))).toHaveLength(1);
    await unmount();
  });

  it("selects the newest run, captions it, and switches on a bar click", async () => {
    const { root, unmount } = await open();
    const caption = () => root.querySelector("[data-run-caption]")!.textContent;
    expect(caption()).toMatch(/^qarunning/);
    expect(root.querySelector('button[aria-pressed="true"]')!.getAttribute("aria-label")).toMatch(/^qa running/);
    await click(root.querySelector('button[aria-label^="review changes"]')!);
    expect(caption()).toMatch(/^reviewchanges2m 42s\$0\.25/);
    expect(FakeSource.last!.url).toContain(encodeURIComponent("2026-10-25T17:28:30Z-step-review-CAHUI-263.log"));
    await unmount();
  });

  it("reads the log as a story by default and keeps Raw one click away", async () => {
    const { root, unmount } = await open();
    await act(async () => FakeSource.last!.emit("init", { text: LOG, truncated: false, size: LOG.length }));
    expect([...root.querySelectorAll("[data-story-beat]")].map((e) => e.textContent)).toEqual(["Reading the diff.", "Two paths don't resolve."]);
    expect(root.querySelector("[data-story-prose] li")!.textContent).toContain("AGENTS.md:24");
    await click(root.querySelector('[data-log-view="raw"]')!);
    expect(root.querySelector("[data-run-story]")).toBeNull();
    expect(root.textContent).toContain("**Blocking:**");
    expect(localStorage.getItem("ah.log.view")).toBe("raw");
    await unmount();
  });

  it("shows the selected run's plain sentence as prose right under its caption, and nothing for a run without one", async () => {
    const { root, unmount } = await open();
    expect(root.querySelector("[data-run-plain]")).toBeNull();
    await click(root.querySelector('button[aria-label^="review changes"]')!);
    const plain = root.querySelector("[data-run-caption]")!.nextElementSibling!;
    expect(plain.hasAttribute("data-run-plain")).toBe(true);
    expect(plain.textContent).toBe("Two doc links are broken; sent back to fix them.");
    expect(plain.className).not.toContain("font-mono");
    await unmount();
  });
});

describe("TicketDrawer in Spanish", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ runs: RUNS }) })));
    vi.stubGlobal("EventSource", FakeSource);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    localStorage.clear();
    setLangSetting("es", []);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setLangSetting("en", []);
  });

  it("renders the drawer and log chrome in Spanish; step ids and verdicts stay as written", async () => {
    const m = await mount(createElement(I18nProvider, null, createElement(TicketDrawer, { profile: "cahui", ticketRef: "CAHUI-263", ticket: undefined, runsNonce: 0, onClose: () => {} })));
    await act(async () => {});
    const { root } = m;
    expect(document.querySelector('[role="dialog"]')!.getAttribute("aria-label")).toBe("Ticket CAHUI-263");
    expect(root.querySelector('section[aria-label="Ejecuciones por paso a lo largo del tiempo"]')).toBeTruthy();
    expect(root.querySelector('button[aria-label="Cerrar"]')).toBeTruthy();
    expect(root.querySelector("[data-run-caption]")!.textContent).toMatch(/^qaen curso/);
    expect(root.querySelector("[data-run-caption]")!.textContent).toContain("iniciada ");
    expect(root.querySelector('button[aria-label^="review changes"]')).toBeTruthy();
    expect(root.textContent).toContain("Relato");
    expect(root.textContent).toContain("0 líneas");
    await act(async () => FakeSource.last!.emit("init", { text: "# CAHUI-263  docs\n", truncated: false, size: 18 }));
    expect(root.textContent).toContain("Esperando el primer mensaje del agente…");
    await m.unmount();
  });

  it("renders the release panel in Spanish", async () => {
    const t = { profile: "cahui", ref: "CAHUI-263", step: "review" } as TicketRow;
    const m = await mount(createElement(I18nProvider, null, createElement(ReleasePanel, { ticket: t, onRelease: async () => ({ ok: true }) as never, onClose: () => {} })));
    expect(m.root.textContent).toContain("Respuesta para el agente (opcional) — se agrega a su prompt cuando reejecute el paso review");
    expect(m.root.textContent).toContain("Liberar");
    expect(m.root.textContent).toContain("Cancelar");
    await m.unmount();
  });
});
