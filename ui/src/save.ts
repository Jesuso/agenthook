import { externalChange, isDirty } from "./instructions";
import type { InstructionsEvent, OpenFile } from "./instructions";

/**
 * Where the open file's save flow is. `editing` covers both clean and dirty — dirtiness stays
 * derived (`isDirty`), so undoing back to the loaded content is clean again.
 */
export type SavePhase =
  | { kind: "editing" }
  // Diff + live-effect note shown, waiting on Confirm / Cancel.
  | { kind: "confirming" }
  // PUT in flight. `base` is the hash it claims; SSE for the open file is stashed (latest only)
  // until it resolves, because the server broadcasts our own echo before the 200 lands.
  | { kind: "saving"; sent: string; base: string; stash: InstructionsEvent | null; retreat: SavePhase }
  // Disk moved under a clean buffer: the view reloads silently.
  | { kind: "stale"; hash: string }
  // Disk moved under a dirty buffer (409 or SSE). `content` is null until fetched (SSE carries only a hash).
  | { kind: "conflict"; hash: string; content: string | null }
  // Gone on disk: Reload only — the server 404s an overwrite of a missing file.
  | { kind: "deleted" };

export type SaveState = { open: OpenFile; buffer: string; phase: SavePhase };

export type SaveAction =
  | { type: "edit"; buffer: string }
  | { type: "save" }
  | { type: "cancel" }
  | { type: "confirm" }
  | { type: "overwrite" }
  | { type: "saved"; hash: string }
  | { type: "conflict"; content: string; hash: string }
  | { type: "failed" }
  | { type: "external"; ev: InstructionsEvent }
  | { type: "disk"; disk: { content: string; hash: string } | null };

export type SaveStatus = "clean" | "dirty" | Exclude<SavePhase["kind"], "editing">;

const EDITING: SavePhase = { kind: "editing" };

/** A freshly loaded file: buffer = disk, nothing pending. */
export function freshSave(open: OpenFile): SaveState {
  return { open, buffer: open.content, phase: EDITING };
}

export function saveStatus(s: SaveState): SaveStatus {
  if (s.phase.kind !== "editing") return s.phase.kind;
  return isDirty(s.buffer, s.open) ? "dirty" : "clean";
}

const sameFile = (open: OpenFile, ev: InstructionsEvent) => ev.profile === open.profile && ev.path === open.path;

/** Pure transition. Actions that don't apply to the current phase return `s` unchanged. */
export function saveReducer(s: SaveState, a: SaveAction): SaveState {
  const p = s.phase;
  switch (a.type) {
    case "edit":
      if (a.buffer === s.buffer) return s;
      // Typing over a pending silent reload: keep the edit, surface the disk change instead.
      if (p.kind === "stale") return { ...s, buffer: a.buffer, phase: { kind: "conflict", hash: p.hash, content: null } };
      return { ...s, buffer: a.buffer };
    case "save":
      return p.kind === "editing" && isDirty(s.buffer, s.open) ? { ...s, phase: { kind: "confirming" } } : s;
    case "cancel":
      return p.kind === "confirming" ? { ...s, phase: EDITING } : s;
    case "confirm":
      return p.kind === "confirming"
        ? { ...s, phase: { kind: "saving", sent: s.buffer, base: s.open.baseHash, stash: null, retreat: EDITING } }
        : s;
    case "overwrite":
      // Claims the on-disk hash; needs the explicit second confirm (view-side) first.
      return p.kind === "conflict" ? { ...s, phase: { kind: "saving", sent: s.buffer, base: p.hash, stash: null, retreat: p } } : s;
    case "saved": {
      if (p.kind !== "saving") return s;
      const next: SaveState = { ...s, open: { ...s.open, content: p.sent, baseHash: a.hash }, phase: EDITING };
      return p.stash ? saveReducer(next, { type: "external", ev: p.stash }) : next;
    }
    case "conflict":
      // The 409 body is the freshest disk truth we have, so the stash is dropped; a later edit
      // still arrives as a normal SSE event.
      return p.kind === "saving" ? { ...s, phase: { kind: "conflict", hash: a.hash, content: a.content } } : s;
    case "failed": {
      if (p.kind !== "saving") return s;
      const next: SaveState = { ...s, phase: p.retreat };
      return p.stash ? saveReducer(next, { type: "external", ev: p.stash }) : next;
    }
    case "external": {
      if (!sameFile(s.open, a.ev)) return s;
      if (p.kind === "saving") return { ...s, phase: { ...p, stash: a.ev } };
      const action = externalChange(s.open, a.ev, s.buffer);
      // Disk is back at our base hash: whatever was pending no longer applies.
      if (action === "ignore") return p.kind === "stale" || p.kind === "conflict" || p.kind === "deleted" ? { ...s, phase: EDITING } : s;
      if (a.ev.hash === null) return { ...s, phase: { kind: "deleted" } };
      if (p.kind === "conflict" && p.hash === a.ev.hash) return s;
      return { ...s, phase: action === "reload" ? { kind: "stale", hash: a.ev.hash } : { kind: "conflict", hash: a.ev.hash, content: null } };
    }
    case "disk":
      // The Diff action's GET of the on-disk version.
      if (p.kind !== "conflict") return s;
      if (!a.disk) return { ...s, phase: { kind: "deleted" } };
      if (a.disk.hash === s.open.baseHash) return { ...s, phase: EDITING };
      return { ...s, phase: { kind: "conflict", hash: a.disk.hash, content: a.disk.content } };
  }
}

/** The guarded PUT (`src/ui/server.js`): JSON content type + `X-AH-UI: 1`; the browser adds Origin. */
export function saveRequest(open: OpenFile, buffer: string): { url: string; init: RequestInit } {
  return {
    url: "/api/instructions/file",
    init: {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-AH-UI": "1" },
      body: JSON.stringify({ profile: open.profile, path: open.path, baseHash: open.baseHash, content: buffer }),
    },
  };
}

/**
 * 200 → ok, 409 → conflict, 422 → invalid (config only: the server rejected the text, nothing
 * written — the view dispatches `failed` and shows the errors), anything else (incl. network `0`)
 * → error. Nothing retries.
 */
export function classifySaveResponse(status: number): "ok" | "conflict" | "invalid" | "error" {
  return status === 200 ? "ok" : status === 409 ? "conflict" : status === 422 ? "invalid" : "error";
}

export function saveErrorText(status: number): string {
  return status === 0 ? "Save failed (network error)" : `Save failed (status ${status})`;
}

/** Instructions are re-read at every spawn, so a save is live with no restart. */
export function liveEffectNote(agentsRunning: number): { text: string; warn: boolean } {
  const base = "Takes effect on the next agent run";
  if (agentsRunning <= 0) return { text: `${base}.`, warn: false };
  const agents = agentsRunning === 1 ? "1 agent" : `${agentsRunning} agents`;
  return { text: `${base} — ${agents} currently running on steps using this file.`, warn: true };
}
