import { describe, it, expect } from "vitest";
import { formatUp, formatLastEvent, shortRef, ticketTitle, formatRelative, formatCost, profileLabel, profileBadge, formatDate, formatDuration, formatElapsed, elapsedTickMs, relativeTickMs, formatModel, formatTicketSpend } from "./format";

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

describe("formatElapsed (#579)", () => {
  it("seconds for the first minute, then whole minutes, then hours + padded minutes", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m");
    expect(formatElapsed(192_000)).toBe("3m");
    expect(formatElapsed(3_599_999)).toBe("59m");
    expect(formatElapsed(3_600_000)).toBe("1h 00m");
    expect(formatElapsed(3_840_000)).toBe("1h 04m");
  });
  it("coarse (reduced motion) skips the seconds phase", () => {
    expect(formatElapsed(12_000, true)).toBe("<1m");
    expect(formatElapsed(60_000, true)).toBe("1m");
  });
  it("clock skew reads 0s; null / non-finite read —", () => {
    expect(formatElapsed(-800)).toBe("0s");
    expect(formatElapsed(null)).toBe("—");
    expect(formatElapsed(NaN)).toBe("—");
  });
});

describe("elapsedTickMs / relativeTickMs (#579)", () => {
  it("elapsed: next second under a minute, next minute boundary after", () => {
    expect(elapsedTickMs(0)).toBe(1000);
    expect(elapsedTickMs(12_300)).toBe(700);
    expect(elapsedTickMs(59_500)).toBe(500);
    expect(elapsedTickMs(60_000)).toBe(60_000);
    expect(elapsedTickMs(125_000)).toBe(55_000);
    expect(elapsedTickMs(3_659_000)).toBe(1000);
  });
  it("elapsed coarse: the first change is at one minute", () => {
    expect(elapsedTickMs(12_000, true)).toBe(48_000);
  });
  it("elapsed before the start waits for it, at most a second", () => {
    expect(elapsedTickMs(-300)).toBe(300);
    expect(elapsedTickMs(-5000)).toBe(1000);
  });
  it("relative: minute, then hour, then day boundaries", () => {
    expect(relativeTickMs(10_000)).toBe(50_000);
    expect(relativeTickMs(3_599_000)).toBe(1000);
    expect(relativeTickMs(3_600_000 + 60_000)).toBe(3_540_000);
    expect(relativeTickMs(86_400_000 + 1000)).toBe(86_399_000);
  });
});

describe("formatModel", () => {
  it("shortens claude-<family>-<maj>[-<min>] ids, keeping the id as the title", () => {
    expect(formatModel("claude-opus-5-5")).toEqual({ text: "opus 5.5", title: "claude-opus-5-5" });
    expect(formatModel("claude-sonnet-5")).toEqual({ text: "sonnet 5", title: "claude-sonnet-5" });
    expect(formatModel("claude-haiku-5-5")).toEqual({ text: "haiku 5.5", title: "claude-haiku-5-5" });
  });
  it("passes bare aliases and unknown strings through", () => {
    expect(formatModel("opus").text).toBe("opus");
    expect(formatModel("claude-opus-4-20250514").text).toBe("claude-opus-4-20250514");
    expect(formatModel("gpt-x").text).toBe("gpt-x");
  });
  it("renders null as an em dash", () => {
    expect(formatModel(null)).toEqual({ text: "—" });
  });
});

describe("formatTicketSpend", () => {
  it("appends measured energy beside the spend, never summed; energy alone stands alone", () => {
    expect(formatTicketSpend({ costUsd: 1.2 })).toBe("$1.20");
    expect(formatTicketSpend({ costUsd: 1.2, energyKwh: 0.0019, energyUsd: 0.00029 })).toBe("$1.20 · energy $0.00029 (1.9 Wh)");
    expect(formatTicketSpend({ costUsd: 0, energyKwh: 0.0019, energyUsd: 0.00029 })).toBe("energy $0.00029 (1.9 Wh)");
    expect(formatTicketSpend({ costUsd: 0 })).toBe("—");
  });
});
