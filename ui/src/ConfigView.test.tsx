// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import ConfigView from "./ConfigView";
import { click, mount, pressEnter, until } from "./domHarness";
import type { Mounted } from "./domHarness";
import type { ProfileView } from "./contract";

const config = {
  name: "demo",
  repoPath: "/repo",
  tracker: {
    type: "github",
    pipeline: [
      { id: "triage", kind: "triage", sourceLabel: "agent:triage", successLabel: "agent:code" },
      { id: "code", kind: "implement", sourceLabel: "agent:code", successLabel: "agent:review" },
      { id: "review", kind: "review", sourceLabel: "agent:review", successLabel: "agent:done" },
    ],
  },
};
const profiles = [{ name: "demo", label: "demo", up: false }] as unknown as ProfileView[];

let m: Mounted | null = null;
let fileText = JSON.stringify(config, null, 2);
const puts: unknown[] = [];

beforeEach(() => {
  fileText = JSON.stringify(config, null, 2);
  puts.length = 0;
  dirty.mockClear();
  (Element.prototype as any).scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") puts.push(url);
      if (url.startsWith("/api/config")) {
        return new Response(JSON.stringify({ path: "/cfg/agenthook.config.json", text: fileText, hash: "h", errors: [], literalSecrets: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "down" }), { status: 503 });
    }),
  );
});

afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.unstubAllGlobals();
});

const dirty = vi.fn();
const view = () => createElement(ConfigView, { profiles, eventSink: { current: null }, onDirtyChange: dirty });
const tabs = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>("[data-config-pane]")];
const activeTab = (root: HTMLElement) => tabs(root).find((t) => t.className.includes("border-[var(--color-accent)]"))?.dataset.configPane;

describe("ConfigView panes", () => {
  it("renders Basics, Pipeline, Tracker, Forge, Ingress, Raw in that order and opens a valid config on Pipeline with the graph expanded", async () => {
    m = await mount(view());
    await until(() => m!.root.querySelector("[data-step-card]"));
    expect(tabs(m.root).map((t) => t.dataset.configPane)).toEqual(["basics", "pipeline", "tracker", "forge", "ingress", "raw"]);
    expect(activeTab(m.root)).toBe("pipeline");
    expect(m.root.querySelector('svg[aria-label="pipeline graph"]')).not.toBeNull();
    expect([...m.root.querySelectorAll<HTMLElement>("[data-step-card]")].every((c) => c.dataset.open === "false")).toBe(true);
  });

  it("an unparseable config falls back to Raw with the form tabs disabled and the hint shown", async () => {
    fileText = "{ not json";
    m = await mount(view());
    await until(() => activeTab(m!.root) === "raw");
    const byPane = Object.fromEntries(tabs(m.root).map((t) => [t.dataset.configPane, t]));
    for (const t of ["basics", "pipeline", "tracker", "forge", "ingress"]) {
      expect(byPane[t].disabled, t).toBe(true);
      expect(byPane[t].title, t).toBe("fix the JSON in Raw first");
    }
    expect(byPane.raw.disabled).toBe(false);
    expect(m.root.textContent).toContain("fix the JSON in Raw first");
    expect(m.root.querySelector("[data-step-card]")).toBeNull();
  });
});

describe("ConfigView graph → card", () => {
  it("clicking a step node opens and scrolls to that card", async () => {
    m = await mount(view());
    await until(() => m!.root.querySelector("[data-graph-step]"));
    await click(m.root.querySelector('[data-graph-step="code"]')!);
    const card = m.root.querySelector<HTMLElement>('[data-step-card="code"]')!;
    expect(card.dataset.open).toBe("true");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect((Element.prototype.scrollIntoView as any).mock.contexts.at(-1)).toBe(card);
    // View state only: no save request, and the buffer never went dirty.
    expect(puts).toEqual([]);
    expect(dirty).not.toHaveBeenCalledWith(true);
  });

  it("from the Basics pane, Enter on a step node switches to Pipeline at that card", async () => {
    m = await mount(view());
    await until(() => m!.root.querySelector("[data-step-card]"));
    await click(tabs(m.root).find((t) => t.dataset.configPane === "basics")!);
    expect(activeTab(m.root)).toBe("basics");
    // The graph collapses off Pipeline; open it to reach the nodes.
    const graphToggle = [...m.root.querySelectorAll("button")].find((b) => b.textContent?.includes("Pipeline graph"))!;
    await click(graphToggle);
    await pressEnter(m.root.querySelector('[data-graph-step="review"]')!);
    expect(activeTab(m.root)).toBe("pipeline");
    const card = m.root.querySelector<HTMLElement>('[data-step-card="review"]')!;
    expect(card.dataset.open).toBe("true");
    expect((Element.prototype.scrollIntoView as any).mock.contexts.at(-1)).toBe(card);
    expect(dirty).not.toHaveBeenCalledWith(true);
  });
});
