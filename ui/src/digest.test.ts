import { describe, it, expect } from "vitest";
import { digestOutcome, digestRequest, digestUrl, eventsSince } from "./digest";
import type { FeedEntry } from "./feed";

const ev = (event: string, ts: string): FeedEntry => ({ type: "event", profile: "p", event: { event, ts, ref: "1" } });

describe("digest requests", () => {
  it("posts the profile with the write guard header", () => {
    const { url, init } = digestRequest("dev");
    expect(url).toBe("/api/digest");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-AH-UI"]).toBe("1");
    expect(JSON.parse(String(init.body))).toEqual({ profile: "dev" });
  });
  it("encodes the profile in the read url", () => {
    expect(digestUrl("a b")).toBe("/api/digest?profile=a%20b");
  });
});

describe("digestOutcome", () => {
  it("returns the digest on 200 and a plain message otherwise", () => {
    const d = { text: "hi", generatedAt: "t", basedOnEvents: 0, needsYou: 0 };
    expect(digestOutcome(200, d)).toEqual({ ok: true, digest: d });
    expect(digestOutcome(200, {})).toMatchObject({ ok: false });
    expect(digestOutcome(502, { error: "boom" })).toEqual({ ok: false, error: "boom" });
    expect(digestOutcome(503, null)).toMatchObject({ ok: false, error: expect.stringContaining("not running") });
    expect(digestOutcome(504, null)).toMatchObject({ ok: false });
    expect(digestOutcome(0, null)).toEqual({ ok: false, error: "network error" });
    expect(digestOutcome(500, null)).toEqual({ ok: false, error: "digest failed (status 500)" });
  });
});

describe("eventsSince", () => {
  it("counts only meaningful events newer than the digest", () => {
    const feed = [ev("run_end", "2026-10-15T12:05:00Z"), ev("enqueued", "2026-10-15T12:06:00Z"), ev("failed", "2026-10-15T11:00:00Z"), ev("merged", "2026-10-15T12:10:00Z")];
    expect(eventsSince(feed, "2026-10-15T12:00:00Z")).toBe(2);
    expect(eventsSince(feed, "garbage")).toBe(0);
  });
});

describe("digestOutcome in Spanish", () => {
  it("translates its own errors, not the agent's", () => {
    expect(digestOutcome(503, null, "es")).toEqual({ ok: false, error: "el receptor no está en ejecución" });
    expect(digestOutcome(500, null, "es")).toEqual({ ok: false, error: "el resumen falló (estado 500)" });
    expect(digestOutcome(502, { error: "boom" }, "es")).toEqual({ ok: false, error: "boom" });
  });
});
