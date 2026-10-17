// @vitest-environment happy-dom
import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BasicsForm, PipelineForm, fieldMeta } from "./ConfigForms";
import { numberEdit, textEdit } from "./configEdit";
import { STEP_KINDS, schemaEntry, stepEntry } from "../../src/config-schema.js";
import { click, mount } from "./domHarness";
import type { Mounted } from "./domHarness";

// The Basics and step fields render from src/config-schema.js: label, raw key, "?" help, placeholder.

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
});

/** The help bubble a control's aria-describedby names (must resolve), else null. */
const describedBy = (el: Element) => {
  const id = el.getAttribute("aria-describedby");
  return id ? document.getElementById(id) : null;
};

/** Assert `control` is described by a tooltip holding `help`, and its field shows `label`, the raw `key` in monospace and a "?" HelpTip. */
function expectHelp(control: Element, key: string, label: string, help: string) {
  const tip = describedBy(control);
  expect(tip?.getAttribute("role"), key).toBe("tooltip");
  expect(tip!.textContent).toBe(help);
  const helpButton = document.querySelector(`button[aria-describedby="${tip!.id}"]`);
  expect(helpButton?.getAttribute("aria-label")).toBe(`Help: ${label}`);
  const field = helpButton!.parentElement!.parentElement!;
  expect(field.textContent).toContain(label);
  expect([...field.querySelectorAll(".font-mono")].map((e) => e.textContent)).toContain(key);
}

const setInput = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("fieldMeta", () => {
  it("reads label, help and a '(default)' placeholder off the schema; a path with no entry falls back to its key", () => {
    expect(fieldMeta(["tracker", "pipeline", 3, "maxAttempts"])).toMatchObject({ label: "Max attempts", hint: "maxAttempts", placeholder: "3 (default)" });
    expect(fieldMeta(["tracker", "pipeline", 0, "idleMinutes"]).placeholder).toBe("off");
    expect(fieldMeta(["trigger"]).placeholder).toBe("@agent (default)");
    expect(fieldMeta(["tracker", "pipeline", 0, "id"]).placeholder).toBeUndefined();
    expect(fieldMeta(["nope"])).toMatchObject({ entry: undefined, label: "nope", hint: "nope", help: undefined });
  });
});

describe("BasicsForm help", () => {
  const raw = { name: "p", repoPath: "/r", tracker: { type: "github" } };
  const basics = (onEdit = vi.fn()) => createElement(BasicsForm, { text: JSON.stringify(raw, null, 2), onEdit, raw, stateKey: "p" });

  it("every Basics field has the schema's label, raw key and help, wired to its control", async () => {
    m = await mount(basics());
    for (const key of ["name", "trigger", "maxConcurrent", "port", "fullAuto"]) {
      const e = schemaEntry([key])!;
      expectHelp(m.root.querySelector(`[name="${key}"]`)!, key, e.label, e.help);
    }
    expectHelp(m.root.querySelector('[aria-label="profile colour"]')!, "color", "Colour", schemaEntry(["ui", "color"])!.help);
    await click([...m.root.querySelectorAll("button")].find((b) => b.textContent === "Choose emoji")!);
    expectHelp(m.root.querySelector('[aria-label="profile emoji"]')!, "emoji", "Emoji", schemaEntry(["ui", "emoji"])!.help);
    expect(m.root.querySelector(`button[aria-label="Help: Appearance"]`)).not.toBeNull();
  });

  it("placeholders and min come from the schema", async () => {
    m = await mount(basics());
    const input = (k: string) => m!.root.querySelector<HTMLInputElement>(`input[name="${k}"]`)!;
    expect(input("trigger").placeholder).toBe("@agent (default)");
    expect(input("maxConcurrent").placeholder).toBe("1 (default)");
    expect(input("maxConcurrent").getAttribute("min")).toBe("1");
    expect(input("port").placeholder).toBe("4123 (default)");
  });

  it("the fullAuto danger warning stays inline, outside every tooltip", async () => {
    m = await mount(basics());
    const warning = [...m.root.querySelectorAll("p")].find((p) => p.textContent?.includes("--dangerously-skip-permissions"));
    expect(warning).toBeDefined();
    expect(warning!.closest('[role="tooltip"]')).toBeNull();
    expect(warning!.hidden).toBe(false);
  });

  it("a number edit yields the same buffer as numberEdit (no clamping)", async () => {
    const onEdit = vi.fn();
    m = await mount(basics(onEdit));
    await setInput(m.root.querySelector<HTMLInputElement>('input[name="maxConcurrent"]')!, "0");
    const r = numberEdit(JSON.stringify(raw, null, 2), ["maxConcurrent"], "0");
    expect(r.ok && onEdit.mock.calls.at(-1)?.[0]).toBe(r.ok && r.text);
  });
});

describe("PipelineForm step help", () => {
  const raw = { tracker: { type: "github", pipeline: [{ id: "code", kind: "implement", sourceLabel: "agent:code" }] } };
  const text = JSON.stringify(raw, null, 2);
  const stages = { source: { kind: "list" as const, stages: [{ id: "agent:code", label: "Code" }] }, body: null };
  const form = (onEdit = vi.fn()) => createElement(PipelineForm, { text, raw, stages, onRefresh: () => {}, onEdit });

  it("every step field shows its schema help and raw key; stage roles keep their labels with the tracker key's help", async () => {
    m = await mount(form());
    await click(m.root.querySelector('[aria-label="expand step"]')!);
    for (const key of ["id", "kind", "manual", "model", "effort", "instructionsFile", "maxAttempts", "maxMinutes", "idleMinutes", "createsWorktree", "drainWorktree"]) {
      const e = stepEntry(key)!;
      expectHelp(m.root.querySelector(`[name="tracker.pipeline.0.${key}"]`)!, key, e.label, e.help);
    }
    const roles: Array<[string, string]> = [
      ["sourceLabel", "Starts when in"],
      ["successLabel", "On success →"],
      ["failureLabel", "On failure →"],
      ["holdLabel", "On hold →"],
      ["queueLabel", "Backlog (queue)"],
    ];
    for (const [key, label] of roles) expectHelp(m.root.querySelector(`[name="tracker.pipeline.0.${key}"]`)!, key, label, stepEntry(key)!.help);
  });

  it("placeholders, min and options come from the schema", async () => {
    m = await mount(form());
    await click(m.root.querySelector('[aria-label="expand step"]')!);
    const input = (k: string) => m!.root.querySelector<HTMLInputElement>(`[name="tracker.pipeline.0.${k}"]`)!;
    expect(input("maxAttempts").placeholder).toBe("3 (default)");
    expect(input("maxAttempts").getAttribute("min")).toBe("1");
    expect(input("maxMinutes").placeholder).toBe("120 (default)");
    expect(input("maxMinutes").getAttribute("min")).toBe("0");
    expect(input("idleMinutes").placeholder).toBe("off");
    expect([...input("kind").querySelectorAll("option")].map((o) => o.value)).toEqual(["", ...STEP_KINDS]);
  });

  it("text and number edits produce the same buffer as the edit functions", async () => {
    const onEdit = vi.fn();
    m = await mount(form(onEdit));
    await click(m.root.querySelector('[aria-label="expand step"]')!);
    await setInput(m.root.querySelector<HTMLInputElement>('[name="tracker.pipeline.0.maxMinutes"]')!, "45");
    const n = numberEdit(text, ["tracker", "pipeline", 0, "maxMinutes"], "45");
    expect(n.ok && onEdit.mock.calls.at(-1)?.[0]).toBe(n.ok && n.text);
    await setInput(m.root.querySelector<HTMLInputElement>('[name="tracker.pipeline.0.instructionsFile"]')!, "CODE.md");
    expect(onEdit.mock.calls.at(-1)?.[0]).toBe(textEdit(text, ["tracker", "pipeline", 0, "instructionsFile"], "CODE.md"));
  });
});
