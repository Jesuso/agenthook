// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConfigView from "./ConfigView";
import { FIELD_GRID_3, PipelineForm } from "./ConfigForms";
import { ConfirmProvider, Modal } from "./Modal";
import { DiffView } from "./DiffView";
import { click, mount, until } from "./domHarness";
import type { Mounted } from "./domHarness";
import type { ProfileView } from "./contract";

// #372: the Config page at phone width — no page-level horizontal scroll, reachable tabs, 40px targets.

const config = {
  name: "demo",
  repoPath: "/repo",
  tracker: {
    type: "github",
    pipeline: [
      { id: "triage", kind: "triage", sourceLabel: "agent:triage", successLabel: "agent:code" },
      { id: "code", kind: "implement", sourceLabel: "agent:code", successLabel: "agent:review", env: { A: "1" } },
    ],
  },
};
const profiles = [{ name: "demo", label: "demo", up: false }] as unknown as ProfileView[];
let fileText = JSON.stringify(config, null, 2);

let m: Mounted | null = null;
beforeEach(() => {
  fileText = JSON.stringify(config, null, 2);
  (Element.prototype as any).scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/config")) {
        return new Response(JSON.stringify({ path: "/home/someone/projects/a/very/long/path/agenthook.config.json", text: fileText, hash: "h", errors: [], literalSecrets: [] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: "down" }), { status: 503 });
    }),
  );
});
afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const view = () => createElement(ConfigView, { profiles, eventSink: { current: null }, onDirtyChange: () => {} });
const tabs = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>("[data-config-pane]")];
const tab = (root: HTMLElement, pane: string) => tabs(root).find((t) => t.dataset.configPane === pane)!;
const classes = (el: Element) => el.className.split(/\s+/);
/** A class that pins a width a phone can't hold: an arbitrary px width / min-width, or a large fixed `w-N`. */
const FIXED_WIDTH = /^(?:min-)?w-\[\d+px\]$|^(?:min-)?w-(?:\d{3,}|[6-9]\d)$/;

async function mountView() {
  m = await mount(view());
  await until(() => m!.root.querySelector("[data-step-card]"));
  return m.root;
}

describe("Config page width (#372)", () => {
  it("the page root and pane host shrink with the viewport: min-w-0, no fixed width", async () => {
    const root = await mountView();
    const page = root.firstElementChild!;
    const host = root.querySelector("[data-config-pane-host]")!;
    for (const el of [page, host, host.parentElement!]) {
      expect(classes(el)).toContain("min-w-0");
      expect(classes(el).filter((c) => FIXED_WIDTH.test(c))).toEqual([]);
    }
    await click(tab(root, "raw"));
    for (const el of [root.firstElementChild!, root.querySelector("[data-config-pane-host]")!]) {
      expect(classes(el)).toContain("min-w-0");
      expect(classes(el).filter((c) => FIXED_WIDTH.test(c))).toEqual([]);
    }
  });

  it("the header wraps below sm with the path on its own full-width row; one row at sm+", async () => {
    const root = await mountView();
    const path = root.querySelector<HTMLElement>("[data-config-path]")!;
    const header = path.parentElement!;
    expect(classes(header)).toEqual(expect.arrayContaining(["flex-wrap", "sm:flex-nowrap"]));
    expect(classes(path)).toEqual(expect.arrayContaining(["order-last", "w-full", "min-w-0", "truncate", "sm:order-none", "sm:w-auto"]));
    expect(path.title).toBe("/home/someone/projects/a/very/long/path/agenthook.config.json");
  });

  it("the tab row is a horizontal scroll container of non-shrinking, 40px-on-phone tabs", async () => {
    const root = await mountView();
    const row = root.querySelector<HTMLElement>("[data-config-tabs]")!;
    expect(classes(row)).toEqual(expect.arrayContaining(["flex", "flex-nowrap", "overflow-x-auto"]));
    expect(tabs(root)).toHaveLength(8);
    for (const t of tabs(root)) {
      expect(t.parentElement).toBe(row);
      expect(classes(t)).toEqual(expect.arrayContaining(["shrink-0", "min-h-10", "sm:min-h-0"]));
    }
  });

  it("the 'fix the JSON in Raw first' hint sits below the tab row, not inside it", async () => {
    fileText = "{ not json";
    m = await mount(view());
    await until(() => m!.root.textContent?.includes("fix the JSON in Raw first"));
    const row = m.root.querySelector<HTMLElement>("[data-config-tabs]")!;
    expect(row.textContent).not.toContain("fix the JSON");
  });

  it("shows an edge fade only on the side that hides tabs", async () => {
    let scrollWidth = 200;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-config-tabs") ? 200 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-config-tabs") ? scrollWidth : 0;
    });
    const root = await mountView();
    expect(root.querySelector("[data-tab-fade]")).toBeNull();
    scrollWidth = 640;
    const row = root.querySelector<HTMLElement>("[data-config-tabs]")!;
    await click(tab(root, "basics"));
    expect(root.querySelector('[data-tab-fade="end"]')).not.toBeNull();
    expect(root.querySelector('[data-tab-fade="start"]')).toBeNull();
    row.scrollLeft = 440;
    await until(() => (row.dispatchEvent(new Event("scroll")), root.querySelector('[data-tab-fade="start"]')));
    expect(root.querySelector('[data-tab-fade="end"]')).toBeNull();
  });

  it("switching panes scrolls the tab row (horizontally only) so the active tab is visible", async () => {
    // A 200px-wide row of 80px tabs: tab i spans [80i, 80i + 80) in the row's content box.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-config-tabs") ? 200 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-config-tabs") ? 640 : 0;
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const row = this.closest<HTMLElement>("[data-config-tabs]");
      const pane = (this as HTMLElement).dataset?.configPane;
      if (pane && row) {
        const left = tabs(row.parentElement!).findIndex((t) => t === this) * 80 - row.scrollLeft;
        return { left, right: left + 80, width: 80, top: 0, bottom: 40, height: 40, x: left, y: 0, toJSON() {} } as DOMRect;
      }
      return { left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    });
    const root = await mountView();
    const row = root.querySelector<HTMLElement>("[data-config-tabs]")!;
    expect(row.scrollLeft).toBe(0);
    await click(tab(root, "raw"));
    // raw is tab 7: [560, 640) → scrolled so its end + the 32px fade margin is at the row's right edge.
    expect(row.scrollLeft).toBe(640 + 32 - 200);
    await click(tab(root, "basics"));
    expect(row.scrollLeft).toBe(0);
    // The page itself is never scrolled for a tab.
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("the pipeline graph box is height-capped below sm and scrolls inside", async () => {
    const root = await mountView();
    const graph = root.querySelector<HTMLElement>("[data-config-graph]")!;
    expect(graph.querySelector('svg[aria-label="pipeline graph"]')).not.toBeNull();
    expect(classes(graph)).toEqual(expect.arrayContaining(["max-h-64", "overflow-auto", "sm:max-h-none"]));
    const toggle = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("Pipeline graph"))!;
    expect(classes(toggle)).toEqual(expect.arrayContaining(["min-h-10", "sm:min-h-0"]));
  });
});

describe("PipelineForm at phone width (#372)", () => {
  const raw = JSON.parse(JSON.stringify(config));
  const text = JSON.stringify(raw, null, 2);
  const form = () => createElement(ConfirmProvider, null, createElement(PipelineForm, { text, raw, stages: null, onRefresh: () => {}, onEdit: () => {} }));

  it("FIELD_GRID_3 is one column by default, 2 then 3 by container width", () => {
    expect(FIELD_GRID_3.split(" ")).toEqual(expect.arrayContaining(["grid-cols-1", "@[28rem]:grid-cols-2", "@[44rem]:grid-cols-3"]));
    expect(FIELD_GRID_3).not.toMatch(/(^|\s)grid-cols-[2-9]/);
  });

  it("the form is a container; an expanded card has no fixed multi-column grid and no col-span-3", async () => {
    m = await mount(form());
    const root = m.root.querySelector<HTMLElement>("[data-pipeline-form]")!;
    expect(classes(root)).toContain("@container");
    const card = m.root.querySelectorAll<HTMLElement>("[data-step-card]")[1];
    await click(card.querySelector('[aria-label="expand step"]')!);
    card.querySelector("details")!.open = true;
    const all = [card, ...card.querySelectorAll<HTMLElement>("*")];
    const grids = all.filter((el) => classes(el).includes("grid"));
    expect(grids.length).toBeGreaterThan(5);
    for (const g of grids) expect(classes(g).filter((c) => /^grid-cols-([2-9]|1\d)$/.test(c)), g.outerHTML.slice(0, 80)).toEqual([]);
    expect(all.filter((el) => classes(el).includes("col-span-3"))).toEqual([]);
    expect(card.querySelector("[data-step-env]")!.className).toContain("col-span-full");
    expect([...card.querySelectorAll("[data-escalate-row]")].every((r) => r.className === FIELD_GRID_3)).toBe(true);
  });

  it("the card header wraps below sm; expand / move / remove buttons are 40px on a phone only", async () => {
    m = await mount(form());
    const card = m.root.querySelectorAll<HTMLElement>("[data-step-card]")[1];
    const header = card.querySelector<HTMLElement>("[data-step-header]")!;
    expect(classes(header)).toEqual(expect.arrayContaining(["flex-wrap", "sm:flex-nowrap"]));
    await click(card.querySelector('[aria-label="expand step"]')!);
    const buttons = [
      card.querySelector('[aria-label="collapse step"]')!,
      card.querySelector('[aria-label="move up"]')!,
      card.querySelector('[aria-label="move down"]')!,
      [...card.querySelectorAll("button")].find((b) => b.textContent === "remove")!,
      card.querySelector('[aria-label="remove variable"]')!,
    ];
    for (const b of buttons) expect(classes(b)).toEqual(expect.arrayContaining(["min-h-10", "min-w-10", "sm:min-h-0", "sm:min-w-0"]));
  });
});

describe("Modal at phone width (#372)", () => {
  it("tight backdrop padding below sm, and the body scrolls inside the dialog", async () => {
    m = await mount(
      <Modal title="t" onClose={() => {}}>
        <DiffView a="a" b="b" />
        <button>Save</button>
      </Modal>,
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(classes(dialog.parentElement!)).toEqual(expect.arrayContaining(["p-2", "sm:p-6"]));
    expect(classes(dialog)).toEqual(expect.arrayContaining(["max-h-full", "min-w-0"]));
    const body = dialog.querySelector<HTMLElement>("[data-modal-body]")!;
    expect(classes(body)).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "overflow-auto"]));
    expect(body.textContent).toContain("Save");
  });
});
