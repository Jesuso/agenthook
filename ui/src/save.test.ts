import { describe, it, expect } from "vitest";
import type { InstructionsEvent, OpenFile } from "./instructions";
import { classifySaveResponse, freshSave, liveEffectNote, saveErrorText, saveReducer, saveRequest, saveStatus } from "./save";
import type { SaveAction, SaveState } from "./save";

const open: OpenFile = { profile: "p", path: "/a/code.md", content: "hello", baseHash: "h1" };
const ev = (over: Partial<InstructionsEvent>): InstructionsEvent => ({ type: "instructions", profile: "p", path: "/a/code.md", hash: "h2", source: "disk", ...over });
const run = (s: SaveState, ...actions: SaveAction[]) => actions.reduce(saveReducer, s);

const dirty = run(freshSave(open), { type: "edit", buffer: "hello world" });
const saving = run(dirty, { type: "save" }, { type: "confirm" });
const conflict = run(saving, { type: "conflict", content: "disk v2", hash: "h2" });

describe("saveReducer", () => {
  it("clean → dirty → confirming → saving → saved (clean)", () => {
    const s0 = freshSave(open);
    expect(saveStatus(s0)).toBe("clean");
    expect(saveStatus(dirty)).toBe("dirty");
    const confirming = saveReducer(dirty, { type: "save" });
    expect(saveStatus(confirming)).toBe("confirming");
    const s = saveReducer(confirming, { type: "confirm" });
    expect(s.phase).toMatchObject({ kind: "saving", sent: "hello world", base: "h1" });
    const saved = saveReducer(s, { type: "saved", hash: "h9" });
    expect(saveStatus(saved)).toBe("clean");
    expect(saved.open).toEqual({ ...open, content: "hello world", baseHash: "h9" });
  });

  it("keeps edits typed during the save dirty against the sent content", () => {
    const s = run(saving, { type: "edit", buffer: "hello world!" }, { type: "saved", hash: "h9" });
    expect(s.open.content).toBe("hello world");
    expect(saveStatus(s)).toBe("dirty");
  });

  it("save on a clean buffer is a no-op", () => {
    const s0 = freshSave(open);
    expect(saveReducer(s0, { type: "save" })).toBe(s0);
  });

  it("cancel from confirming → dirty", () => {
    const s = run(dirty, { type: "save" }, { type: "cancel" });
    expect(saveStatus(s)).toBe("dirty");
    expect(s.buffer).toBe("hello world");
  });

  it("saving → conflict on 409, carrying the on-disk version", () => {
    expect(conflict.phase).toEqual({ kind: "conflict", hash: "h2", content: "disk v2" });
    expect(conflict.buffer).toBe("hello world");
    expect(conflict.open.baseHash).toBe("h1");
  });

  it("saving → error stays dirty, nothing retried", () => {
    const s = saveReducer(saving, { type: "failed" });
    expect(saveStatus(s)).toBe("dirty");
    expect(s.open).toEqual(open);
  });

  it("conflict → overwrite claims the on-disk hash → saved", () => {
    const s = saveReducer(conflict, { type: "overwrite" });
    expect(s.phase).toMatchObject({ kind: "saving", sent: "hello world", base: "h2" });
    const saved = saveReducer(s, { type: "saved", hash: "h3" });
    expect(saveStatus(saved)).toBe("clean");
    expect(saved.open.baseHash).toBe("h3");
  });

  it("a second 409 on overwrite re-enters conflict with the newer version", () => {
    const s = run(conflict, { type: "overwrite" }, { type: "conflict", content: "disk v3", hash: "h3" });
    expect(s.phase).toEqual({ kind: "conflict", hash: "h3", content: "disk v3" });
  });

  it("a failed overwrite returns to the conflict", () => {
    const s = run(conflict, { type: "overwrite" }, { type: "failed" });
    expect(s.phase).toEqual(conflict.phase);
  });

  it("conflict → reload is a fresh load", () => {
    const s = freshSave({ ...open, content: "disk v2", baseHash: "h2" });
    expect(saveStatus(s)).toBe("clean");
    expect(s.buffer).toBe("disk v2");
  });

  it("ignores the tab's own SSE echo that lands while saving", () => {
    const s = run(saving, { type: "external", ev: ev({ hash: "h9", source: "ui" }) });
    expect(s.phase).toMatchObject({ kind: "saving" });
    const saved = saveReducer(s, { type: "saved", hash: "h9" });
    expect(saved.phase).toEqual({ kind: "editing" });
    expect(saveStatus(saved)).toBe("clean");
  });

  it("still surfaces a genuine concurrent edit stashed during the save", () => {
    const s = run(saving, { type: "external", ev: ev({ hash: "h9" }) }, { type: "external", ev: ev({ hash: "hX" }) }, { type: "saved", hash: "h9" });
    expect(s.phase).toEqual({ kind: "stale", hash: "hX" });
    const typed = run(saving, { type: "external", ev: ev({ hash: "hX" }) }, { type: "edit", buffer: "more" }, { type: "saved", hash: "h9" });
    expect(typed.phase).toEqual({ kind: "conflict", hash: "hX", content: null });
  });

  it("re-evaluates the stash after a failed save", () => {
    const s = run(saving, { type: "external", ev: ev({ hash: "hX" }) }, { type: "failed" });
    expect(s.phase).toEqual({ kind: "conflict", hash: "hX", content: null });
  });

  it("SSE change: clean → stale (silent reload), dirty → conflict, deleted → deleted", () => {
    expect(saveReducer(freshSave(open), { type: "external", ev: ev({}) }).phase).toEqual({ kind: "stale", hash: "h2" });
    expect(saveReducer(dirty, { type: "external", ev: ev({}) }).phase).toEqual({ kind: "conflict", hash: "h2", content: null });
    expect(saveReducer(dirty, { type: "external", ev: ev({ hash: null }) }).phase).toEqual({ kind: "deleted" });
    expect(saveReducer(freshSave(open), { type: "external", ev: ev({ hash: null }) }).phase).toEqual({ kind: "deleted" });
  });

  it("ignores events for other files and for the hash already loaded", () => {
    expect(saveReducer(dirty, { type: "external", ev: ev({ path: "/other.md" }) })).toBe(dirty);
    expect(saveReducer(dirty, { type: "external", ev: ev({ profile: "q" }) })).toBe(dirty);
    expect(saveReducer(dirty, { type: "external", ev: ev({ hash: "h1" }) })).toBe(dirty);
    expect(saveReducer(saving, { type: "external", ev: ev({ path: "/other.md" }) })).toBe(saving);
  });

  it("drops a pending conflict when disk returns to the base hash", () => {
    expect(saveReducer(conflict, { type: "external", ev: ev({ hash: "h1" }) }).phase).toEqual({ kind: "editing" });
  });

  it("keeps the known 409 content when the matching SSE arrives", () => {
    expect(saveReducer(conflict, { type: "external", ev: ev({ hash: "h2" }) })).toBe(conflict);
  });

  it("typing over a pending silent reload turns it into a conflict", () => {
    const stale = saveReducer(freshSave(open), { type: "external", ev: ev({}) });
    expect(saveReducer(stale, { type: "edit", buffer: "x" }).phase).toEqual({ kind: "conflict", hash: "h2", content: null });
  });

  it("an SSE change while confirming closes the confirm into a conflict", () => {
    const s = run(dirty, { type: "save" }, { type: "external", ev: ev({}) });
    expect(s.phase).toEqual({ kind: "conflict", hash: "h2", content: null });
  });

  it("disk fetch fills in an SSE conflict's content", () => {
    const sse = saveReducer(dirty, { type: "external", ev: ev({}) });
    expect(saveReducer(sse, { type: "disk", disk: { content: "disk v2", hash: "h2" } }).phase).toEqual({ kind: "conflict", hash: "h2", content: "disk v2" });
    expect(saveReducer(sse, { type: "disk", disk: null }).phase).toEqual({ kind: "deleted" });
    expect(saveReducer(sse, { type: "disk", disk: { content: "hello", hash: "h1" } }).phase).toEqual({ kind: "editing" });
  });

  it("does not save or overwrite from the deleted phase", () => {
    const deleted = saveReducer(dirty, { type: "external", ev: ev({ hash: null }) });
    expect(saveReducer(deleted, { type: "save" })).toBe(deleted);
    expect(saveReducer(deleted, { type: "overwrite" })).toBe(deleted);
  });

  it("ignores PUT results outside of saving", () => {
    expect(saveReducer(dirty, { type: "saved", hash: "h9" })).toBe(dirty);
    expect(saveReducer(dirty, { type: "failed" })).toBe(dirty);
    expect(saveReducer(dirty, { type: "conflict", content: "", hash: "h2" })).toBe(dirty);
  });
});

describe("saveRequest", () => {
  it("builds the guarded PUT", () => {
    const { url, init } = saveRequest(open, "new body");
    expect(url).toBe("/api/instructions/file");
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-AH-UI": "1" });
    expect(JSON.parse(String(init.body))).toEqual({ profile: "p", path: "/a/code.md", baseHash: "h1", content: "new body" });
  });
});

describe("classifySaveResponse", () => {
  it("maps 200 / 409 / everything else", () => {
    expect(classifySaveResponse(200)).toBe("ok");
    expect(classifySaveResponse(409)).toBe("conflict");
    for (const status of [0, 400, 401, 403, 404, 413, 415, 500, 502]) expect(classifySaveResponse(status)).toBe("error");
  });

  it("names the status in the error text", () => {
    expect(saveErrorText(413)).toBe("Save failed (status 413)");
    expect(saveErrorText(0)).toBe("Save failed (network error)");
  });
});

describe("liveEffectNote", () => {
  it("is a plain note with no agents running", () => {
    expect(liveEffectNote(0)).toEqual({ text: "Takes effect on the next agent run.", warn: false });
  });

  it("warns with the running-agent count", () => {
    expect(liveEffectNote(1)).toEqual({ text: "Takes effect on the next agent run — 1 agent currently running on steps using this file.", warn: true });
    expect(liveEffectNote(3).text).toBe("Takes effect on the next agent run — 3 agents currently running on steps using this file.");
    expect(liveEffectNote(3).warn).toBe(true);
  });
});
