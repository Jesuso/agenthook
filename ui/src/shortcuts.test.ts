import { describe, it, expect } from "vitest";
import { epicsAction, isUndoKey, overviewAction, setShortcutsEnabled, shortcutsEnabled } from "./shortcuts";

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

describe("isUndoKey", () => {
  const z = (over: Record<string, unknown>) => ({ key: "z", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: { tagName: "BUTTON" }, ...over }) as unknown as Parameters<typeof isUndoKey>[0];
  it("is Ctrl+Z or ⌘+Z, not Shift (redo), not plain z, not inside a text field", () => {
    expect(isUndoKey(z({ ctrlKey: true }))).toBe(true);
    expect(isUndoKey(z({ metaKey: true, key: "Z" }))).toBe(true);
    expect(isUndoKey(z({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isUndoKey(z({}))).toBe(false);
    expect(isUndoKey(z({ ctrlKey: true, target: { tagName: "TEXTAREA" } }))).toBe(false);
  });
});

describe("epicsAction", () => {
  const key = (k: string, over: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: EventTarget | null }> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, target: null, ...over });
  it("maps j/k/u/? and nothing that writes", () => {
    expect(epicsAction(key("j"), false)).toBe("next");
    expect(epicsAction(key("k"), false)).toBe("prev");
    expect(epicsAction(key("u"), false)).toBe("up");
    expect(epicsAction(key("?"), false)).toBe("help");
    expect(epicsAction(key("r"), false)).toBeNull();
    expect(epicsAction(key("d"), false)).toBeNull();
  });
  it("passes through while typing, with a modifier, or under a dialog", () => {
    expect(epicsAction(key("j", { target: { tagName: "INPUT" } as unknown as EventTarget }), false)).toBeNull();
    expect(epicsAction(key("j", { ctrlKey: true }), false)).toBeNull();
    expect(epicsAction(key("j"), true)).toBeNull();
  });
});

describe("shortcutsEnabled", () => {
  it("stays on, and never throws, where there is no storage", () => {
    expect(() => setShortcutsEnabled(false)).not.toThrow();
    expect(shortcutsEnabled()).toBe(true);
  });
});
