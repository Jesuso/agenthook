// @vitest-environment happy-dom
import { act, createElement } from "react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InstructionsView from "./InstructionsView";
import { answerConfirm, click, confirmDialog, mount, until } from "./domHarness";
import type { Mounted } from "./domHarness";
import type { ProfileView } from "./contract";
import { I18nProvider } from "./i18n/react";
import { setLangSetting } from "./i18n";

// #370: the Instructions editor's discard / overwrite prompts go through the in-app ConfirmModal.

const profiles = [
  { name: "demo", label: "demo", up: false },
  { name: "other", label: "other", up: false },
] as unknown as ProfileView[];
const file = (path: string) => ({ path, scope: "step", ids: ["code"], hash: "h", bytes: 5, mtime: null, exists: true, agentsRunning: 0 });

let m: Mounted | null = null;
const puts: string[] = [];
const sink: { current: ((ev: any) => void) | null } = { current: null };

beforeEach(() => {
  puts.length = 0;
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts.push(url);
        return new Response(JSON.stringify({ hash: "h3" }), { status: 200 });
      }
      if (url.startsWith("/api/instructions/file")) return new Response(JSON.stringify({ content: "hello", hash: "h" }), { status: 200 });
      if (url.startsWith("/api/instructions")) return new Response(JSON.stringify({ configPath: null, files: [file("/a/code.md"), file("/a/review.md")] }), { status: 200 });
      return new Response("{}", { status: 404 });
    }),
  );
});

afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.unstubAllGlobals();
});

const view = () => createElement(InstructionsView, { profiles, eventSink: sink as any, onDirtyChange: () => {} });
const fetched = (u: string) => (fetch as any).mock.calls.some(([url]: [string]) => url === u);

/** Open the view, wait for the first file, then type into the editor: the buffer goes dirty. */
async function dirtyView() {
  m = await mount(view());
  const editor = (await until(() => m!.root.querySelector<HTMLElement>(".cm-editor")))!;
  await act(async () => {
    const ev = EditorView.findFromDOM(editor)!;
    ev.dispatch({ changes: { from: ev.state.doc.length, insert: " world" } });
  });
  await until(() => m!.root.textContent!.includes("modified"));
  return m.root;
}

describe("InstructionsView in-app confirms", () => {
  it("opening another file on a dirty buffer asks first", async () => {
    const root = await dirtyView();
    const other = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("review.md"))!;
    await click(other);
    expect(confirmDialog()).not.toBeNull();
    await answerConfirm(false);
    expect(fetched("/api/instructions/file?profile=demo&path=%2Fa%2Freview.md")).toBe(false);
    await click(other);
    await answerConfirm(true);
    await until(() => fetched("/api/instructions/file?profile=demo&path=%2Fa%2Freview.md"));
  });

  it("Overwrite on a conflict PUTs only after the confirm", async () => {
    const root = await dirtyView();
    await act(async () => sink.current!({ type: "instructions", profile: "demo", path: "/a/code.md", hash: "h2", source: "disk" }));
    await until(() => root.textContent!.includes("changed on disk"));
    const overwrite = () => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Overwrite")!;
    await click(overwrite());
    expect(confirmDialog()?.textContent).toContain("Overwrite the on-disk version with your buffer?");
    await answerConfirm(false);
    expect(puts).toEqual([]);
    await click(overwrite());
    await answerConfirm(true);
    await until(() => puts.length === 1);
  });

  it("Reload on a conflict asks before dropping the edits", async () => {
    const root = await dirtyView();
    await act(async () => sink.current!({ type: "instructions", profile: "demo", path: "/a/code.md", hash: "h2", source: "disk" }));
    await until(() => root.textContent!.includes("changed on disk"));
    const loads = () => (fetch as any).mock.calls.filter(([u]: [string]) => u.startsWith("/api/instructions/file?profile=demo&path=%2Fa%2Fcode.md")).length;
    const before = loads();
    await click(root.querySelector<HTMLButtonElement>("[data-reload]")!);
    expect(confirmDialog()).not.toBeNull();
    await answerConfirm(false);
    expect(loads()).toBe(before);
    expect(root.textContent).toContain("changed on disk");
  });

  it("the editor is on screen only in its own view; a reading view replaces it", async () => {
    m = await mount(view());
    await until(() => m!.root.querySelector(".cm-editor"));
    const pane = m.root.querySelector<HTMLElement>("[data-editor-pane]")!;
    expect(pane.className).not.toContain("hidden");
    await click([...m.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === "Preview")!);
    expect(pane.className).toContain("hidden");
    expect(m.root.querySelector(".md-preview")).not.toBeNull();
    // Still mounted: the buffer and its undo history survive the switch.
    expect(m.root.querySelector(".cm-editor")).not.toBeNull();
  });
});

describe("InstructionsView in Spanish", () => {
  afterEach(() => setLangSetting("en", []));

  it("renders its chrome, group labels and discard confirm in Spanish", async () => {
    setLangSetting("es", []);
    m = await mount(createElement(I18nProvider, null, view()));
    const editor = (await until(() => m!.root.querySelector<HTMLElement>(".cm-editor")))!;
    const root = m.root;
    expect(root.textContent).toContain("pasos");
    expect(root.textContent).toContain("Vista previa");
    expect(root.textContent).toContain("Sin cambios");
    await click([...root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent?.includes("Lo que ve el agente"))!);
    await until(() => root.textContent!.includes("no hay vista previa para este paso"));
    await act(async () => {
      const ev = EditorView.findFromDOM(editor)!;
      ev.dispatch({ changes: { from: ev.state.doc.length, insert: " mundo" } });
    });
    await until(() => root.textContent!.includes("● modificado"));
    const other = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("review.md"))!;
    await click(other);
    expect(confirmDialog()?.textContent).toContain("¿Descartar los cambios sin guardar del archivo de instrucciones abierto?");
    await answerConfirm(false);
  });
});

describe("the tab title (#757)", () => {
  it("Instructions · <profile> · agenthook, the profile drops with no profiles, agenthook after unmount", async () => {
    m = await mount(createElement(I18nProvider, null, view()));
    expect(document.title).toBe("Instructions · demo · agenthook");
    await m.rerender(createElement(I18nProvider, null, createElement(InstructionsView, { profiles: [], eventSink: sink as any, onDirtyChange: () => {} })));
    expect(document.title).toBe("Instructions · agenthook");
    await m.unmount();
    m = null;
    expect(document.title).toBe("agenthook");
  });
});
