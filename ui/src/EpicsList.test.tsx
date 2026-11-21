// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EpicsList } from "./EpicsView";
import { epicStats } from "./epicsFixtures";
import type { EpicsResponse } from "./contract";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const list = (over: Partial<EpicsResponse>) =>
  html(createElement(EpicsList, { body: { at: "t", live: true, supported: true, epics: [], ...over }, profile: "dev" }));

/** The <li> markup of the row for `ref`. */
const row = (out: string, ref: string) => {
  const at = out.indexOf(`data-epic-row="${ref}"`);
  return out.slice(out.lastIndexOf("<li", at), out.indexOf("</li>", at) + "</li>".length);
};

describe("EpicsList rows with no tickets", () => {
  it("an open epic with 0 tickets shows the muted 'no tickets' text, no bar and no 0/0", () => {
    const out = list({ epics: [epicStats({ ref: "E0", status: "Idea" }), epicStats({ ref: "E1", byStage: { backlog: 2 } })] });
    const r = row(out, "E0");
    expect(r).not.toContain("data-stage-bar");
    expect(r).not.toContain("data-progress");
    expect(r).not.toContain("0/0");
    expect(r).toContain("data-no-tickets");
    expect(r).toContain("text-muted");
    expect(r).toContain(">no tickets<");
    // A 0-ticket row is not a closed row.
    expect(r).not.toContain("data-closed-count");
    // The tracker status stays by the name.
    expect(r).toContain("data-tracker-status");
    // The link points only at elements the row actually renders.
    const ids = (r.match(/aria-describedby="([^"]*)"/)?.[1] ?? "").split(" ").filter(Boolean);
    expect(ids.some((id) => id.endsWith("-count"))).toBe(true);
    expect(ids.every((id) => id.endsWith("-bar") === false)).toBe(true);
    for (const id of ids) expect(out).toContain(`id="${id}"`);
  });

  it("an open epic with tickets still renders the bar with N/M", () => {
    const out = list({ epics: [epicStats({ ref: "E1", byStage: { done: 3, backlog: 2 } })] });
    const r = row(out, "E1");
    expect(r).toContain("data-stage-bar");
    expect(r).toMatch(/data-progress="true"><span class="font-mono">3\/5<\/span>/);
    expect(r).not.toContain("data-no-tickets");
    expect(r).not.toContain("data-closed-count");
  });

  it("closed epics are unchanged: 0 tickets says 'no tickets', tickets say N/M done", () => {
    const out = list({ epics: [epicStats({ ref: "E0", completed: true }), epicStats({ ref: "E1", completed: true, byStage: { done: 4, backlog: 2 } })] });
    const empty = row(out, "E0");
    expect(empty).toContain("data-closed-count");
    expect(empty).toContain("data-no-tickets");
    // The closed row's class list is unchanged — no stray "undefined" token.
    expect(empty).not.toContain("undefined");
    expect(empty).toContain(">no tickets<");
    expect(empty).not.toContain("data-stage-bar");
    const done = row(out, "E1");
    expect(done).toContain("data-closed-count");
    expect(done).not.toContain("data-no-tickets");
    expect(done).toMatch(/<span class="font-mono">4\/6<\/span> done/);
    expect(done).not.toContain("data-stage-bar");
  });

  it("an open empty row keeps the note slot and takes the bar slot's width when a note column exists", () => {
    const out = list({ epics: [epicStats({ ref: "E0" }), epicStats({ ref: "E1", readyToClose: true, byStage: { done: 2 } })] });
    const r = row(out, "E0");
    expect(r).toContain("w-66");
    expect(r).toContain("data-eta");
    expect(row(out, "E1")).not.toContain("w-66");
  });
});
