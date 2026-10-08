import { describe, it, expect } from "vitest";
import {
  affectsRuns,
  appendText,
  applyFrame,
  chunkRanges,
  emptyLog,
  formatOutcome,
  isAtBottom,
  lineAt,
  lineCount,
  liveIndicator,
  logStreamUrl,
  logText,
  outcomeTone,
  readWrap,
  runDurationMs,
  runsUrl,
  visibleRange,
  writeWrap,
} from "./logview";

const all = (b: ReturnType<typeof emptyLog>) => Array.from({ length: lineCount(b) }, (_, i) => lineAt(b, i));

describe("appendText", () => {
  it("carries a partial line across appends", () => {
    const b = emptyLog();
    appendText(b, "one\ntw");
    expect(b.lines).toEqual(["one"]);
    expect(b.partial).toBe("tw");
    expect(all(b)).toEqual(["one", "tw"]);
    appendText(b, "o\nthree\n");
    expect(b.lines).toEqual(["one", "two", "three"]);
    expect(b.partial).toBe("");
    expect(lineCount(b)).toBe(3);
  });

  it("keeps empty lines", () => {
    const b = appendText(emptyLog(), "a\n\nb\n");
    expect(b.lines).toEqual(["a", "", "b"]);
  });

  it("drops the oldest lines past the cap", () => {
    const b = appendText(emptyLog(), "1\n2\n3\n4\n5\n", 3);
    expect(b.lines).toEqual(["3", "4", "5"]);
    expect(b.dropped).toBe(2);
    appendText(b, "6\n", 3);
    expect(b.lines).toEqual(["4", "5", "6"]);
    expect(b.dropped).toBe(3);
  });
});

describe("applyFrame", () => {
  it("init replaces, append extends, reset clears", () => {
    const b = emptyLog();
    applyFrame(b, { type: "init", text: "a\nb", truncated: true, size: 100 });
    expect(all(b)).toEqual(["a", "b"]);
    expect(b.truncated).toBe(true);
    applyFrame(b, { type: "append", text: "c\nd\n" });
    expect(all(b)).toEqual(["a", "bc", "d"]);
    applyFrame(b, { type: "reset" });
    expect(all(b)).toEqual([]);
    expect(b.truncated).toBe(false);
    applyFrame(b, { type: "init", text: "x\n", truncated: false, size: 2 });
    expect(all(b)).toEqual(["x"]);
  });
});

describe("visibleRange", () => {
  it("renders only the viewport plus overscan", () => {
    expect(visibleRange(0, 100, 10, 1000, 5)).toEqual({ start: 0, end: 15 });
    expect(visibleRange(500, 100, 10, 1000, 5)).toEqual({ start: 45, end: 65 });
    expect(visibleRange(9990, 100, 10, 1000, 5)).toEqual({ start: 994, end: 1000 });
    expect(visibleRange(0, 100, 10, 3, 5)).toEqual({ start: 0, end: 3 });
  });
});

describe("isAtBottom", () => {
  it("is true within the slack of the bottom", () => {
    expect(isAtBottom(900, 100, 1000)).toBe(true);
    expect(isAtBottom(897, 100, 1000)).toBe(true);
    expect(isAtBottom(800, 100, 1000)).toBe(false);
    expect(isAtBottom(0, 100, 50)).toBe(true);
  });
});

describe("affectsRuns", () => {
  const ev = (event: string, ref = "7", profile = "p") => ({ type: "event" as const, profile, event: { event, ref } });
  it("matches run_start / run_end of the same ticket only", () => {
    expect(affectsRuns(ev("run_start"), "p", "7")).toBe(true);
    expect(affectsRuns(ev("run_end"), "p", "7")).toBe(true);
    expect(affectsRuns(ev("enqueued"), "p", "7")).toBe(false);
    expect(affectsRuns(ev("run_end", "8"), "p", "7")).toBe(false);
    expect(affectsRuns(ev("run_end", "7", "q"), "p", "7")).toBe(false);
    expect(affectsRuns({ type: "ticket_removed", profile: "p", ref: "7" }, "p", "7")).toBe(false);
  });
});

describe("urls + formatOutcome", () => {
  it("encodes query params", () => {
    expect(runsUrl("p", "PROJ/1 2")).toBe("/api/runs?profile=p&ref=PROJ%2F1+2");
    expect(logStreamUrl("p", "a&b.log")).toBe("/api/log/stream?profile=p&run=a%26b.log");
  });
  it("outcome, else running, else a dash", () => {
    expect(formatOutcome({ outcome: "advance", running: false })).toBe("advance");
    expect(formatOutcome({ outcome: null, running: true })).toBe("running");
    expect(formatOutcome({ outcome: null, running: false })).toBe("—");
  });
});

describe("outcomeTone", () => {
  it("maps outcomes onto the status colours", () => {
    expect(outcomeTone({ outcome: null, running: true })).toBe("running");
    expect(outcomeTone({ outcome: "advance", running: false })).toBe("done");
    expect(outcomeTone({ outcome: "fail", running: false })).toBe("failed");
    expect(outcomeTone({ outcome: "hold", running: false })).toBe("held");
    expect(outcomeTone({ outcome: "changes", running: false })).toBe("held");
    expect(outcomeTone({ outcome: "something-new", running: false })).toBe("idle");
    expect(outcomeTone({ outcome: null, running: false })).toBe("idle");
  });
});

describe("runDurationMs", () => {
  const startedAt = "2026-10-08T10:00:00.000Z";
  const now = Date.parse("2026-10-08T10:05:00.000Z");
  it("ended: endedAt − startedAt", () => {
    expect(runDurationMs({ startedAt, endedAt: "2026-10-08T10:03:12.000Z", running: false }, now)).toBe(192_000);
  });
  it("running: now − startedAt", () => {
    expect(runDurationMs({ startedAt, endedAt: null, running: true }, now)).toBe(300_000);
  });
  it("null when neither ended nor running, or unparseable", () => {
    expect(runDurationMs({ startedAt, endedAt: null, running: false }, now)).toBeNull();
    expect(runDurationMs({ startedAt: "bad", endedAt: null, running: true }, now)).toBeNull();
  });
});

describe("chunkRanges", () => {
  it("covers [0,total) in size-line chunks", () => {
    expect(chunkRanges(0, 3)).toEqual([]);
    expect(chunkRanges(7, 3)).toEqual([
      { key: 0, start: 0, end: 3 },
      { key: 3, start: 3, end: 6 },
      { key: 6, start: 6, end: 7 },
    ]);
  });
  it("aligns to absolute lines past dropped ones, so later keys stay put", () => {
    expect(chunkRanges(6, 3, 2)).toEqual([
      { key: 0, start: 0, end: 1 },
      { key: 3, start: 1, end: 4 },
      { key: 6, start: 4, end: 6 },
    ]);
  });
});

describe("logText", () => {
  it("joins complete lines and the partial", () => {
    const b = emptyLog();
    appendText(b, "one\ntwo\nthr");
    expect(logText(b)).toBe("one\ntwo\nthr");
    appendText(b, "ee\n");
    expect(logText(b)).toBe("one\ntwo\nthree\n");
    expect(logText(emptyLog())).toBe("");
  });
});

describe("liveIndicator", () => {
  it("pulses only while open on a running run", () => {
    expect(liveIndicator("live", true, true)).toEqual({ label: "live", tone: "running", pulse: true });
    expect(liveIndicator("live", false, true)).toEqual({ label: "ended", tone: "idle", pulse: false });
    expect(liveIndicator("connecting", true, false)).toEqual({ label: "connecting…", tone: "held", pulse: false });
    expect(liveIndicator("connecting", true, true)).toEqual({ label: "reconnecting…", tone: "held", pulse: false });
    expect(liveIndicator("closed", true, true)).toEqual({ label: "disconnected", tone: "failed", pulse: false });
  });
});

describe("readWrap / writeWrap", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it("defaults on and round-trips", () => {
    const s = mem();
    expect(readWrap(s)).toBe(true);
    writeWrap(false, s);
    expect(readWrap(s)).toBe(false);
    writeWrap(true, s);
    expect(readWrap(s)).toBe(true);
  });
  it("survives a throwing or absent storage", () => {
    const bad = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readWrap(bad)).toBe(true);
    expect(() => writeWrap(false, bad)).not.toThrow();
    expect(readWrap(undefined)).toBe(true);
  });
});
