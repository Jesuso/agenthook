import type { InstructionFileView, UiEvent } from "./contract";
import { translate } from "./i18n";
import type { MessageKey } from "./i18n";

export type InstructionsEvent = Extract<UiEvent, { type: "instructions" }>;

/** A file open in the editor: the content as loaded and its sha256 (the base of any later save). */
export type OpenFile = { profile: string; path: string; content: string; baseHash: string };

/** The discard prompt for a dirty instructions buffer, in `lang`. */
export const discardPrompt = (lang = "en"): string => translate(lang, "instructions.discardPrompt");

/** The English discard prompt, for callers without a language. */
export const DISCARD_PROMPT = discardPrompt();

export type FileGroup = { scope: InstructionFileView["scope"]; label: string; files: InstructionFileView[] };

const GROUPS: { scope: InstructionFileView["scope"]; label: MessageKey }[] = [
  { scope: "step", label: "instructions.group.step" },
  { scope: "default", label: "instructions.group.default" },
  { scope: "repo", label: "instructions.group.repo" },
  { scope: "soul", label: "instructions.group.soul" },
];

/**
 * Files grouped step → default → repo — the order the pipeline actually runs them in
 * (`src/heartbeat.js`'s `instructionTargets`). Within a group the server's order is kept as-is
 * (no re-sort); empty groups are omitted. Group labels are in `lang`.
 */
export function groupFiles(files: InstructionFileView[], lang = "en"): FileGroup[] {
  const out: FileGroup[] = [];
  for (const g of GROUPS) {
    const members = files.filter((f) => f.scope === g.scope);
    if (members.length) out.push({ scope: g.scope, label: translate(lang, g.label), files: members });
  }
  return out;
}

/**
 * Which file to auto-open when a profile's list first lands: `remembered` if it's still in the
 * list and exists, else the first existing file in `groupFiles` order, else null.
 */
export function initialFile(files: InstructionFileView[], remembered: string | null): string | null {
  if (remembered && files.some((f) => f.path === remembered && f.exists)) return remembered;
  for (const g of groupFiles(files)) {
    const first = g.files.find((f) => f.exists);
    if (first) return first.path;
  }
  return null;
}

/**
 * The open file's path as the toolbar shows it: relative to the profile config's directory when
 * it sits under it (the usual repo layout), else in full. The tooltip always has the full path.
 */
export function displayPath(path: string, configPath: string | null): string {
  if (!configPath) return path;
  const dir = configPath.slice(0, Math.max(configPath.lastIndexOf("/"), configPath.lastIndexOf("\\")) + 1);
  return dir && path.startsWith(dir) ? path.slice(dir.length) : path;
}

/** A pipeline step and the file its agent reads: its own, else the profile default. */
export type StepNode = { id: string; file: InstructionFileView };

/**
 * The step bar's nodes in pipeline run order (`steps`, from the heartbeat). Steps the order doesn't
 * name, or every step when an older receiver sends no order, follow: own-file steps, then the steps
 * that fall back to the profile default.
 */
export function stepNodes(files: InstructionFileView[], steps: string[] | null = null): StepNode[] {
  const all: StepNode[] = [];
  for (const scope of ["step", "default"] as const) {
    for (const f of files) if (f.scope === scope) for (const id of f.ids) all.push({ id, file: f });
  }
  if (!steps) return all;
  const rank = new Map(steps.map((id, i) => [id, i]));
  const at = (n: StepNode) => rank.get(n.id) ?? steps.length;
  return all.map((n, i) => ({ n, i })).sort((a, b) => at(a.n) - at(b.n) || a.i - b.i).map(({ n }) => n);
}

/** Files no single step owns: repo files every step reads, and the Digest's SOUL. */
export function sharedFiles(files: InstructionFileView[]): InstructionFileView[] {
  return files.filter((f) => f.scope === "repo" || f.scope === "soul");
}

/** The shell command that creates a not-yet-created file, its path single-quoted when it needs it. */
export function touchCommand(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? `touch ${path}` : `touch '${path.replace(/'/g, "'\\''")}'`;
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
