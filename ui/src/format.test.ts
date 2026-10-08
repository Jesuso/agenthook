import { describe, it, expect } from "vitest";
import { formatUp, formatLastEvent, formatRelative, formatCost } from "./format";

describe("formatUp", () => {
  it("shows the pid when up", () => {
    expect(formatUp({ up: true, pid: 1234 })).toBe("up (pid 1234)");
  });
  it("shows down otherwise", () => {
    expect(formatUp({ up: false, pid: null })).toBe("down");
  });
});

describe("formatLastEvent", () => {
  it("renders null as an em dash", () => {
    expect(formatLastEvent(null)).toBe("—");
  });
  it("renders kind/ref/step", () => {
    expect(formatLastEvent({ at: null, kind: "run_start", ref: "42", step: "code" })).toBe("run_start 42/code");
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");

  it("renders null/invalid as an em dash", () => {
    expect(formatRelative(null, now)).toBe("—");
    expect(formatRelative("not-a-date", now)).toBe("—");
  });

  it("renders minutes/hours/days ago", () => {
    expect(formatRelative(new Date(now - 5 * 60000).toISOString(), now)).toBe("5m ago");
    expect(formatRelative(new Date(now - 3 * 3600000).toISOString(), now)).toBe("3h ago");
    expect(formatRelative(new Date(now - 2 * 86400000).toISOString(), now)).toBe("2d ago");
  });
});

describe("formatCost", () => {
  it("renders zero as an em dash", () => {
    expect(formatCost(0)).toBe("—");
  });
  it("renders a dollar amount", () => {
    expect(formatCost(0.567)).toBe("$0.57");
  });
});
