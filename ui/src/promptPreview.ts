import type { InstructionFileView } from "./contract";

/** dispatch.js's join between the standing instructions and the ticket prompt (src/dispatch.js:837). */
export const TICKET_MARKER = "\n\n=== TICKET ===\n\n";

/**
 * Mirrors dispatch.js's prompt assembly (src/dispatch.js:823-837): repo and step instructions
 * trimmed, empties dropped, joined by a blank line; `ticket: null` → standing only (no run yet);
 * an empty standing part drops the marker entirely.
 */
export function composePrompt(parts: { repo: string; step: string; ticket: string | null }): string {
  const standing = [parts.repo, parts.step].map((s) => s.trim()).filter(Boolean).join("\n\n");
  if (parts.ticket === null) return standing;
  return standing ? `${standing}${TICKET_MARKER}${parts.ticket}` : parts.ticket;
}

export function promptPreviewUrl(profile: string, step: string): string {
  return `/api/prompt-preview?${new URLSearchParams({ profile, step })}`;
}

/** `2026-10-08T15-31-28-123Z-step-…` → `2026-10-08T15:31:28.123Z`, or null on a non-matching name. */
export function runStartedAt(run: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-step-/.exec(run);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

/** The step/default-scoped file covering `step`, preferring step scope over default. */
export function stepFileFor(files: InstructionFileView[], step: string): InstructionFileView | null {
  const scoped = files.filter((f) => f.scope === "step" && f.ids.includes(step));
  if (scoped.length) return scoped[0];
  return files.find((f) => f.scope === "default" && f.ids.includes(step)) ?? null;
}

/** Every repo-scoped file in the list. */
export function repoFiles(files: InstructionFileView[]): InstructionFileView[] {
  return files.filter((f) => f.scope === "repo");
}

/** Every step id a profile is known to run: the ids of its non-repo (step/default) files. */
export function stepIds(files: InstructionFileView[]): string[] {
  const ids = new Set<string>();
  for (const f of files) if (f.scope !== "repo") for (const id of f.ids) ids.add(id);
  return [...ids].sort();
}

/**
 * The step picker's option list for the file currently open: a repo-scoped file can stand in for
 * any step (dispatch joins it against every step's own file), so it offers every known step id;
 * a step/default-scoped file only ever supplies *its own* ids, so the picker is scoped to those
 * (otherwise the panel composes a prompt no agent ever gets — see dispatch.js:823-825).
 */
export function pickerSteps(files: InstructionFileView[], openFile: InstructionFileView): string[] {
  return openFile.scope === "repo" ? stepIds(files) : [...openFile.ids].sort();
}
