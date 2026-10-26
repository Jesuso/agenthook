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
let running = 0;
const file = (path: string) => ({ path, scope: "step", ids: ["code"], hash: "h", bytes: 5, mtime: null, exists: true, agentsRunning: running });

let m: Mounted | null = null;
const puts: string[] = [];
const sink: { current: ((ev: any) => void) | null } = { current: null };

beforeEach(() => {
  puts.length = 0;
  running = 0;
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
  it("a profile switch on a dirty buffer asks; cancel stays, Discard loads the other profile", async () => {
    const root = await dirtyView();
    const select = root.querySelector<HTMLSelectElement>("select")!;
    const pick = (v: string) =>
      act(async () => {
        select.value = v;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    await pick("other");
    expect(confirmDialog()?.textContent).toContain("Discard unsaved changes to the open instructions file?");
    await answerConfirm(false);
    expect(root.querySelector<HTMLSelectElement>("select")!.value).toBe("demo");
    expect(fetched("/api/instructions?profile=other")).toBe(false);
    await pick("other");
    await answerConfirm(true);
    await until(() => fetched("/api/instructions?profile=other"));
  });

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
});

describe("InstructionsView save confirm", () => {
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);

  it("saves straight through when no agent runs on the file, then acknowledges the save", async () => {
    const root = await dirtyView();
    await click(button("Save")!);
    const save = (await until(() => button("Save for next run")))!;
    expect(document.body.textContent).toContain("backed up in the profile's state directory");
    expect(save.disabled).toBe(false);
    await click(save);
    await until(() => puts.length === 1);
    await until(() => [...document.querySelectorAll('[role="status"]')].some((n) => n.textContent?.includes("Saved code.md")));
    expect(root.textContent).toMatch(/Saved \d/);
  });

  it("locks Save until the running agents are acknowledged", async () => {
    running = 2;
    await dirtyView();
    await click(button("Save")!);
    const save = (await until(() => button("Save for next run")))!;
    expect(save.disabled).toBe(true);
    const ack = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(ack.closest("label")!.textContent).toContain("2 agents are running on steps that use this file");
    await click(ack);
    expect(save.disabled).toBe(false);
    await click(save);
    await until(() => puts.length === 1);
  });
});

describe("InstructionsView accessibility", () => {
  it("names its controls and the page, and keeps a not-created file reachable", async () => {
    const files = [file("/a/code.md"), { ...file("/a/SOUL.md"), scope: "soul", exists: false }];
    (fetch as any).mockImplementation(async (url: string) => {
      if (url.startsWith("/api/instructions/file")) return new Response(JSON.stringify({ content: "hello", hash: "h" }), { status: 200 });
      return new Response(JSON.stringify({ configPath: null, files }), { status: 200 });
    });
    m = await mount(view());
    const root = m.root;
    await until(() => root.querySelector(".cm-content"));
    expect(root.querySelector("h1")!.textContent).toBe("Instructions");
    expect(root.querySelector("select")!.getAttribute("aria-label")).toBe("Profile");
    expect(root.querySelector('[role="radiogroup"]')!.getAttribute("aria-label")).toBe("Side panel");
    expect(root.querySelector(".cm-content")!.getAttribute("aria-label")).toBe("Instructions for code.md");
    expect(document.title).toBe("code.md · Instructions · demo · agenthook");
    const soul = [...root.querySelectorAll<HTMLButtonElement>("nav button")].find((b) => b.textContent?.includes("SOUL.md"))!;
    expect(soul.disabled).toBe(false);
    expect(soul.getAttribute("aria-disabled")).toBe("true");
    expect(soul.title).toContain("doesn't exist yet");
    await click(soul);
    expect(fetched("/api/instructions/file?profile=demo&path=%2Fa%2FSOUL.md")).toBe(false);
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
    expect(root.textContent).toContain("Renderizado");
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
