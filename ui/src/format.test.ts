import { describe, it, expect } from "vitest";
import { formatUp, formatLastEvent, formatRelative, formatCost, profileLabel, profileBadge, formatDate } from "./format";

describe("formatUp", () => {
  it("shows the pid when up", () => {
    expect(formatUp({ up: true, pid: 1234 })).toBe("up (pid 1234)");
  });
  it("shows down otherwise", () => {
    expect(formatUp({ up: false, pid: null })).toBe("down");
  });
});

describe("profileLabel", () => {
  it("shows the bare name when the label is the state key", () => {
    expect(profileLabel({ name: "dogfood", label: "dogfood" })).toBe("dogfood");
  });
  it("shows label (state key) when they differ", () => {
    expect(profileLabel({ name: "Old", label: "New" })).toBe("New (Old)");
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

describe("profileBadge", () => {
  const base = { name: "k", label: "K", ghost: false, configMissing: false, configPath: "~/p/agenthook.config.json", createdAt: "2026-04-05T12:00:00.000Z" };
  it("is null for a normal profile", () => {
    expect(profileBadge(base)).toBeNull();
  });
  it("marks a ghost as never ran, naming the config and its created date", () => {
    const b = profileBadge({ ...base, ghost: true, configPath: null });
    expect(b?.kind).toBe("ghost");
    expect(b?.text).toBe("never ran");
    expect(b?.title).toBe("created 2026-04-05 by a command that read a config named K; safe to remove");
  });
  it("warns on a missing config", () => {
    const b = profileBadge({ ...base, configMissing: true });
    expect(b).toEqual({ kind: "missing", text: "config missing", title: "~/p/agenthook.config.json no longer exists" });
  });
  it("prefers ghost over config missing", () => {
    expect(profileBadge({ ...base, ghost: true, configMissing: true })?.kind).toBe("ghost");
  });
});

describe("formatDate", () => {
  it("renders the date part, ? for null/invalid", () => {
    expect(formatDate("2026-04-05T12:00:00.000Z")).toBe("2026-04-05");
    expect(formatDate(null)).toBe("?");
    expect(formatDate("nope")).toBe("?");
  });
});
