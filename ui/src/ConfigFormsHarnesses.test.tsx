// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { BasicsForm, PipelineForm } from "./ConfigForms";
import { answerConfirm, click, mount } from "./domHarness";
import { ConfirmProvider } from "./Modal";
import type { Mounted } from "./domHarness";

// The named-harnesses editors (#620): the `harnesses` record card list (Basics → Advanced) and a
// step's harness pick — every edit a minimal text edit that keeps the steps' references valid.

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
});

/** Mount `form` over a live buffer (each edit re-renders, like ConfigView); `texts` records every edit. */
async function live(initial: unknown, form: "basics" | "pipeline" = "basics") {
  const texts: string[] = [];
  const start = JSON.stringify(initial, null, 2);
  function Host() {
    const [text, setText] = useState(start);
    const onEdit = (next: string) => {
      texts.push(next);
      setText(next);
    };
    const raw = JSON.parse(text);
    return createElement(
      ConfirmProvider,
      null,
      form === "basics" ? createElement(BasicsForm, { text, raw, onEdit, stateKey: "p" }) : createElement(PipelineForm, { text, raw, onEdit, stages: null, onRefresh: () => {} }),
    );
  }
  m = await mount(createElement(Host));
  return { root: m.root, texts, last: () => JSON.parse(texts.at(-1) ?? start) };
}

const setInput = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const blur = (el: HTMLElement) =>
  act(async () => {
    el.focus();
    el.blur();
  });

const card = (root: Element, name: string) => root.querySelector<HTMLElement>(`[data-harness-card="${name}"]`);
const nameInput = (root: Element, name: string) => card(root, name)!.querySelector<HTMLInputElement>("[data-harness-name]")!;

const withHarnesses = {
  name: "p",
  tracker: {
    type: "github",
    pipeline: [
      { id: "code", sourceLabel: "agent:code", harness: ["qwen", "opus"], routing: "round-robin" },
      { id: "review", sourceLabel: "agent:review", harness: "qwen" },
      { id: "triage", sourceLabel: "agent:triage" },
    ],
  },
  harnesses: { qwen: { model: "qwen3-coder", maxConcurrent: 1 }, opus: { model: "claude-opus-5-5" } },
};

describe("HarnessesField (Basics → Advanced)", () => {
  it("+ Add harness appends a harness-N card; its fields edit that harness", async () => {
    const { root, last } = await live({ name: "p" });
    expect(root.querySelectorAll("[data-harness-card]")).toHaveLength(0);
    await click(root.querySelector<HTMLButtonElement>("[data-add-harness]")!);
    expect(last().harnesses).toEqual({ "harness-1": {} });
    expect(card(root, "harness-1")).not.toBeNull();
    const cap = root.querySelector<HTMLInputElement>('[name="harnesses.harness-1.maxConcurrent"]')!;
    await setInput(cap, "2");
    expect(last().harnesses["harness-1"]).toEqual({ maxConcurrent: 2 });
    const bin = root.querySelector<HTMLInputElement>('[name="harnesses.harness-1.bin"]')!;
    await setInput(bin, "claude-local");
    expect(last().harnesses["harness-1"].bin).toBe("claude-local");
  });

  it("renaming a harness (on blur) rewrites every step's reference to it", async () => {
    const { root, last, texts } = await live(withHarnesses);
    await setInput(nameInput(root, "qwen"), "local");
    expect(texts).toHaveLength(0); // a draft until blur
    await blur(nameInput(root, "qwen"));
    const raw = last();
    expect(Object.keys(raw.harnesses)).toEqual(["local", "opus"]);
    expect(raw.harnesses.local).toEqual({ model: "qwen3-coder", maxConcurrent: 1 });
    expect(raw.tracker.pipeline[0].harness).toEqual(["local", "opus"]);
    expect(raw.tracker.pipeline[1].harness).toBe("local");
    expect(card(root, "local")).not.toBeNull();
  });

  it("a taken or blank name shows why and edits nothing", async () => {
    const { root, texts } = await live(withHarnesses);
    await setInput(nameInput(root, "qwen"), "opus");
    expect(card(root, "qwen")!.textContent).toContain('Another harness is already named "opus".');
    await blur(nameInput(root, "qwen"));
    await setInput(nameInput(root, "qwen"), " ");
    expect(card(root, "qwen")!.textContent).toContain("A harness needs a name.");
    await blur(nameInput(root, "qwen"));
    expect(texts).toHaveLength(0);
  });

  it("removing a harness (after the confirm) drops it from every step; a step left with none loses harness and routing", async () => {
    const { root, last } = await live(withHarnesses);
    await click(card(root, "qwen")!.querySelector<HTMLButtonElement>('[aria-label="remove harness"]')!);
    await answerConfirm(true);
    const raw = last();
    expect(raw.harnesses).toEqual({ opus: { model: "claude-opus-5-5" } });
    expect(raw.tracker.pipeline[0]).toMatchObject({ harness: ["opus"], routing: "round-robin" });
    expect(raw.tracker.pipeline[1]).toEqual({ id: "review", sourceLabel: "agent:review" });
    expect(card(root, "qwen")).toBeNull();
  });

  it("Cancel on the remove confirm edits nothing", async () => {
    const { root, texts } = await live(withHarnesses);
    await click(card(root, "opus")!.querySelector<HTMLButtonElement>('[aria-label="remove harness"]')!);
    await answerConfirm(false);
    expect(texts).toHaveLength(0);
  });

  it("env rows commit on blur to that harness's env", async () => {
    const { root, last } = await live(withHarnesses);
    const env = card(root, "qwen")!.querySelector<HTMLElement>("[data-harness-env]")!;
    await click([...env.querySelectorAll("button")].find((b) => b.textContent === "add variable")!);
    const [k, v] = [...env.querySelectorAll<HTMLInputElement>("input")];
    await setInput(k, "ANTHROPIC_BASE_URL");
    await setInput(v, "http://localhost:11434");
    await blur(v);
    expect(last().harnesses.qwen.env).toEqual({ ANTHROPIC_BASE_URL: "http://localhost:11434" });
  });
});

describe("step harness pick (PipelineForm)", () => {
  const openCard = async (root: Element, id: string) => {
    const c = root.querySelector<HTMLElement>(`[data-step-card="${id}"]`)!;
    await click(c.querySelector('[aria-label="expand step"]')!);
    return c;
  };
  const option = (c: Element, name: string) => c.querySelector<HTMLInputElement>(`[data-harness-option="${name}"]`)!;

  it("is hidden on a profile without harnesses", async () => {
    const { root } = await live({ name: "p", tracker: { type: "github", pipeline: [{ id: "code", sourceLabel: "agent:code" }] } }, "pipeline");
    const c = await openCard(root, "code");
    expect(c.querySelector("[data-step-harness]")).toBeNull();
  });

  it("one pick writes a name, two write a list (and show routing), none removes harness and routing", async () => {
    const { root, last } = await live(withHarnesses, "pipeline");
    const c = await openCard(root, "triage");
    expect(c.querySelector('[name="tracker.pipeline.2.routing"]')).toBeNull();
    await click(option(c, "opus"));
    expect(last().tracker.pipeline[2].harness).toBe("opus");
    await click(option(c, "qwen"));
    expect(last().tracker.pipeline[2].harness).toEqual(["opus", "qwen"]);
    expect(c.querySelector('[name="tracker.pipeline.2.routing"]')).not.toBeNull();
    await click(option(c, "opus"));
    await click(option(c, "qwen"));
    expect(last().tracker.pipeline[2]).toEqual({ id: "triage", sourceLabel: "agent:triage" });
  });

  it("dropping to one harness drops routing (it needs a list)", async () => {
    const { root, last } = await live(withHarnesses, "pipeline");
    const c = await openCard(root, "code");
    expect(option(c, "qwen").checked && option(c, "opus").checked).toBe(true);
    await click(option(c, "qwen"));
    expect(last().tracker.pipeline[0].harness).toBe("opus");
    expect(last().tracker.pipeline[0]).not.toHaveProperty("routing");
  });
});
