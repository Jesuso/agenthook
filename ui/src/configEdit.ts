import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser";
import type { Edit, FormattingOptions, JSONPath } from "jsonc-parser";

/**
 * The Basics / Pipeline forms' text side (docs/web-ui.md § v3). Every form change is a minimal
 * `jsonc-parser` edit on the raw buffer, so `//` comment keys, key order and formatting survive.
 * Pure: text (and its parsed value) in, new text out.
 */

/** A step's stage-binding key family (src/types.js `StageKeys`). */
export type StageKeys = { source: string; success: string; failure: string; hold: string; queue: string };
export type StageOption = { id: string; label: string };
/** `GET /api/discover` 200 body (src/control.js `discover`). */
export type Discover = { tracker: string; stageKeys: StageKeys | null; stages: StageOption[] | null };

export const STAGE_ROLES = ["source", "success", "failure", "hold", "queue"] as const;
export const STEP_KINDS = ["implement", "change", "review", "triage"] as const;
export const STEP_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const PIPELINE: JSONPath = ["tracker", "pipeline"];

/** Indent unit from the first indented line (2 spaces if none), EOL from the first line break. */
export function formattingFor(text: string): FormattingOptions {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const m = /^([ \t]+)\S/m.exec(text);
  if (m?.[1].startsWith("\t")) return { insertSpaces: false, tabSize: 4, eol };
  return { insertSpaces: true, tabSize: m ? m[1].length : 2, eol };
}

/** Set `path` to `value` with the text's own formatting; `undefined` removes the key. */
export function setPath(text: string, path: JSONPath, value: unknown): string {
  return applyEdits(text, modify(text, path, value, { formattingOptions: formattingFor(text) }));
}

export type Basics = { name?: unknown; maxConcurrent?: unknown; fullAuto?: unknown; port?: unknown; trigger?: unknown };

export function readBasics(raw: unknown): Basics {
  if (!isObj(raw)) return {};
  const { name, maxConcurrent, fullAuto, port, trigger } = raw;
  return { name, maxConcurrent, fullAuto, port, trigger };
}

/** `tracker.pipeline` as-is (a non-object element reads as `{}`); [] when absent. */
export function readSteps(raw: unknown): Record<string, unknown>[] {
  const p = isObj(raw) && isObj(raw.tracker) ? raw.tracker.pipeline : undefined;
  return Array.isArray(p) ? p.map((s) => (isObj(s) ? s : {})) : [];
}

/** A form input's display text: absent → "", anything else → its string form. */
export const fieldText = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** Text / select input: empty removes the key (never writes ""). */
export function textEdit(text: string, path: JSONPath, input: string): string {
  return setPath(text, path, input === "" ? undefined : input);
}

/** Number input: empty removes the key; a non-numeric input is not applied. */
export function numberEdit(text: string, path: JSONPath, input: string): { ok: true; text: string } | { ok: false; error: string } {
  const s = input.trim();
  if (s === "") return { ok: true, text: setPath(text, path, undefined) };
  const n = Number(s);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) || !Number.isFinite(n)) return { ok: false, error: "not a number" };
  return { ok: true, text: setPath(text, path, n) };
}

/**
 * Checkbox: checked → `true`; unchecked removes a `true` key (no edit when absent), or writes an
 * explicit `false` when `explicitFalse` (fullAuto — security-relevant).
 */
export function boolEdit(text: string, path: JSONPath, checked: boolean, current: unknown, explicitFalse = false): string {
  if (checked) return setPath(text, path, true);
  if (explicitFalse) return setPath(text, path, false);
  return current === true ? setPath(text, path, undefined) : text;
}

export const stepPath = (i: number, key: string): JSONPath => [...PIPELINE, i, key];

/** Append `{ id: "step-N", kind: "implement" }` with an id no step uses. */
export function addStep(text: string): string {
  const steps = readSteps(JSON.parse(text));
  const ids = new Set(steps.map((s) => s.id));
  let n = steps.length + 1;
  while (ids.has(`step-${n}`)) n++;
  const value = { id: `step-${n}`, kind: "implement" };
  return applyEdits(text, modify(text, [...PIPELINE, steps.length], value, { isArrayInsertion: true, formattingOptions: formattingFor(text) }));
}

export function removeStep(text: string, i: number): string {
  return setPath(text, [...PIPELINE, i], undefined);
}

/**
 * Swap step `i` with its neighbour (`dir` -1 up / +1 down) by exchanging the two elements' exact
 * source slices, so each step's inner formatting and comment keys move verbatim. Out of range → no edit.
 */
export function moveStep(text: string, i: number, dir: -1 | 1): string {
  const tree = parseTree(text);
  const arr = tree && findNodeAtLocation(tree, PIPELINE);
  const items = arr?.type === "array" ? (arr.children ?? []) : [];
  const j = i + dir;
  if (i < 0 || j < 0 || i >= items.length || j >= items.length) return text;
  const [a, b] = i < j ? [items[i], items[j]] : [items[j], items[i]];
  const slice = (n: typeof a) => text.slice(n.offset, n.offset + n.length);
  const edits: Edit[] = [
    { offset: a.offset, length: a.length, content: slice(b) },
    { offset: b.offset, length: b.length, content: slice(a) },
  ];
  return applyEdits(text, edits);
}

const SUFFIX: Record<string, string> = { asana: "SectionGid", github: "Label", jira: "Status", "github-projects": "Status", local: "Status" };

/** The step binding keys: the receiver's `discover.stageKeys`, else by `tracker.type`; null = unknown (raw only). */
export function stageKeysFor(discover: Discover | null, trackerType: unknown): StageKeys | null {
  if (discover?.stageKeys) return discover.stageKeys;
  const suffix = typeof trackerType === "string" && Object.hasOwn(SUFFIX, trackerType) ? SUFFIX[trackerType] : null;
  if (!suffix) return null;
  return { source: `source${suffix}`, success: `success${suffix}`, failure: `failure${suffix}`, hold: `hold${suffix}`, queue: `queue${suffix}` };
}

/**
 * The pipeline-step subset of src/config.js `validateRawConfig`, same wording. Display only: the
 * server's 422 stays authoritative.
 */
export function clientErrors(raw: unknown): string[] {
  const p = isObj(raw) && isObj(raw.tracker) ? raw.tracker.pipeline : undefined;
  if (!Array.isArray(p)) return [];
  const errors: string[] = [];
  const ids = new Set<unknown>();
  p.forEach((step: any, i) => {
    if (!isObj(step)) return void errors.push(`config: tracker.pipeline[${i}] must be an object.`);
    const sid = String(step.id);
    if (!step.id) errors.push(`config: every pipeline step needs an "id".`);
    else if (ids.has(step.id)) errors.push(`config: duplicate pipeline step id "${sid}".`);
    ids.add(step.id);
    const { maxAttempts, maxMinutes, idleMinutes } = step;
    if (maxAttempts != null && (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1)) {
      errors.push(`config: pipeline step "${sid}" maxAttempts must be a positive integer.`);
    }
    if (maxMinutes != null && (typeof maxMinutes !== "number" || !Number.isFinite(maxMinutes) || maxMinutes < 0)) {
      errors.push(`config: pipeline step "${sid}" maxMinutes must be a number >= 0 (0 disables the cap).`);
    }
    if (idleMinutes != null && (typeof idleMinutes !== "number" || !Number.isFinite(idleMinutes) || idleMinutes <= 0)) {
      errors.push(`config: pipeline step "${sid}" idleMinutes must be a number > 0.`);
    }
  });
  return errors;
}

/** Where a stage picker's options come from, per the `GET /api/discover` outcome. */
export type StageSource = { kind: "loading" } | { kind: "list"; stages: StageOption[] } | { kind: "text"; hint: string };

/** 200 with stages → a picker; 503 → type it (receiver down); anything else → couldn't list. `status` 0 = network error. */
export function stageSource(status: number, body: Discover | null): StageSource {
  if (status === 200 && body && Array.isArray(body.stages)) return { kind: "list", stages: body.stages };
  if (status === 503) return { kind: "text", hint: "receiver not running — type the value" };
  const why =
    status === 200
      ? "the tracker has no stage list"
      : status === 0
        ? "network error"
        : status === 404
          ? "unknown profile"
          : status === 504
            ? "receiver timed out"
            : status === 502
              ? `receiver error${typeof (body as any)?.error === "string" ? `: ${(body as any).error}` : ""}`
              : `status ${status}`;
  return { kind: "text", hint: `couldn't list stages (${why})` };
}

export function discoverUrl(profile: string): string {
  return `/api/discover?${new URLSearchParams({ profile })}`;
}
