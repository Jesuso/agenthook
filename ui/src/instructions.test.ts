import { describe, it, expect } from "vitest";
import type { InstructionFileView } from "./contract";
import { baseName, externalChange, formatBytes, groupFiles, instructionFileUrl, instructionsUrl, isDirty } from "./instructions";
import type { InstructionsEvent, OpenFile } from "./instructions";

function file(path: string, scope: InstructionFileView["scope"], ids: string[]): InstructionFileView {
  return { path, scope, ids, hash: "h", bytes: 1, mtime: null, exists: true, agentsRunning: 0 };
}

const open: OpenFile = { profile: "p", path: "/a/code.md", content: "hello", baseHash: "h1" };
const ev = (over: Partial<InstructionsEvent>): InstructionsEvent => ({ type: "instructions", profile: "p", path: "/a/code.md", hash: "h2", ...over });

describe("groupFiles", () => {
  it("orders default → step → repo, sorting by first id then path", () => {
    const groups = groupFiles([
      file("/r/b.md", "repo", ["web"]),
      file("/s/z.md", "step", ["review"]),
      file("/s/y.md", "step", ["code"]),
      file("/s/x.md", "step", ["code"]),
      file("/d.md", "default", ["triage", "code"]),
    ]);
    expect(groups.map((g) => g.scope)).toEqual(["default", "step", "repo"]);
    expect(groups[1].files.map((f) => f.path)).toEqual(["/s/x.md", "/s/y.md", "/s/z.md"]);
    expect(groups.every((g) => g.label)).toBe(true);
  });

  it("omits empty groups", () => {
    expect(groupFiles([file("/r.md", "repo", ["a"])]).map((g) => g.scope)).toEqual(["repo"]);
    expect(groupFiles([])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const files = [file("/b.md", "step", ["b"]), file("/a.md", "step", ["a"])];
    groupFiles(files);
    expect(files.map((f) => f.path)).toEqual(["/b.md", "/a.md"]);
  });
});

describe("isDirty", () => {
  it("compares the buffer to the loaded content", () => {
    expect(isDirty("hello", open)).toBe(false);
    expect(isDirty("hello!", open)).toBe(true);
  });

  it("is clean again after undoing back to the original", () => {
    let buffer = "hello";
    buffer += " world";
    expect(isDirty(buffer, open)).toBe(true);
    buffer = buffer.slice(0, -" world".length);
    expect(isDirty(buffer, open)).toBe(false);
  });
});

describe("externalChange", () => {
  it("reloads a clean buffer", () => {
    expect(externalChange(open, ev({}), "hello")).toBe("reload");
  });

  it("shows the banner for a dirty buffer", () => {
    expect(externalChange(open, ev({}), "edited")).toBe("banner");
  });

  it("ignores an event carrying the hash already loaded", () => {
    expect(externalChange(open, ev({ hash: "h1" }), "edited")).toBe("ignore");
  });

  it("always banners a deletion, clean or dirty", () => {
    expect(externalChange(open, ev({ hash: null }), "hello")).toBe("banner");
    expect(externalChange(open, ev({ hash: null }), "edited")).toBe("banner");
  });

  it("ignores another file, another profile, or no open file", () => {
    expect(externalChange(open, ev({ path: "/a/review.md" }), "edited")).toBe("ignore");
    expect(externalChange(open, ev({ profile: "q" }), "edited")).toBe("ignore");
    expect(externalChange(null, ev({}), "")).toBe("ignore");
  });
});

describe("urls", () => {
  it("encodes params", () => {
    expect(instructionsUrl("a b")).toBe("/api/instructions?profile=a+b");
    expect(instructionFileUrl("p", "/x/y z.md")).toBe("/api/instructions/file?profile=p&path=%2Fx%2Fy+z.md");
  });

  it("baseName takes the last segment", () => {
    expect(baseName("/a/b/c.md")).toBe("c.md");
    expect(baseName("c.md")).toBe("c.md");
  });

  it("formatBytes switches to KB at 1024", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });
});
