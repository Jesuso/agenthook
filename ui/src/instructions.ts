import type { InstructionFileView, UiEvent } from "./contract";

export type InstructionsEvent = Extract<UiEvent, { type: "instructions" }>;

/** A file open in the editor: the content as loaded and its sha256 (the base of any later save). */
export type OpenFile = { profile: string; path: string; content: string; baseHash: string };

export const DISCARD_PROMPT = "Discard unsaved changes to the open instructions file?";

export type FileGroup = { scope: InstructionFileView["scope"]; label: string; files: InstructionFileView[] };

const GROUPS: { scope: InstructionFileView["scope"]; label: string }[] = [
  { scope: "default", label: "profile default" },
  { scope: "step", label: "steps" },
  { scope: "repo", label: "repos" },
];

/** Files grouped default → step → repo, each sorted by first id then path. Empty groups are omitted. */
export function groupFiles(files: InstructionFileView[]): FileGroup[] {
  const out: FileGroup[] = [];
  for (const g of GROUPS) {
    const members = files
      .filter((f) => f.scope === g.scope)
      .sort((a, b) => (a.ids[0] ?? "").localeCompare(b.ids[0] ?? "") || a.path.localeCompare(b.path));
    if (members.length) out.push({ ...g, files: members });
  }
  return out;
}

/** Derived, never sticky: undoing back to the loaded content makes the buffer clean again. */
export function isDirty(buffer: string, loaded: { content: string }): boolean {
  return buffer !== loaded.content;
}

/**
 * What an SSE `instructions` event means for the open file. Another profile/file, or the hash
 * the editor already has → `ignore`. A real change → `reload` silently when the buffer is clean,
 * else `banner`. A deletion (`hash: null`) always shows the banner.
 */
export function externalChange(open: OpenFile | null, ev: InstructionsEvent, buffer: string): "ignore" | "reload" | "banner" {
  if (!open || ev.profile !== open.profile || ev.path !== open.path || ev.hash === open.baseHash) return "ignore";
  if (ev.hash === null) return "banner";
  return isDirty(buffer, open) ? "banner" : "reload";
}

export function instructionsUrl(profile: string): string {
  return `/api/instructions?${new URLSearchParams({ profile })}`;
}

export function instructionFileUrl(profile: string, path: string): string {
  return `/api/instructions/file?${new URLSearchParams({ profile, path })}`;
}

/** Last path segment, for compact display (the full path rides in a title). */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
