// @vitest-environment happy-dom
import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineForm } from "./ConfigForms";
import { click, mount } from "./domHarness";
import type { Mounted } from "./domHarness";

/** Set a `<select>`'s value and fire the native `change` React listens for. */
const setSelect = (el: HTMLSelectElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

const raw = {
  tracker: {
    type: "github",
    pipeline: [
      { id: "triage", kind: "triage", sourceLabel: "agent:triage", successLabel: "agent:code" },
      { id: "code", kind: "implement", sourceLabel: "agent:code", successLabel: "agent:review", failureLabel: "agent:failed", createsWorktree: true },
      { id: "review", kind: "review", sourceLabel: "agent:review", successLabel: "agent:done" },
    ],
  },
};
const text = JSON.stringify(raw, null, 2);

type Props = Parameters<typeof PipelineForm>[0];
const form = (over: Partial<Props> = {}) => createElement(PipelineForm, { text, raw, stages: null, onRefresh: () => {}, onEdit: () => {}, ...over });
const cards = (m: Mounted) => [...m.root.querySelectorAll<HTMLElement>("[data-step-card]")];
const openIds = (m: Mounted) => cards(m).filter((c) => c.dataset.open === "true").map((c) => c.dataset.stepCard);

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
});

describe("PipelineForm cards", () => {
  it("starts with every card collapsed, each header showing its summary", async () => {
    m = await mount(form());
    expect(cards(m)).toHaveLength(3);
    expect(openIds(m)).toEqual([]);
    expect(m.root.querySelector('input[name="tracker.pipeline.0.id"]')).toBeNull();
    const summaries = [...m.root.querySelectorAll("[data-step-summary]")].map((e) => e.textContent);
    expect(summaries).toEqual(["triage · agent:triage → agent:code", "implement · agent:code → agent:review / agent:failed · worktree", "review · agent:review → agent:done"]);
  });

  it("the toggle opens and closes one card; the header keeps its summary when open", async () => {
    m = await mount(form());
    await click(cards(m)[1].querySelector('[aria-label="expand step"]')!);
    expect(openIds(m)).toEqual(["code"]);
    expect(m.root.querySelector('input[name="tracker.pipeline.1.id"]')).not.toBeNull();
    expect(cards(m)[1].querySelector("[data-step-summary]")!.textContent).toContain("agent:code → agent:review");
    await click(cards(m)[1].querySelector('[aria-label="collapse step"]')!);
    expect(openIds(m)).toEqual([]);
  });

  it("Expand all / Collapse all, without editing the buffer", async () => {
    const onEdit = vi.fn();
    m = await mount(form({ onEdit }));
    await click(m.root.querySelector("[data-expand-all]")!);
    expect(openIds(m)).toEqual(["triage", "code", "review"]);
    await click(m.root.querySelector("[data-collapse-all]")!);
    expect(openIds(m)).toEqual([]);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("+ Add step opens the new card", async () => {
    let buffer = text;
    const onEdit = vi.fn((t: string) => (buffer = t));
    m = await mount(form({ onEdit }));
    const add = [...m.root.querySelectorAll("button")].find((b) => b.textContent === "+ Add step")!;
    await click(add);
    expect(onEdit).toHaveBeenCalledTimes(1);
    await m.rerender(form({ text: buffer, raw: JSON.parse(buffer), onEdit }));
    expect(openIds(m)).toEqual(["step-4"]);
  });

  it("an error badges its card and opens it once; collapsing it again keeps the badge", async () => {
    m = await mount(form());
    expect(m.root.querySelector("[data-step-error]")).toBeNull();
    const errors = new Map([[2, ['config: pipeline step "review" maxAttempts must be a positive integer.']]]);
    await m.rerender(form({ errors }));
    const badge = cards(m)[2].querySelector<HTMLElement>("[data-step-error]");
    expect(badge?.dataset.stepError).toBe("1");
    expect(openIds(m)).toEqual(["review"]);
    await click(cards(m)[2].querySelector('[aria-label="collapse step"]')!);
    await m.rerender(form({ errors: new Map(errors) }));
    expect(openIds(m)).toEqual([]);
    expect(cards(m)[2].querySelector("[data-step-error]")).not.toBeNull();
  });

  it("Advanced is collapsed by default, holds maxMinutes/idleMinutes/maxConcurrent/hold/queue, and closeIssue shows only for github", async () => {
    m = await mount(form());
    await click(cards(m)[1].querySelector('[aria-label="expand step"]')!);
    const card = cards(m)[1];
    const details = card.querySelector("[data-step-advanced]") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Advanced · 0 set");
    expect(details.querySelector('input[name="tracker.pipeline.1.maxMinutes"]')).not.toBeNull();
    expect(details.querySelector('input[name="tracker.pipeline.1.idleMinutes"]')).not.toBeNull();
    expect(details.querySelector('input[name="tracker.pipeline.1.maxConcurrent"]')).not.toBeNull();
    expect(details.querySelector('input[name="tracker.pipeline.1.holdLabel"]')).not.toBeNull();
    expect(details.querySelector('input[name="tracker.pipeline.1.queueLabel"]')).not.toBeNull();
    expect(details.querySelector('input[name="tracker.pipeline.1.closeIssue"]')).not.toBeNull();
    expect(details.querySelector('input[name="tracker.pipeline.1.completeTask"]')).toBeNull();
  });

  it("shows N set in the Advanced summary and in the collapsed card header once a value is set", async () => {
    const withHold = {
      tracker: { type: "github", pipeline: [{ ...raw.tracker.pipeline[1], holdLabel: "agent:held" }] },
    };
    m = await mount(form({ text: JSON.stringify(withHold, null, 2), raw: withHold }));
    expect(cards(m)[0].querySelector("[data-step-summary]")!.textContent).toContain("+1 advanced");
    await click(cards(m)[0].querySelector('[aria-label="expand step"]')!);
    expect(cards(m)[0].querySelector("[data-step-advanced] summary")!.textContent).toBe("Advanced · 1 set");
  });

  it("completeOnMerge shows only on manual steps, unless already set", async () => {
    m = await mount(form());
    await click(cards(m)[1].querySelector('[aria-label="expand step"]')!);
    expect(cards(m)[1].querySelector('input[name="tracker.pipeline.1.completeOnMerge"]')).toBeNull();

    const manual = { tracker: { type: "github", pipeline: [{ ...raw.tracker.pipeline[1], manual: true }] } };
    {
      const m2 = await mount(form({ text: JSON.stringify(manual, null, 2), raw: manual }));
      await click(m2.root.querySelector('[aria-label="expand step"]')!);
      expect(m2.root.querySelector('input[name="tracker.pipeline.0.completeOnMerge"]')).not.toBeNull();
      await m2.unmount();
    }

    const alreadySet = { tracker: { type: "github", pipeline: [{ ...raw.tracker.pipeline[1], completeOnMerge: false }] } };
    const m3 = await mount(form({ text: JSON.stringify(alreadySet, null, 2), raw: alreadySet }));
    await click(m3.root.querySelector('[aria-label="expand step"]')!);
    expect(m3.root.querySelector('input[name="tracker.pipeline.0.completeOnMerge"]')).not.toBeNull();
    await m3.unmount();
  });

  it("focus opens the named card and scrolls it into view", async () => {
    const scroll = vi.fn();
    (Element.prototype as any).scrollIntoView = scroll;
    m = await mount(form());
    await m.rerender(form({ focus: { id: "code", nonce: 1 } }));
    expect(openIds(m)).toEqual(["code"]);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(cards(m)[1]);
  });
});

describe("PipelineForm Advanced: Escalation and Lite", () => {
  it("renders an Escalation row per difficulty and a Lite editor, and a select change edits the buffer", async () => {
    let buffer = text;
    const onEdit = vi.fn((t: string) => (buffer = t));
    m = await mount(form({ onEdit }));
    await click(cards(m)[1].querySelector('[aria-label="expand step"]')!);
    const details = cards(m)[1].querySelector("[data-step-advanced]") as HTMLDetailsElement;

    const rows = ["easy", "medium", "hard"].map((d) => details.querySelector<HTMLElement>(`[data-escalate-row="${d}"]`));
    expect(rows.every(Boolean)).toBe(true);
    const easyModel = rows[0]!.querySelector<HTMLSelectElement>('select[name="tracker.pipeline.1.escalate.easy.model"]')!;
    const easyEffort = rows[0]!.querySelector<HTMLSelectElement>('select[name="tracker.pipeline.1.escalate.easy.effort"]')!;
    expect(easyModel).not.toBeNull();
    expect(easyEffort).not.toBeNull();

    expect(details.querySelector('[data-lite-headings]')).not.toBeNull();
    const liteModel = details.querySelector<HTMLSelectElement>('select[name="tracker.pipeline.1.lite.model"]')!;
    const liteEffort = details.querySelector<HTMLSelectElement>('select[name="tracker.pipeline.1.lite.effort"]')!;
    expect(liteModel).not.toBeNull();
    expect(liteEffort).not.toBeNull();

    await setSelect(easyEffort, "high");
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(buffer).tracker.pipeline[1].escalate).toEqual({ easy: { effort: "high" } });

    await setSelect(liteEffort, "low");
    expect(JSON.parse(buffer).tracker.pipeline[1].lite).toEqual({ effort: "low" });
  });

  it("adding a heading edits the buffer and clears the draft", async () => {
    let buffer = text;
    const onEdit = vi.fn((t: string) => (buffer = t));
    m = await mount(form({ onEdit }));
    await click(cards(m)[1].querySelector('[aria-label="expand step"]')!);
    const headings = cards(m)[1].querySelector('[data-lite-headings]')!;
    const input = headings.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "## Problem");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const add = [...headings.querySelectorAll("button")].find((b) => b.textContent === "add heading")!;
    expect(add.hasAttribute("disabled")).toBe(false);
    await click(add);
    expect(JSON.parse(buffer).tracker.pipeline[1].lite).toEqual({ descriptionHeadings: ["## Problem"] });
    expect(input.value).toBe("");
  });

  it("editing an existing heading only commits on blur, keeps trailing spaces, and a mid-edit blank row doesn't drop descriptionHeadings", async () => {
    const rawWithLite = { ...raw, tracker: { ...raw.tracker, pipeline: raw.tracker.pipeline.map((s, idx) => (idx === 1 ? { ...s, lite: { descriptionHeadings: ["Problem"] } } : s)) } };
    let buffer = JSON.stringify(rawWithLite, null, 2);
    const onEdit = vi.fn((t: string) => (buffer = t));
    m = await mount(form({ text: buffer, raw: rawWithLite, onEdit }));
    await click(cards(m)[1].querySelector('[aria-label="expand step"]')!);
    const headings = cards(m)[1].querySelector('[data-lite-headings]')!;
    const row = headings.querySelectorAll("input")[0] as HTMLInputElement;

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(row, "");
      row.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onEdit).not.toHaveBeenCalled();

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(row, "Problem statement ");
      row.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onEdit).not.toHaveBeenCalled();

    row.focus();
    await act(async () => {
      row.blur();
    });
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(buffer).tracker.pipeline[1].lite.descriptionHeadings).toEqual(["Problem statement "]);
  });
});
