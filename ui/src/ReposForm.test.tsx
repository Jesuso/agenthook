// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReposForm } from "./ConfigForms";
import { answerConfirm, click, confirmDialog, mount } from "./domHarness";
import { ConfirmProvider } from "./Modal";
import type { Mounted } from "./domHarness";
import { I18nProvider } from "./i18n/react";
import { setLangSetting } from "./i18n";

// The Repos tab (#343): repoPath/worktreePrefix, the repos cards (add/remove/reorder, the single-
// default rule, the match tag list), each edit a minimal text edit.

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
  vi.unstubAllGlobals();
});

async function live(initial: unknown) {
  const texts: string[] = [];
  const start = typeof initial === "string" ? initial : JSON.stringify(initial, null, 2);
  function Host() {
    const [text, setText] = useState(start);
    return createElement(
      ConfirmProvider,
      null,
      createElement(ReposForm, {
        text,
        raw: JSON.parse(text),
        onEdit: (next: string) => {
          texts.push(next);
          setText(next);
        },
      }),
    );
  }
  m = await mount(createElement(Host));
  return { root: m.root, texts, text: () => texts.at(-1) ?? start, last: () => JSON.parse(texts.at(-1) ?? start) };
}

const field = <T extends Element = HTMLInputElement>(root: Element, name: string) => root.querySelector<T>(`[name="${name}"]`)!;
const card = (root: Element, i: number) => root.querySelector<HTMLElement>(`[data-repo-card="${i}"]`)!;

const setInput = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("no repos block", () => {
  it("shows repoPath/worktreePrefix and + Add repo; the first add seeds the synthesized default", async () => {
    const { root, last } = await live({ name: "p", repoPath: "/repo" });
    expect(root.textContent).toContain("Single repo: agents work in repoPath.");
    await click(root.querySelector("[data-add-repo]")!);
    expect(last().repos).toEqual([{ id: "default", path: "/repo", default: true }]);
  });
});

describe("repos: add / edit / remove / reorder", () => {
  it("a later add appends an empty card; id/path/instructionsFile/worktreePrefix edit the right keys", async () => {
    const { root, last } = await live({ repos: [{ id: "a", path: "./a", default: true }] });
    await click(root.querySelector("[data-add-repo]")!);
    expect(last().repos[1]).toEqual({ id: "", path: "" });
    await setInput(field(root, "repos.1.id"), "b");
    await setInput(field(root, "repos.1.path"), "./b");
    expect(last().repos[1]).toEqual({ id: "b", path: "./b" });

    const details = card(root, 1).querySelector("details")!;
    details.setAttribute("open", "");
    await setInput(field(root, "repos.1.instructionsFile"), "./AGENTS.md");
    await setInput(field(root, "repos.1.worktreePrefix"), "../wt");
    expect(last().repos[1]).toEqual({ id: "b", path: "./b", instructionsFile: "./AGENTS.md", worktreePrefix: "../wt" });
  });

  it("remove only after the confirm; ↑/↓ swap cards verbatim; removing the last repo drops the repos key", async () => {
    const a = { id: "a", path: "./a", default: true };
    const b = { id: "b", path: "./b" };
    const { root, texts, last } = await live({ repos: [a, b] });
    await click(card(root, 0).querySelector("[data-remove-repo]")!);
    expect(confirmDialog()?.textContent).toContain("Remove repo #1 (a)?");
    await answerConfirm(false);
    expect(confirmDialog()).toBeNull();
    expect(texts).toEqual([]);
    await click(card(root, 1).querySelector('[aria-label="move repo up"]')!);
    expect(last().repos).toEqual([b, a]);
    await click(card(root, 1).querySelector('[aria-label="move repo up"]')!);
    expect(last().repos).toEqual([a, b]);
    await click(card(root, 1).querySelector("[data-remove-repo]")!);
    await answerConfirm(true);
    expect(last().repos).toEqual([a]);
    await click(card(root, 0).querySelector("[data-remove-repo]")!);
    await answerConfirm(true);
    expect(last().repos).toBeUndefined();
  });
});

describe("repos: single default", () => {
  it("checking default on one card clears it on every other card in one edit", async () => {
    const { root, last } = await live({ repos: [{ id: "a", path: "./a", default: true }, { id: "b", path: "./b" }] });
    await click(field(root, "repos.1.default"));
    expect(last().repos).toEqual([{ id: "a", path: "./a" }, { id: "b", path: "./b", default: true }]);
  });

  it("a file with two defaults (set in Raw) shows the inline error on both cards", async () => {
    const { root } = await live({ repos: [{ id: "a", path: "./a", default: true }, { id: "b", path: "./b", default: true }] });
    expect(card(root, 0).textContent).toContain("at most one repo may set default:true");
    expect(card(root, 1).textContent).toContain("at most one repo may set default:true");
  });
});

describe("repos: match (string-list field)", () => {
  it("Enter adds a trimmed, non-empty, non-duplicate entry; removing the last chip removes match", async () => {
    const { root, last } = await live({ repos: [{ id: "a", path: "./a" }] });
    const input = field(root, "repos.0.match");
    await setInput(input, "ios");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(last().repos[0].match).toEqual(["ios"]);
    await setInput(input, "ios");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(last().repos[0].match).toEqual(["ios"]);
    await click(card(root, 0).querySelector('[aria-label="remove ios"]')!);
    expect(last().repos[0]).toEqual({ id: "a", path: "./a" });
  });

  it("a non-array match shows 'edit in Raw' instead of a chip list", async () => {
    const { root } = await live({ repos: [{ id: "a", path: "./a", match: "ios" }] });
    expect(card(root, 0).textContent).toContain("edit in Raw");
  });
});

describe("repos: unknown / non-object element", () => {
  it("renders read-only (remove/reorder only)", async () => {
    const { root } = await live({ repos: [{ id: "a", path: "./a" }, 5] });
    const c1 = card(root, 1);
    expect(c1.hasAttribute("data-repo-unknown")).toBe(true);
    expect(c1.textContent).toContain("edit in Raw");
    expect(c1.querySelectorAll("input, select")).toHaveLength(0);
  });
});

describe("ReposForm in Spanish (#562)", () => {
  afterEach(async () => {
    await m?.unmount();
    m = null;
    setLangSetting("en", []);
  });

  it("renders the list title, notes and the add button in Spanish", async () => {
    setLangSetting("es", []);
    const raw = { repoPath: "/repo" };
    const text = JSON.stringify(raw, null, 2);
    m = await mount(createElement(I18nProvider, null, createElement(ConfirmProvider, null, createElement(ReposForm, { text, raw, onEdit: () => {} }))));
    expect(m.root.querySelector("[data-repos-list] h3")!.textContent).toBe("Repositorios");
    expect(m.root.textContent).toContain("Un solo repositorio: los agentes trabajan en repoPath.");
    expect(m.root.textContent).toContain("+ Agregar repositorio");
  });
});
