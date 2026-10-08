import { describe, it, expect } from "vitest";
import type { InstructionFileView } from "./contract";
import { baseName, externalChange, formatBytes, groupFiles, initialFile, instructionFileUrl, instructionsUrl, isDirty } from "./instructions";
import type { InstructionsEvent, OpenFile } from "./instructions";

function file(path: string, scope: InstructionFileView["scope"], ids: string[], exists = true): InstructionFileView {
  return { path, scope, ids, hash: exists ? "h" : null, bytes: 1, mtime: null, exists, agentsRunning: 0 };
}

const open: OpenFile = { profile: "p", path: "/a/code.md", content: "hello", baseHash: "h1" };
const ev = (over: Partial<InstructionsEvent>): InstructionsEvent => ({ type: "instructions", profile: "p", path: "/a/code.md", hash: "h2", source: "disk", ...over });

describe("groupFiles", () => {
  it("orders step → default → repo, keeping the server's order within each group", () => {
    const groups = groupFiles([
      file("/r/b.md", "repo", ["web"]),
      file("/s/z.md", "step", ["review"]),
      file("/d.md", "default", ["triage", "code"]),
      file("/s/y.md", "step", ["code"]),
      file("/s/x.md", "step", ["code"]),
    ]);
    expect(groups.map((g) => g.scope)).toEqual(["step", "default", "repo"]);
    // server order preserved, not re-sorted alphabetically (which would read x, y, z anyway here —
    // use an out-of-alpha-order input to actually pin this down):
    expect(groups[0].files.map((f) => f.path)).toEqual(["/s/z.md", "/s/y.md", "/s/x.md"]);
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

describe("initialFile", () => {
  const files = [file("/s/code.md", "step", ["code"]), file("/d.md", "default", ["triage"]), file("/r.md", "repo", ["web"])];

  it("picks the remembered path when it still exists", () => {
    expect(initialFile(files, "/d.md")).toBe("/d.md");
  });

  it("falls back to the first existing file (groupFiles order) when remembered is missing or gone", () => {
    expect(initialFile(files, "/nope.md")).toBe("/s/code.md");
    expect(initialFile([file("/s/code.md", "step", ["code"], false), ...files.slice(1)], "/s/code.md")).toBe("/d.md");
  });

  it("returns null when nothing exists", () => {
    expect(initialFile(files.map((f) => ({ ...f, exists: false })), null)).toBeNull();
    expect(initialFile([], null)).toBeNull();
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
