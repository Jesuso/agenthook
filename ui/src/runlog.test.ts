import { describe, it, expect } from "vitest";
import type { RunView } from "./contract";
import { chronological, isBounce, stepOrder, storyBlocks, timeScale } from "./runlog";

const run = (step: string, startedAt: string, outcome: string | null): RunView => ({
  run: `${startedAt}-step-${step}-X.log`,
  step,
  startedAt,
  endedAt: null,
  outcome,
  costUsd: null,
  unpriced: false,
  estUsd: null,
  costBasis: null,
  running: false,
  bytes: 0,
});

describe("storyBlocks", () => {
  it("drops the receiver's header and makes each one-line message a beat", () => {
    const blocks = storyBlocks(["# CAHUI-263  docs: AGENTS.md", "I'll start by writing a test plan.", "Most references resolve.", "CI is fully green."]);
    expect(blocks).toEqual([
      { kind: "beat", text: "I'll start by writing a test plan." },
      { kind: "beat", text: "Most references resolve." },
      { kind: "beat", text: "CI is fully green." },
    ]);
  });

  it("keeps the report's lists, their lead-in lines and standalone paragraphs together as prose", () => {
    const blocks = storyBlocks([
      "# #539  sandbox",
      "Second round. Let me read the full diff.",
      "I reviewed PR #545 and wrote an **advance** verdict.",
      "",
      "**What it changes:** `reap()` now returns the containers.",
      "",
      "**First-review findings:**",
      "- **Duplicate runs:** a new test.",
      "- **Docs:** updated.",
      "",
      "**One minor note (not blocking):** no test checks the labels.",
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["beat", "beat", "prose"]);
    expect(blocks[2].text).toBe(
      "**What it changes:** `reap()` now returns the containers.\n\n**First-review findings:**\n- **Duplicate runs:** a new test.\n- **Docs:** updated.\n\n**One minor note (not blocking):** no test checks the labels.",
    );
  });

  it("treats a plan list inside a message as prose, then goes back to beats", () => {
    const blocks = storyBlocks(["Writing a plan first.", "My plan:", "", "1. Check every path.", "2. Check CI.", "", "Next I'll read AGENTS.md.", "Most references resolve."]);
    expect(blocks).toEqual([
      { kind: "beat", text: "Writing a plan first." },
      { kind: "prose", text: "My plan:\n\n1. Check every path.\n2. Check CI." },
      { kind: "beat", text: "Next I'll read AGENTS.md." },
      { kind: "beat", text: "Most references resolve." },
    ]);
  });

  it("pulls out [agenthook] notices", () => {
    expect(storyBlocks(["Done.", "[agenthook] egress denied: cafe.github.com:443 (2×)"])).toEqual([
      { kind: "beat", text: "Done." },
      { kind: "notice", text: "egress denied: cafe.github.com:443 (2×)" },
    ]);
  });

  it("ends a report paragraph at a trailing notice", () => {
    expect(storyBlocks(["Checked it.", "**Findings:**", "- one", "", "**One minor note:** not blocking.", "[agenthook] egress denied: x:443"])).toEqual([
      { kind: "beat", text: "Checked it." },
      { kind: "prose", text: "**Findings:**\n- one\n\n**One minor note:** not blocking." },
      { kind: "notice", text: "egress denied: x:443" },
    ]);
  });

  it("returns nothing for an empty log", () => {
    expect(storyBlocks([])).toEqual([]);
    expect(storyBlocks(["# #1  title"])).toEqual([]);
  });
});

describe("stepOrder", () => {
  it("orders steps by the advances between them, not by which ran first", () => {
    // CAHUI-263: entered at review, sent back to code, then code → review → qa.
    const runs = [
      run("review", "2026-10-25T17:28:30Z", "changes"),
      run("code", "2026-10-25T17:31:15Z", "advance"),
      run("review", "2026-10-25T17:32:02Z", "advance"),
      run("qa", "2026-10-25T17:33:29Z", "changes"),
      run("code", "2026-10-25T17:37:32Z", null),
    ];
    expect(stepOrder(runs)).toEqual(["code", "review", "qa"]);
    expect(stepOrder([...runs].reverse())).toEqual(["code", "review", "qa"]);
  });

  it("keeps first-seen order for steps no advance relates", () => {
    expect(stepOrder([run("triage", "2026-01-01T00:00:00Z", "hold"), run("code", "2026-01-01T00:05:00Z", null)])).toEqual(["triage", "code"]);
  });

  it("survives a cycle of advances", () => {
    const runs = [run("a", "2026-01-01T00:00:00Z", "advance"), run("b", "2026-01-01T00:01:00Z", "advance"), run("a", "2026-01-01T00:02:00Z", null)];
    expect(stepOrder(runs).sort()).toEqual(["a", "b"]);
  });
});

describe("chronological / isBounce", () => {
  it("sorts oldest first without mutating, and a bounce is a changes verdict", () => {
    const newestFirst = [run("qa", "2026-01-01T00:02:00Z", "changes"), run("code", "2026-01-01T00:00:00Z", "advance")];
    expect(chronological(newestFirst).map((r) => r.step)).toEqual(["code", "qa"]);
    expect(newestFirst[0].step).toBe("qa");
    expect(isBounce(newestFirst[0])).toBe(true);
    expect(isBounce(newestFirst[1])).toBe(false);
  });
});

describe("timeScale", () => {
  const M = 60_000;
  it("maps run time linearly when there are no long gaps", () => {
    const t = timeScale([{ start: 0, end: 4 * M }, { start: 5 * M, end: 10 * M }]);
    expect(t.x(0)).toBe(0);
    expect(t.x(5 * M)).toBe(50);
    expect(t.x(10 * M)).toBe(100);
    expect(t.breaks).toEqual([]);
    expect([t.t0, t.t1]).toEqual([0, 10 * M]);
  });

  it("squeezes an idle gap longer than the cap and reports it as a break", () => {
    const H = 60 * M;
    // 10 min of runs around a 5 h hold: the gap is capped at 12% of run time (1.2 min), not drawn 30× wider than the runs.
    const t = timeScale([{ start: 0, end: 5 * M }, { start: 5 * M + 5 * H, end: 10 * M + 5 * H }]);
    expect(t.breaks).toHaveLength(1);
    expect(t.breaks[0].ms).toBe(5 * H);
    expect(t.x(5 * M)).toBeCloseTo((5 / 11.2) * 100);
    expect(t.x(5 * M + 5 * H)).toBeCloseTo((6.2 / 11.2) * 100);
    expect(t.x(10 * M + 5 * H)).toBe(100);
  });

  it("handles overlapping and empty spans", () => {
    expect(timeScale([]).breaks).toEqual([]);
    const t = timeScale([{ start: 0, end: 10 * M }, { start: 2 * M, end: 4 * M }]);
    expect(t.x(10 * M)).toBe(100);
  });
});
