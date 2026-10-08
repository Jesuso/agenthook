import { describe, it, expect } from "vitest";
import { formatUp, formatLastEvent } from "./format";

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
