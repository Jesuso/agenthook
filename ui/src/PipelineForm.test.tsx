// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { PipelineForm } from "./ConfigForms";
import { click, mount } from "./domHarness";
import type { Mounted } from "./domHarness";

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
