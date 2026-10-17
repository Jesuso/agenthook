// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { EditorView } from "@codemirror/view";
import ConfigView from "./ConfigView";
import { answerConfirm, click, confirmDialog, mount, pressEnter, until } from "./domHarness";
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
let fileHash = "h";
const puts: unknown[] = [];

beforeEach(() => {
  fileText = JSON.stringify(config, null, 2);
  fileHash = "h";
  puts.length = 0;
  dirty.mockClear();
  (Element.prototype as any).scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") puts.push(url);
      if (url.startsWith("/api/config")) {
        return new Response(JSON.stringify({ path: "/cfg/agenthook.config.json", text: fileText, hash: fileHash, errors: [], literalSecrets: [] }), { status: 200 });
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
  it("renders Basics, Pipeline, Tracker, Forge, Ingress, Integrations, Repos, Raw in that order and opens a valid config on Pipeline with the graph expanded", async () => {
    m = await mount(view());
    await until(() => m!.root.querySelector("[data-step-card]"));
    expect(tabs(m.root).map((t) => t.dataset.configPane)).toEqual(["basics", "pipeline", "tracker", "forge", "ingress", "integrations", "repos", "raw"]);
    expect(activeTab(m.root)).toBe("pipeline");
    expect(m.root.querySelector('svg[aria-label="pipeline graph"]')).not.toBeNull();
    expect([...m.root.querySelectorAll<HTMLElement>("[data-step-card]")].every((c) => c.dataset.open === "false")).toBe(true);
  });

  it("an unparseable config falls back to Raw with the form tabs disabled and the hint shown", async () => {
    fileText = "{ not json";
    m = await mount(view());
    await until(() => activeTab(m!.root) === "raw");
    const byPane = Object.fromEntries(tabs(m.root).map((t) => [t.dataset.configPane, t]));
    for (const t of ["basics", "pipeline", "tracker", "forge", "ingress", "integrations"]) {
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

// #370: Revert, and every "are you sure?" through the in-app ConfirmModal.
describe("ConfigView revert + in-app confirms", () => {
  const sink: { current: ((ev: any) => void) | null } = { current: null };
  const viewWith = (ps = profiles) => createElement(ConfigView, { profiles: ps, eventSink: sink as any, onDirtyChange: dirty });
  const button = (root: HTMLElement, text: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;
  const revertButton = (root: HTMLElement) => root.querySelector<HTMLButtonElement>("[data-revert]")!;
  const rawText = (root: HTMLElement) => EditorView.findFromDOM(root.querySelector<HTMLElement>(".cm-editor")!)!.state.doc.toString();
  const setInput = (el: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  /** Edit the label on Basics: the buffer goes dirty. */
  const makeDirty = async (root: HTMLElement) => {
    await click(tabs(root).find((t) => t.dataset.configPane === "basics")!);
    await setInput(root.querySelector<HTMLInputElement>('[name="name"]')!, "renamed");
    expect(root.textContent).toContain("● modified");
  };

  it("Revert is disabled on a clean buffer; cancel keeps the edits; confirm restores the loaded text in Raw", async () => {
    m = await mount(viewWith());
    await until(() => m!.root.querySelector("[data-step-card]"));
    expect(revertButton(m.root).disabled).toBe(true);
    await makeDirty(m.root);
    await click(tabs(m.root).find((t) => t.dataset.configPane === "raw")!);
    expect(rawText(m.root)).toContain('"renamed"');

    await click(revertButton(m.root));
    expect(confirmDialog()?.textContent).toContain("Discard unsaved changes to the open config?");
    await answerConfirm(false);
    expect(m.root.textContent).toContain("● modified");
    expect(rawText(m.root)).toContain('"renamed"');

    await click(revertButton(m.root));
    await answerConfirm(true);
    expect(m.root.textContent).not.toContain("● modified");
    expect(rawText(m.root)).toBe(fileText);
    expect(revertButton(m.root).disabled).toBe(true);
    expect(puts).toEqual([]);
  });

  it("a conflict: Overwrite asks first; over the diff modal one Escape closes only the confirm", async () => {
    m = await mount(viewWith());
    await until(() => m!.root.querySelector("[data-step-card]"));
    await makeDirty(m.root);
    await act(async () => sink.current!({ type: "config", profile: "demo", hash: "h2", source: "disk" }));
    expect(m.root.textContent).toContain("changed on disk");

    await click(button(m.root, "Overwrite"));
    expect(confirmDialog()?.textContent).toContain("Overwrite the on-disk config with your buffer?");
    await answerConfirm(false);
    expect(puts).toEqual([]);

    // The diff modal's own Overwrite: Escape closes the confirm, the diff stays.
    fileText = JSON.stringify({ ...config, name: "from-disk" }, null, 2);
    fileHash = "h2";
    await click(button(m.root, "Diff"));
    await until(() => m!.root.querySelector('[role="dialog"]'));
    const inner = [...m.root.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === "Overwrite")!;
    await click(inner);
    expect(confirmDialog()).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(confirmDialog()).toBeNull();
    expect(m.root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(puts).toEqual([]);
  });

  it("Revert on a conflict pulls the newer disk version (stale → silent reload)", async () => {
    m = await mount(viewWith());
    await until(() => m!.root.querySelector("[data-step-card]"));
    await makeDirty(m.root);
    await act(async () => sink.current!({ type: "config", profile: "demo", hash: "h2", source: "disk" }));
    fileText = JSON.stringify({ ...config, name: "from-disk" }, null, 2);
    fileHash = "h2";
    await click(revertButton(m.root));
    await answerConfirm(true);
    await until(() => !m!.root.textContent!.includes("changed on disk") && m!.root.querySelector<HTMLInputElement>('[name="name"]')?.value === "from-disk");
    expect(m.root.textContent).not.toContain("● modified");
  });

  it("Overwrite on a conflict PUTs only after the confirm", async () => {
    m = await mount(viewWith());
    await until(() => m!.root.querySelector("[data-step-card]"));
    await makeDirty(m.root);
    await act(async () => sink.current!({ type: "config", profile: "demo", hash: "h2", source: "disk" }));
    await click(button(m.root, "Overwrite"));
    await answerConfirm(true);
    await until(() => puts.length === 1);
    expect(puts[0]).toBe("/api/config");
  });

  it("a profile switch on a dirty buffer asks; cancel stays, Discard loads the other profile", async () => {
    const two = [...profiles, { name: "other", label: "other", up: false }] as unknown as ProfileView[];
    m = await mount(viewWith(two));
    await until(() => m!.root.querySelector("[data-step-card]"));
    await makeDirty(m.root);
    const select = m.root.querySelector<HTMLSelectElement>("select")!;
    const pick = (v: string) =>
      act(async () => {
        select.value = v;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    await pick("other");
    expect(confirmDialog()?.textContent).toContain("Discard unsaved changes to the open config?");
    await answerConfirm(false);
    expect(m.root.querySelector<HTMLSelectElement>("select")!.value).toBe("demo");
    expect(m.root.textContent).toContain("● modified");
    await pick("other");
    await answerConfirm(true);
    await until(() => (fetch as any).mock.calls.some(([u]: [string]) => u === "/api/config?profile=other"));
    expect(m.root.querySelector<HTMLSelectElement>("select")!.value).toBe("other");
  });

  it("removing a step asks; cancel keeps it, confirm removes it", async () => {
    m = await mount(viewWith());
    await until(() => m!.root.querySelector("[data-step-card]"));
    const removeCode = () => [...m!.root.querySelector('[data-step-card="code"]')!.querySelectorAll("button")].find((b) => b.textContent === "remove")!;
    await click(removeCode());
    expect(confirmDialog()?.textContent).toContain('Remove step "code"?');
    await answerConfirm(false);
    expect(m.root.querySelector('[data-step-card="code"]')).not.toBeNull();
    await click(removeCode());
    await answerConfirm(true);
    expect(m.root.querySelector('[data-step-card="code"]')).toBeNull();
    expect(m.root.textContent).toContain("● modified");
  });

  it("keeps the native beforeunload prompt registered while dirty", async () => {
    const add = vi.spyOn(window, "addEventListener");
    m = await mount(viewWith());
    await until(() => m!.root.querySelector("[data-step-card]"));
    expect(add.mock.calls.some(([t]) => t === "beforeunload")).toBe(false);
    await makeDirty(m.root);
    expect(add.mock.calls.some(([t]) => t === "beforeunload")).toBe(true);
    add.mockRestore();
  });
});
