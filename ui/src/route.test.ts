import { describe, it, expect } from "vitest";
import { HOME, hashFor, parseHash, sameRoute } from "./route";
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
});

describe("hashFor", () => {
  it("round-trips every route, including keys that need encoding", () => {
    const routes: Route[] = [
      HOME,
      { kind: "profile", profile: "dev", view: "overview" },
      { kind: "profile", profile: "dev", view: "instructions" },
      { kind: "profile", profile: "a/b c", view: "config" },
    ];
    for (const r of routes) expect(parseHash(hashFor(r))).toEqual(r);
  });

  it("leaves overview without a suffix", () => {
    expect(hashFor({ kind: "profile", profile: "dev", view: "overview" })).toBe("#/p/dev");
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
  });
});
