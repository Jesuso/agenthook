import { describe, it, expect } from "vitest";
import { failureSummary } from "./failure";

describe("failureSummary", () => {
  it("names each receiver failure class in plain words", () => {
    expect(failureSummary("interrupted by restart")).toBe("Interrupted when the receiver restarted");
    expect(failureSummary("non-zero exit (137)")).toBe("The agent exited with code 137");
    expect(failureSummary("timeout: exceeded maxMinutes=45")).toBe("Timed out after 45 min");
    expect(failureSummary("timeout: no output for idleMinutes=10")).toBe("Stopped after 10 min without output");
    expect(failureSummary("sandbox setup failed: no image agenthook-sandbox:1 — run doctor")).toBe("Sandbox setup failed: no image agenthook-sandbox:1");
  });

  it("drops the log lines after the cause", () => {
    const raw = 'sandbox (docker) could not start the run: service "bad" not ready within 5s (wait: false) — last log lines: 2026-10-24T18:00:00Z boot\nmore';
    expect(failureSummary(raw)).toBe('Sandbox could not start: service "bad" not ready within 5s (wait: false)');
  });

  it("falls back to the first line, capped; empty stays null", () => {
    expect(failureSummary("tests red\nstack…")).toBe("tests red");
    const long = failureSummary("x".repeat(200))!;
    expect(long.length).toBe(90);
    expect(long.endsWith("…")).toBe(true);
    expect(failureSummary(null)).toBeNull();
    expect(failureSummary("  ")).toBeNull();
  });
});
