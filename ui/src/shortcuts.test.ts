import { describe, it, expect } from "vitest";
import { overviewAction } from "./shortcuts";

const key = (k: string, over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: unknown }> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, target: { tagName: "BUTTON" }, ...over }) as Parameters<typeof overviewAction>[0];

describe("overviewAction", () => {
  it("maps j/k/r/d/? to their actions and ignores other keys", () => {
    expect(["j", "k", "r", "d", "?", "x"].map((k) => overviewAction(key(k), false))).toEqual(["next", "prev", "release", "dismiss", "help", null]);
  });

  it("passes keys through while typing, with a modifier, or under an open dialog", () => {
    expect(overviewAction(key("j", { target: { tagName: "TEXTAREA" } }), false)).toBeNull();
    expect(overviewAction(key("j", { target: { tagName: "INPUT" } }), false)).toBeNull();
    expect(overviewAction(key("d", { target: { isContentEditable: true } }), false)).toBeNull();
    expect(overviewAction(key("r", { ctrlKey: true }), false)).toBeNull();
    expect(overviewAction(key("r", { metaKey: true }), false)).toBeNull();
    expect(overviewAction(key("j"), true)).toBeNull();
  });
});
