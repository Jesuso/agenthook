import { describe, it, expect } from "vitest";
import { HOME, hashFor, parseHash, sameBase, sameRoute, withoutTicket } from "./route";
import type { Route } from "./route";

describe("parseHash", () => {
  it("maps empty and root hashes to Home", () => {
    expect(parseHash("")).toEqual(HOME);
    expect(parseHash("#")).toEqual(HOME);
    expect(parseHash("#/")).toEqual(HOME);
  });

  it("parses a profile with an overview default and each view", () => {
    expect(parseHash("#/p/dev")).toEqual({ kind: "profile", profile: "dev", view: "overview" });
    expect(parseHash("#/p/dev/instructions")).toEqual({ kind: "profile", profile: "dev", view: "instructions" });
    expect(parseHash("#/p/dev/config")).toEqual({ kind: "profile", profile: "dev", view: "config" });
    expect(parseHash("#/p/dev/stats")).toEqual({ kind: "profile", profile: "dev", view: "stats" });
    expect(parseHash("#/p/dev/epics")).toEqual({ kind: "profile", profile: "dev", view: "epics" });
  });

  it("parses one epic's page under the epics view only", () => {
    expect(parseHash("#/p/x/epics/123")).toEqual({ kind: "profile", profile: "x", view: "epics", epic: "123" });
    expect(parseHash("#/p/x/epics/a%2Fb")).toEqual({ kind: "profile", profile: "x", view: "epics", epic: "a/b" });
    expect(parseHash("#/p/x/stats/123")).toEqual(HOME);
    expect(parseHash("#/p/x/epics/123/extra")).toEqual(HOME);
    expect(parseHash("#/p/x/epics/%E0%A4%A")).toEqual(HOME);
  });

  it("decodes the state key", () => {
    expect(parseHash("#/p/my%20app")).toEqual({ kind: "profile", profile: "my app", view: "overview" });
  });

  it("falls back to Home for unknown shapes", () => {
    expect(parseHash("#/p/")).toEqual(HOME);
    expect(parseHash("#/x/dev")).toEqual(HOME);
    expect(parseHash("#/p/dev/nope")).toEqual(HOME);
    expect(parseHash("#/p/dev/config/extra")).toEqual(HOME);
    expect(parseHash("#/p/%E0%A4%A")).toEqual(HOME);
  });

  it("parses a ?t= ticket on any profile view, including an epic page", () => {
    expect(parseHash("#/p/x?t=42")).toEqual({ kind: "profile", profile: "x", view: "overview", ticket: "42" });
    expect(parseHash("#/p/x/stats?t=42")).toEqual({ kind: "profile", profile: "x", view: "stats", ticket: "42" });
    expect(parseHash("#/p/x/epics/123?u=1&t=42")).toEqual({ kind: "profile", profile: "x", view: "epics", epic: "123", ticket: "42" });
  });

  it("parses an empty, missing or malformed t as if it were absent, never to Home", () => {
    expect(parseHash("#/p/x?t=")).toEqual({ kind: "profile", profile: "x", view: "overview" });
    expect(parseHash("#/p/x?other=1")).toEqual({ kind: "profile", profile: "x", view: "overview" });
    expect(parseHash("#/p/x/stats?u=1&t=%E0%A4%A")).toEqual({ kind: "profile", profile: "x", view: "stats" });
  });

  it("ignores a t on the Home route", () => {
    expect(parseHash("#/?t=42")).toEqual(HOME);
  });
});

describe("hashFor", () => {
  it("round-trips every route, including keys that need encoding", () => {
    const routes: Route[] = [
      HOME,
      { kind: "profile", profile: "dev", view: "overview" },
      { kind: "profile", profile: "dev", view: "instructions" },
      { kind: "profile", profile: "dev", view: "stats" },
      { kind: "profile", profile: "a/b c", view: "config" },
      { kind: "profile", profile: "dev", view: "epics" },
      { kind: "profile", profile: "dev", view: "epics", epic: "1209" },
      { kind: "profile", profile: "a/b c", view: "epics", epic: "PROJ-1" },
      { kind: "profile", profile: "dev", view: "overview", ticket: "42" },
      { kind: "profile", profile: "dev", view: "stats", ticket: "42" },
      { kind: "profile", profile: "a/b c", view: "epics", epic: "PROJ-1", ticket: "a/b?c&d #% " },
    ];
    for (const r of routes) expect(parseHash(hashFor(r))).toEqual(r);
  });

  it("leaves overview without a suffix and appends the ticket as a t query", () => {
    expect(hashFor({ kind: "profile", profile: "dev", view: "overview" })).toBe("#/p/dev");
    expect(hashFor({ kind: "profile", profile: "dev", view: "overview", ticket: "42" })).toBe("#/p/dev?t=42");
  });
});

describe("sameBase / withoutTicket", () => {
  it("sameRoute differs on the ticket alone; sameBase does not", () => {
    const a: Route = { kind: "profile", profile: "dev", view: "config" };
    const b: Route = { kind: "profile", profile: "dev", view: "config", ticket: "7" };
    expect(sameRoute(a, a)).toBe(true);
    expect(sameRoute(a, b)).toBe(false);
    expect(sameRoute(b, { ...b, ticket: "8" })).toBe(false);
    expect(sameBase(a, b)).toBe(true);
    expect(sameBase(a, { kind: "profile", profile: "dev", view: "overview" })).toBe(false);
    expect(withoutTicket(b)).toEqual(a);
    expect(withoutTicket(a)).toBe(a);
    expect(withoutTicket(HOME)).toBe(HOME);
  });
});

describe("sameRoute", () => {
  it("compares kind, profile and view", () => {
    const a: Route = { kind: "profile", profile: "dev", view: "config" };
    expect(sameRoute(HOME, HOME)).toBe(true);
    expect(sameRoute(a, { ...a })).toBe(true);
    expect(sameRoute(a, { ...a, view: "overview" })).toBe(false);
    expect(sameRoute(a, { ...a, profile: "ops" })).toBe(false);
    expect(sameRoute(a, HOME)).toBe(false);
    const e: Route = { kind: "profile", profile: "dev", view: "epics", epic: "1" };
    expect(sameRoute(e, { ...e })).toBe(true);
    expect(sameRoute(e, { ...e, epic: "2" })).toBe(false);
    expect(sameRoute(e, { kind: "profile", profile: "dev", view: "epics" })).toBe(false);
  });
});
