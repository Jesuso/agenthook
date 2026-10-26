// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { AnswerOptions } from "./AnswerOptions";
import { click, mount } from "./domHarness";
import type { Mounted } from "./domHarness";

let m: Mounted | null = null;
afterEach(async () => {
  await m?.unmount();
  m = null;
});

describe("AnswerOptions", () => {
  it("renders one button per option; clicking one shows a confirm with the exact text, not a send", async () => {
    const sent: string[] = [];
    m = await mount(createElement(AnswerOptions, { options: ["Postgres", "SQLite"], busy: false, onSend: (c) => sent.push(c) }));
    const buttons = () => [...m!.root.querySelectorAll("[data-answer-options] button")];
    expect(buttons().map((b) => b.textContent)).toEqual(["Postgres", "SQLite"]);
    await click(buttons()[0]);
    expect(sent).toEqual([]);
    expect(m.root.querySelector("[data-answer-confirm]")?.textContent).toContain("Postgres");
    expect(m.root.querySelector("[data-answer-options]")).toBeNull();
  });

  it("Confirm calls onSend with exactly the shown option", async () => {
    const sent: string[] = [];
    m = await mount(createElement(AnswerOptions, { options: ["Postgres", "SQLite"], busy: false, onSend: (c) => sent.push(c) }));
    await click(m.root.querySelector("[data-answer-options] button")!);
    await click(m.root.querySelector("[data-answer-confirm-send]")!);
    expect(sent).toEqual(["Postgres"]);
  });

  it("Cancel goes back to the option list without sending anything", async () => {
    const sent: string[] = [];
    m = await mount(createElement(AnswerOptions, { options: ["Postgres", "SQLite"], busy: false, onSend: (c) => sent.push(c) }));
    await click(m.root.querySelectorAll("[data-answer-options] button")[1]);
    expect(m.root.querySelector("[data-answer-confirm]")?.textContent).toContain("SQLite");
    const cancel = [...m.root.querySelectorAll("[data-answer-confirm] button")].find((b) => b.textContent === "Cancel")!;
    await click(cancel);
    expect(sent).toEqual([]);
    expect(m.root.querySelector("[data-answer-options]")).not.toBeNull();
    expect(m.root.querySelector("[data-answer-confirm]")).toBeNull();
  });

  it("disables every button while busy", async () => {
    m = await mount(createElement(AnswerOptions, { options: ["Postgres", "SQLite"], busy: true, onSend: () => {} }));
    for (const b of m.root.querySelectorAll("[data-answer-options] button")) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});
