import { describe, it, expect } from "vitest";
import type { InstructionFileView } from "./contract";
import { composePrompt, pickerSteps, promptPreviewUrl, repoFiles, runStartedAt, stepFileFor, stepIds } from "./promptPreview";

function file(path: string, scope: InstructionFileView["scope"], ids: string[]): InstructionFileView {
  return { path, scope, ids, hash: "h", bytes: 1, mtime: null, exists: true, agentsRunning: 0 };
}

describe("composePrompt", () => {
  it("joins repo then step with a blank line", () => {
    expect(composePrompt({ repo: "repo rules", step: "step rules", ticket: null })).toBe("repo rules\n\nstep rules");
  });

  it("drops empty/whitespace-only parts", () => {
    expect(composePrompt({ repo: "", step: "step rules", ticket: null })).toBe("step rules");
    expect(composePrompt({ repo: "repo rules", step: "   ", ticket: null })).toBe("repo rules");
    expect(composePrompt({ repo: "  ", step: "", ticket: null })).toBe("");
  });

  it("trims each part", () => {
    expect(composePrompt({ repo: "  repo  ", step: "  step  ", ticket: null })).toBe("repo\n\nstep");
  });

  it("omits the marker when standing is empty, even with a ticket", () => {
    expect(composePrompt({ repo: "", step: "", ticket: "the ticket" })).toBe("the ticket");
  });

  it("appends the ticket behind the marker when standing is non-empty", () => {
    expect(composePrompt({ repo: "repo", step: "", ticket: "ticket body" })).toBe("repo\n\n=== TICKET ===\n\nticket body");
  });

  it("ticket:null means standing only, no marker", () => {
    expect(composePrompt({ repo: "repo", step: "step", ticket: null })).toBe("repo\n\nstep");
  });
});

describe("promptPreviewUrl", () => {
  it("url-encodes profile and step", () => {
    expect(promptPreviewUrl("my profile", "code review")).toBe("/api/prompt-preview?profile=my+profile&step=code+review");
  });
});

describe("runStartedAt", () => {
  it("parses a real run basename", () => {
    expect(runStartedAt("2026-10-08T15-31-28-123Z-step-code-42.log")).toBe("2026-10-08T15:31:28.123Z");
  });

  it("returns null on garbage", () => {
    expect(runStartedAt("not-a-run-log")).toBeNull();
    expect(runStartedAt("")).toBeNull();
  });
});

describe("stepFileFor", () => {
  const files = [
    file("/d.md", "default", ["triage", "review"]),
    file("/s/code.md", "step", ["code"]),
    file("/r/repo.md", "repo", ["web"]),
  ];

  it("prefers a step-scoped file over default", () => {
    expect(stepFileFor(files, "code")?.path).toBe("/s/code.md");
  });

  it("falls back to the default file", () => {
    expect(stepFileFor(files, "review")?.path).toBe("/d.md");
  });

  it("returns null when no file covers the step", () => {
    expect(stepFileFor(files, "unknown")).toBeNull();
  });
});

describe("repoFiles", () => {
  it("returns only repo-scoped files", () => {
    const files = [file("/d.md", "default", ["a"]), file("/r1.md", "repo", ["x"]), file("/r2.md", "repo", ["y"])];
    expect(repoFiles(files).map((f) => f.path)).toEqual(["/r1.md", "/r2.md"]);
  });
});

describe("stepIds", () => {
  it("collects ids from step/default files, not repo", () => {
    const files = [file("/d.md", "default", ["triage"]), file("/s.md", "step", ["code", "review"]), file("/r.md", "repo", ["web"])];
    expect(stepIds(files)).toEqual(["code", "review", "triage"]);
  });

  it("dedupes and sorts", () => {
    const files = [file("/a.md", "step", ["b", "a"]), file("/b.md", "default", ["a"])];
    expect(stepIds(files)).toEqual(["a", "b"]);
  });
});

describe("pickerSteps", () => {
  const files = [
    file("/d.md", "default", ["triage"]),
    file("/s/code.md", "step", ["code"]),
    file("/s/review.md", "step", ["review"]),
    file("/r/repo.md", "repo", ["web"]),
  ];

  it("step-scoped open file: only its own ids", () => {
    expect(pickerSteps(files, files[1])).toEqual(["code"]);
  });

  it("default-scoped open file: only its own ids", () => {
    expect(pickerSteps(files, files[0])).toEqual(["triage"]);
  });

  it("repo-scoped open file: every step id in the profile", () => {
    expect(pickerSteps(files, files[3])).toEqual(["code", "review", "triage"]);
  });
});
