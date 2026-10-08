import { describe, it, expect } from "vitest";
import { formatUp, formatLastEvent, shortRef, ticketTitle, formatRelative, formatCost, profileLabel, profileBadge, formatDate, formatDuration } from "./format";

describe("formatUp", () => {
  it("reads up, with pid and port only in the tooltip", () => {
    expect(formatUp({ up: true, pid: 1234, port: 8787 })).toEqual({ text: "up", title: "pid 1234 · port 8787" });
    expect(formatUp({ up: true, pid: 1234, port: null })).toEqual({ text: "up", title: "pid 1234" });
  });
  it("reads down otherwise; a down profile's stale pid isn't shown", () => {
    expect(formatUp({ up: false, pid: null, port: null })).toEqual({ text: "down", title: undefined });
    expect(formatUp({ up: false, pid: 99, port: 8787 })).toEqual({ text: "down", title: "port 8787" });
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

describe("shortRef", () => {
  it("renders short refs as-is", () => {
    expect(shortRef("223")).toEqual({ text: "223" });
  });
  it("shortens long refs, keeping the full ref as the title", () => {
    expect(shortRef("1209876543210987")).toEqual({ text: "…210987", title: "1209876543210987" });
  });
});

describe("formatLastEvent", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const at = new Date(now - 2 * 60000).toISOString();

  it("renders null as an em dash", () => {
    expect(formatLastEvent(null, null, now)).toEqual({ text: "—" });
  });

  it("uses the displayId, verb-maps the kind, and drops the title when the ref isn't shortened", () => {
    expect(formatLastEvent({ at, kind: "pipeline", ref: "1209876543210987", step: "review" }, "ID-2872", now)).toEqual({
      text: "picked up ID-2872 · review · 2m ago",
    });
  });

  it("falls back to a shortened ref with the full ref as the title when there's no displayId", () => {
    expect(formatLastEvent({ at, kind: "pipeline", ref: "1209876543210987", step: "review" }, null, now)).toEqual({
      text: "picked up …210987 · review · 2m ago",
      title: "1209876543210987",
    });
  });

  it("treats a displayId equal to the ref as absent", () => {
    expect(formatLastEvent({ at, kind: "pipeline", ref: "1209876543210987", step: "review" }, "1209876543210987", now)).toEqual({
      text: "picked up …210987 · review · 2m ago",
      title: "1209876543210987",
    });
  });

  it("renders short refs as-is with no title", () => {
    expect(formatLastEvent({ at, kind: "pipeline", ref: "223", step: "code" }, null, now)).toEqual({
      text: "picked up 223 · code · 2m ago",
    });
  });

  it("maps merge and ci verbs, passes through unknown kinds, and drops a missing step", () => {
    expect(formatLastEvent({ at, kind: "merge", ref: "223", step: null }, null, now)).toEqual({ text: "merged 223 · 2m ago" });
    expect(formatLastEvent({ at, kind: "ci", ref: "223", step: "code" }, null, now)).toEqual({ text: "CI failed 223 · code · 2m ago" });
    expect(formatLastEvent({ at, kind: "weird", ref: "223", step: null }, null, now)).toEqual({ text: "weird 223 · 2m ago" });
  });

  it("uses ? for a missing ref", () => {
    expect(formatLastEvent({ at, kind: "pipeline", ref: null, step: "code" }, null, now)).toEqual({ text: "picked up ? · code · 2m ago" });
  });
});

describe("ticketTitle", () => {
  it("passes through a present title", () => {
    expect(ticketTitle({ title: "Fix the thing" })).toEqual({ text: "Fix the thing", unknown: false });
  });
  it("flags a missing title", () => {
    expect(ticketTitle({ title: null })).toEqual({ text: "(title unknown — appears after its next run)", unknown: true });
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

describe("formatDuration", () => {
  it("seconds, minutes + padded seconds, hours + padded minutes", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_900)).toBe("45s");
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(192_000)).toBe("3m 12s");
    expect(formatDuration(3_840_000)).toBe("1h 04m");
    expect(formatDuration(26 * 3_600_000)).toBe("26h 00m");
  });
  it("— for null, negative, non-finite", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(Infinity)).toBe("—");
  });
});
