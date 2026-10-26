import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser";
import type { Edit, FormattingOptions, JSONPath } from "jsonc-parser";
import { CONFIG_SCHEMA, stepEntry } from "../../src/config-schema.js";
import type { SchemaEntry } from "../../src/config-schema.js";
import { isEnvRef } from "../../src/ui/sensitive.js";
import { DEFAULT_SINK_EVENTS, SINK_REQUIRED, sinkErrors } from "../../src/sinks-config.js";
import { digestErrors } from "../../src/digest-config.js";
import { reposErrors } from "../../src/repos-config.js";
import { pricingErrors } from "../../src/pricing.js";
import { quotaErrors } from "../../src/quota.js";
import { translate } from "./i18n";

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
// The enum options live in the config schema (one definition the forms and the drift test share).
export { STEP_KINDS, STEP_EFFORTS } from "../../src/config-schema.js";
export const KNOWN_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const PIPELINE: JSONPath = ["tracker", "pipeline"];

/** Indent unit from the first indented line (2 spaces if none), EOL from the first line break. */
export function formattingFor(text: string): FormattingOptions {
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const m = /^([ \t]+)\S/m.exec(text);
  if (m?.[1].startsWith("\t")) return { insertSpaces: false, tabSize: 4, eol };
  return { insertSpaces: true, tabSize: m ? m[1].length : 2, eol };
}

/** Set `path` to `value` with the text's own formatting; `undefined` removes the key (no edit when it is already absent). */
export function setPath(text: string, path: JSONPath, value: unknown): string {
  if (value === undefined) {
    // Deleting under a missing parent throws in jsonc-parser; there is nothing to delete anyway.
    const tree = parseTree(text);
    if (!tree || !findNodeAtLocation(tree, path)) return text;
  }
  return applyEdits(text, modify(text, path, value, { formattingOptions: formattingFor(text) }));
}

/**
 * The `name` field's edit: sets the label and, unless `stateId` is already present, inserts
 * `"stateId": stateKey` right after `"name"` so the save keeps the profile's state dir in place
 * (the server rejects a save whose effective state key — `stateId ?? name` — no longer matches
 * the profile). No-op insert when `stateId` is already set (reverting the name then leaves a
 * harmless `stateId` equal to the state key).
 */
export function renameEdit(text: string, input: string, stateKey: string): string {
  const next = textEdit(text, ["name"], input);
  const raw = JSON.parse(next);
  if (isObj(raw) && raw.stateId !== undefined) return next;
  const edits = modify(next, ["stateId"], stateKey, {
    getInsertionIndex: (properties) => {
      const i = properties.indexOf("name");
      return i === -1 ? properties.length : i + 1;
    },
    formattingOptions: formattingFor(next),
  });
  return applyEdits(next, edits);
}

export type Basics = {
  name?: unknown;
  maxConcurrent?: unknown;
  fullAuto?: unknown;
  port?: unknown;
  trigger?: unknown;
  ui?: { color?: unknown; emoji?: unknown };
  instructionsFile?: unknown;
  language?: unknown;
  agent?: unknown;
  agentProvider?: unknown;
  claudeBin?: unknown;
  stateId?: unknown;
  sandbox?: Record<string, unknown>;
};

export function readBasics(raw: unknown): Basics {
  if (!isObj(raw)) return {};
  const { name, maxConcurrent, fullAuto, port, trigger, ui, instructionsFile, language, agent, agentProvider, claudeBin, stateId, sandbox } = raw;
  return { name, maxConcurrent, fullAuto, port, trigger, ui: isObj(ui) ? ui : undefined, instructionsFile, language, agent, agentProvider, claudeBin, stateId, sandbox: isObj(sandbox) ? sandbox : undefined };
}

/**
 * The Sandbox backend select's edit: `""` removes the whole `sandbox` block (never leaves `{}`
 * behind); `"docker"` / `"podman"` sets `sandbox.type` only, keeping any other key already there
 * (so switching backends doesn't drop `image`/`memory`/`cpus`/`egress`).
 */
export function sandboxTypeEdit(text: string, type: "" | "docker" | "podman"): string {
  if (type === "") return setPath(text, ["sandbox"], undefined);
  return setPath(text, ["sandbox", "type"], type);
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
export function numberEdit(text: string, path: JSONPath, input: string, lang = "en"): { ok: true; text: string } | { ok: false; error: string } {
  const s = input.trim();
  if (s === "") return { ok: true, text: setPath(text, path, undefined) };
  const n = Number(s);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) || !Number.isFinite(n)) return { ok: false, error: translate(lang, "configHelp.notANumber") };
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

/** A boolean with a schema default (`assigneeFilter`, `redCi`, `greenCi` — all `true`): absent reads as the default. */
export const effectiveBool = (value: unknown, defaultValue: boolean): boolean => (typeof value === "boolean" ? value : defaultValue);

/**
 * Checkbox for a key with a boolean default: checking/unchecking *to* the default removes the key
 * (back to default), the other way writes the explicit value — so unchecking a default-`true` key
 * writes `false` instead of being a no-op.
 */
export function defaultBoolEdit(text: string, path: JSONPath, checked: boolean, defaultValue: boolean): string {
  return setPath(text, path, checked === defaultValue ? undefined : checked);
}

/**
 * The Appearance picker's edit: set `ui.<field>` to a palette id / emoji, or `undefined` to go back
 * to the derived default. An emptied `ui` block is removed so "automatic" leaves no trace in the file.
 */
export function identityEdit(text: string, field: "color" | "emoji", value: string | undefined): string {
  const before = JSON.parse(text);
  // Clearing under a missing `ui` block has nothing to delete (and jsonc-parser throws on it).
  if (value === undefined && !(isObj(before) && isObj(before.ui) && before.ui[field] !== undefined)) return text;
  const next = setPath(text, ["ui", field], value);
  const raw = JSON.parse(next);
  return isObj(raw) && isObj(raw.ui) && Object.keys(raw.ui).length === 0 ? setPath(next, ["ui"], undefined) : next;
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
 * Swap element `i` of the array at `arrPath` with its neighbour (`dir` -1 up / +1 down) by exchanging
 * the two elements' exact source slices, so each one's inner formatting and comment keys move verbatim.
 * Out of range → no edit.
 */
function swapItems(text: string, arrPath: JSONPath, i: number, dir: -1 | 1): string {
  const tree = parseTree(text);
  const arr = tree && findNodeAtLocation(tree, arrPath);
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

/**
 * `escalate.<difficulty>.<field>` edit: `""` removes the leaf; removing the last leaf of a
 * difficulty removes that difficulty, and removing the last difficulty removes `escalate` itself.
 * Clearing when the parent (or grandparent) is absent is a no-op — jsonc-parser throws deleting
 * under a missing container, so existence is checked before any removal. Other `escalate.*` keys
 * (and any unknown/comment keys) are left untouched.
 */
export function escalateEdit(text: string, i: number, difficulty: string, field: "model" | "effort", input: string): string {
  const path: JSONPath = [...PIPELINE, i, "escalate", difficulty, field];
  if (input !== "") return setPath(text, path, input);
  const step = readSteps(JSON.parse(text))[i] ?? {};
  const escalate = isObj(step.escalate) ? step.escalate : undefined;
  const byDifficulty = escalate && isObj(escalate[difficulty]) ? (escalate[difficulty] as Record<string, unknown>) : undefined;
  if (!byDifficulty || byDifficulty[field] === undefined) return text;
  let next = setPath(text, path, undefined);
  if (Object.keys(byDifficulty).filter((k) => k !== field).length === 0) {
    next = setPath(next, [...PIPELINE, i, "escalate", difficulty], undefined);
    if (Object.keys(escalate!).filter((k) => k !== difficulty).length === 0) {
      next = setPath(next, [...PIPELINE, i, "escalate"], undefined);
    }
  }
  return next;
}

/**
 * `lite.model` / `lite.effort` edit: `""` removes the leaf; removing the last leaf removes `lite`.
 * Same no-op-when-absent guard as `escalateEdit`.
 */
export function liteEdit(text: string, i: number, field: "model" | "effort", input: string): string {
  const path: JSONPath = [...PIPELINE, i, "lite", field];
  if (input !== "") return setPath(text, path, input);
  const step = readSteps(JSON.parse(text))[i] ?? {};
  const lite = isObj(step.lite) ? step.lite : undefined;
  if (!lite || lite[field] === undefined) return text;
  let next = setPath(text, path, undefined);
  if (Object.keys(lite).filter((k) => k !== field).length === 0) next = setPath(next, [...PIPELINE, i, "lite"], undefined);
  return next;
}

/**
 * `lite.descriptionHeadings` edit: blank entries are dropped before writing; an empty list removes
 * the key (and `lite` with it, if that was its only leaf). Same no-op-when-absent guard.
 */
export function liteHeadingsEdit(text: string, i: number, headings: string[]): string {
  const clean = headings.filter((h) => h.trim() !== "");
  const path: JSONPath = [...PIPELINE, i, "lite", "descriptionHeadings"];
  if (clean.length > 0) return setPath(text, path, clean);
  const step = readSteps(JSON.parse(text))[i] ?? {};
  const lite = isObj(step.lite) ? step.lite : undefined;
  if (!lite || lite.descriptionHeadings === undefined) return text;
  let next = setPath(text, path, undefined);
  if (Object.keys(lite).filter((k) => k !== "descriptionHeadings").length === 0) next = setPath(next, [...PIPELINE, i, "lite"], undefined);
  return next;
}

/** A step's `env` as editable rows (insertion order); a non-object `env` reads as no rows. */
export function envRows(env: unknown): [string, string][] {
  return isObj(env) ? Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v : fieldText(v)]) : [];
}

/**
 * `env` edit: rows with a blank key are dropped before writing; no rows left removes `env`. Same
 * no-op-when-absent guard as `escalateEdit`.
 */
export function envEdit(text: string, i: number, rows: [string, string][]): string {
  const clean = rows.filter(([k]) => k.trim() !== "").map(([k, v]): [string, string] => [k.trim(), v]);
  const path: JSONPath = [...PIPELINE, i, "env"];
  if (clean.length > 0) return setPath(text, path, Object.fromEntries(clean));
  const step = readSteps(JSON.parse(text))[i] ?? {};
  return step.env === undefined ? text : setPath(text, path, undefined);
}

/** Swap step `i` with its neighbour (`dir` -1 up / +1 down); see `swapItems`. */
export function moveStep(text: string, i: number, dir: -1 | 1): string {
  return swapItems(text, PIPELINE, i, dir);
}

const SUFFIX: Record<string, string> = { asana: "SectionGid", github: "Label", jira: "Status", "github-projects": "Status", local: "Status" };

/** The step binding keys: the receiver's `discover.stageKeys`, else by `tracker.type`; null = unknown (raw only). */
export function stageKeysFor(discover: Discover | null, trackerType: unknown): StageKeys | null {
  if (discover?.stageKeys) return discover.stageKeys;
  const suffix = typeof trackerType === "string" && Object.hasOwn(SUFFIX, trackerType) ? SUFFIX[trackerType] : null;
  if (!suffix) return null;
  return { source: `source${suffix}`, success: `success${suffix}`, failure: `failure${suffix}`, hold: `hold${suffix}`, queue: `queue${suffix}` };
}

/** This tracker's advanced step keys: the schema's `advanced` flag, scoped to `trackerType` (or unscoped). */
function advancedStepKeys(trackerType: unknown): string[] {
  return CONFIG_SCHEMA.filter(
    (e) => e.advanced && e.path.length === 4 && e.path[0] === "tracker" && e.path[1] === "pipeline" && e.path[2] === "*" && (!e.scope || e.scope.includes(String(trackerType))),
  ).map((e) => e.path[3]);
}

/**
 * The advanced step keys that apply to `trackerType` and are actually set on `step`: not
 * undefined/"", and different from the schema entry's default (`maxMinutes: 0` counts, the
 * default `maxMinutes: 120` doesn't). Stage keys come from `keys.hold`/`keys.queue`.
 */
export function advancedSet(step: Record<string, unknown>, trackerType: unknown, keys: StageKeys | null): string[] {
  const candidates = new Set(advancedStepKeys(trackerType));
  if (keys) {
    candidates.add(keys.hold);
    candidates.add(keys.queue);
  }
  return [...candidates].filter((k) => {
    const v = step[k];
    if (v === undefined || v === "") return false;
    return v !== stepEntry(k)?.default;
  });
}

/**
 * The pipeline-step subset of src/config.js `validateRawConfig`, same wording, each tagged with the
 * step index it belongs to (a duplicate id → the later occurrence). Display only: the server's 422
 * stays authoritative.
 */
function pipelineChecks(raw: unknown): { index: number; error: string }[] {
  const p = isObj(raw) && isObj(raw.tracker) ? raw.tracker.pipeline : undefined;
  if (!Array.isArray(p)) return [];
  const out: { index: number; error: string }[] = [];
  const ids = new Set<unknown>();
  p.forEach((step: any, i) => {
    const push = (error: string) => out.push({ index: i, error });
    if (!isObj(step)) return void push(`config: tracker.pipeline[${i}] must be an object.`);
    const sid = String(step.id);
    if (!step.id) push(`config: every pipeline step needs an "id".`);
    else if (ids.has(step.id)) push(`config: duplicate pipeline step id "${sid}".`);
    ids.add(step.id);
    const { maxAttempts, maxMinutes, idleMinutes } = step;
    if (maxAttempts != null && (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1)) {
      push(`config: pipeline step "${sid}" maxAttempts must be a positive integer.`);
    }
    if (maxMinutes != null && (typeof maxMinutes !== "number" || !Number.isFinite(maxMinutes) || maxMinutes < 0)) {
      push(`config: pipeline step "${sid}" maxMinutes must be a number >= 0 (0 disables the cap).`);
    }
    if (idleMinutes != null && (typeof idleMinutes !== "number" || !Number.isFinite(idleMinutes) || idleMinutes <= 0)) {
      push(`config: pipeline step "${sid}" idleMinutes must be a number > 0.`);
    }
    if (step.bin != null && (typeof step.bin !== "string" || !step.bin.trim())) {
      push(`config: pipeline step "${sid}" bin must be a non-empty string (a name on PATH or an absolute path).`);
    }
    if (step.env != null) {
      if (!isObj(step.env)) push(`config: pipeline step "${sid}" env must be an object of NAME: "value" strings.`);
      else {
        for (const [k, v] of Object.entries(step.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) push(`config: pipeline step "${sid}" env key ${JSON.stringify(k)} is not a valid variable name.`);
          else if (k === "AGENTHOOK_VERDICT_FILE") push(`config: pipeline step "${sid}" env key AGENTHOOK_VERDICT_FILE is reserved (the receiver sets it).`);
          if (typeof v !== "string") push(`config: pipeline step "${sid}" env.${k} must be a string.`);
        }
      }
    }
  });
  return out;
}

/**
 * The checks the top panel lists: the pipeline's (flat, in step order), then the sinks' and the
 * digest's — the same import-free rules src/config.js runs. Display only.
 */
export function clientErrors(raw: unknown): string[] {
  const r = isObj(raw) ? raw : {};
  return [...pipelineChecks(raw).map((c) => c.error), ...sinkErrors(r.sinks), ...digestErrors(r.digest), ...reposErrors(r.repos)];
}

/**
 * Errors per step index, for the Pipeline form's card badges: the client checks by index, plus the
 * server's (`serverErrors`, e.g. a 422's) attributed by `tracker.pipeline[<i>]` → i or
 * `pipeline step "<id>"` → the first step with that id. An error matching no step stays only in the
 * top panel. Duplicates (client and server saying the same thing) are listed once.
 */
export function stepErrors(raw: unknown, serverErrors: string[]): Map<number, string[]> {
  const steps = readSteps(raw);
  const out = new Map<number, string[]>();
  const add = (i: number, e: string) => {
    const list = out.get(i) ?? [];
    if (!list.includes(e)) list.push(e);
    out.set(i, list);
  };
  for (const c of pipelineChecks(raw)) add(c.index, c.error);
  for (const e of serverErrors) {
    const at = /tracker\.pipeline\[(\d+)\]/.exec(e);
    const byId = /pipeline step "([^"]*)"/.exec(e);
    const i = at ? Number(at[1]) : byId ? steps.findIndex((s) => s.id !== undefined && String(s.id) === byId[1]) : -1;
    if (i >= 0 && i < steps.length) add(i, e);
  }
  return out;
}

/** Where a stage picker's options come from, per the `GET /api/discover` outcome. */
export type StageSource = { kind: "loading" } | { kind: "list"; stages: StageOption[] } | { kind: "text"; hint: string };

/** 200 with stages → a picker; 503 → type it (receiver down); anything else → couldn't list. `status` 0 = network error. */
export function stageSource(status: number, body: Discover | null, lang = "en"): StageSource {
  if (status === 200 && body && Array.isArray(body.stages)) return { kind: "list", stages: body.stages };
  if (status === 503) return { kind: "text", hint: translate(lang, "configHelp.stages.typeIt") };
  const detail = (body as any)?.error;
  const why =
    status === 200
      ? translate(lang, "configHelp.stages.noList")
      : status === 0
        ? translate(lang, "configHelp.stages.network")
        : status === 404
          ? translate(lang, "configHelp.stages.unknownProfile")
          : status === 504
            ? translate(lang, "configHelp.stages.timedOut")
            : status === 502
              ? typeof detail === "string"
                ? translate(lang, "configHelp.stages.receiverErrorDetail", { error: detail })
                : translate(lang, "configHelp.stages.receiverError")
              : translate(lang, "configHelp.stages.status", { status });
  return { kind: "text", hint: translate(lang, "configHelp.stages.failed", { why }) };
}

export function discoverUrl(profile: string): string {
  return `/api/discover?${new URLSearchParams({ profile })}`;
}

/** `GET /api/sandbox-readiness` for the form's current backend (checked even before it's saved). */
export function sandboxReadinessUrl(profile: string, type: string): string {
  return `/api/sandbox-readiness?${new URLSearchParams(type ? { profile, type } : { profile })}`;
}

/** `raw[key]` when it is an object (the `tracker` / `forge` / `ingress` block), else undefined. */
export function readBlock(raw: unknown, key: "tracker" | "forge" | "ingress"): Record<string, unknown> | undefined {
  return isObj(raw) && isObj(raw[key]) ? raw[key] : undefined;
}

/** Each block's keys rendered on their own (the type picker, the pipeline), not by the schema list. */
const OWN_FIELD = new Set(["tracker.type", "tracker.pipeline", "forge.type", "ingress.type"]);

/**
 * The Tracker / Forge / Ingress tab's fields, straight from the config schema: the section's
 * `<block>.<key>` entries minus the container, the type, the pipeline and nested objects (`auth` —
 * a flat control can't edit one; it stays in Raw), kept when their `scope` includes `trackerType`
 * (or has none), split by the `advanced` flag. A new scoped schema entry adds a field.
 * For `forge`, pass the forge type: `forge.*` scopes name forge types (github / gitlab).
 */
export function sectionFields(section: "tracker" | "forge" | "ingress", trackerType: unknown): { common: SchemaEntry[]; advanced: SchemaEntry[] } {
  const list = CONFIG_SCHEMA.filter(
    (e) => e.section === section && e.path.length === 2 && e.type !== "object" && !OWN_FIELD.has(e.path.join(".")) && (!e.scope || e.scope.includes(String(trackerType))),
  );
  return { common: list.filter((e) => !e.advanced), advanced: list.filter((e) => e.advanced) };
}

/** The keys each ingress adapter reads (src/ingress/ngrok.js, cloudflared.js, tailscale.js, manual.js); the rest stay in the file, hidden. */
const INGRESS_KEYS: Record<string, string[]> = { ngrok: ["authtoken", "domain", "webAddr"], cloudflared: ["tunnel", "hostname"], tailscale: [], manual: ["url"], hosted: ["url"] };

/** `sectionFields("ingress")` narrowed to what the effective ingress type reads; an unknown type shows none. */
export function ingressFields(type: string): { common: SchemaEntry[]; advanced: SchemaEntry[] } {
  const keys = Object.hasOwn(INGRESS_KEYS, type) ? INGRESS_KEYS[type] : [];
  const { common, advanced } = sectionFields("ingress", undefined);
  const keep = (e: SchemaEntry) => keys.includes(e.path[1]);
  return { common: common.filter(keep), advanced: advanced.filter(keep) };
}

/** The effective ingress type: absent block or type → `manual` (src/config.js). */
export const ingressType = (raw: unknown): string => {
  const t = readBlock(raw, "ingress")?.type;
  return typeof t === "string" && t !== "" ? t : "manual";
};

/** How many of `entries` are set on `block`: not undefined/"" and not the entry's default (an "Advanced · N set" count). */
export function setCount(block: Record<string, unknown> | undefined, entries: SchemaEntry[]): number {
  return entries.filter((e) => {
    const v = block?.[e.path[1]];
    return v !== undefined && v !== "" && v !== e.default;
  }).length;
}

/** A secret field's state: absent, a `${VAR}` ref, verification disabled (`false`), or a literal (never echoed). */
export type SecretState = "absent" | "ref" | "disabled" | "literal";

export function secretState(value: unknown): SecretState {
  if (value === undefined || value === null || value === "") return "absent";
  if (value === false) return "disabled";
  return isEnvRef(value) ? "ref" : "literal";
}

/** A draft still on its way to a `${VAR}` ref ("$", "${TO", "${TOKEN}") — shown in clear text while typed. */
export const refInProgress = (s: string): boolean => /^\$(\{[A-Z0-9_]*\}?)?$/.test(s);

/**
 * The `forge.ciTarget` picker: the agent (non-manual) step ids it may name (src/config.js), and the
 * step an unset target bounces to — the first `createsWorktree` step (src/dispatch.js), else null.
 */
export function ciTargetOptions(raw: unknown): { ids: string[]; defaultId: string | null } {
  const steps = readSteps(raw);
  const ids = steps.filter((s) => !s.manual && typeof s.id === "string" && s.id !== "").map((s) => s.id as string);
  const wt = steps.find((s) => s.createsWorktree);
  return { ids, defaultId: wt ? fieldText(wt.id) || null : null };
}

const SINKS: JSONPath = ["sinks"];

/** `sinks` as-is (each element untouched, a non-object included); [] when absent or not an array. */
export function readSinks(raw: unknown): unknown[] {
  const s = isObj(raw) ? raw.sinks : undefined;
  return Array.isArray(s) ? s : [];
}

/** A sink element the form can edit: an object whose `type` is slack / telegram / webhook; else null (read-only card). */
export function knownSink(s: unknown): Record<string, unknown> | null {
  return isObj(s) && typeof s.type === "string" && Object.hasOwn(SINK_REQUIRED, s.type) ? s : null;
}

export const sinkPath = (i: number, key: string): JSONPath => [...SINKS, i, key];

/** Append `{ "type": "slack", "url": "" }` (creating `sinks` when absent). */
export function addSink(text: string): string {
  const raw = JSON.parse(text);
  const value = { type: "slack", url: "" };
  if (!isObj(raw) || !Array.isArray(raw.sinks)) return setPath(text, SINKS, [value]);
  return applyEdits(text, modify(text, [...SINKS, raw.sinks.length], value, { isArrayInsertion: true, formattingOptions: formattingFor(text) }));
}

/** The list of `errors` that name `sinks[i]` (sinkErrors' wording), for that sink's card. */
export const errorsForSink = (errors: string[], i: number): string[] => errors.filter((e) => e.startsWith(`config: sinks[${i}]`));

export function removeSink(text: string, i: number): string {
  return setPath(text, [...SINKS, i], undefined);
}

/** Swap sink `i` with its neighbour, verbatim (`swapItems`). */
export function moveSink(text: string, i: number, dir: -1 | 1): string {
  return swapItems(text, SINKS, i, dir);
}

/** The event names the sink form offers as checkboxes (docs/events.md); the file may name others. */
export const SINK_EVENTS = [
  "blocked",
  "failed",
  "move_refused",
  "pipeline_done",
  "merged",
  "ci_red",
  "ci_green",
  "enqueued",
  "pulled",
  "run_start",
  "run_end",
  "overlap_held",
  "overlap_released",
  "epic_skipped",
  "dequeued",
  "dismissed",
] as const;

export { DEFAULT_SINK_EVENTS };

/**
 * A sink's event filter as checkboxes: `events` absent → the defaults, checked (`isDefault`); an
 * array → its names; the boxes are `SINK_EVENTS` plus any name the file lists that isn't on it.
 * `invalid` = `events` is set but not a string array (left to Raw).
 */
export function sinkEvents(events: unknown): { names: string[]; checked: Set<string>; isDefault: boolean; invalid: boolean } {
  const isDefault = events === undefined;
  const invalid = !isDefault && !(Array.isArray(events) && events.every((e) => typeof e === "string"));
  const list: string[] = isDefault ? DEFAULT_SINK_EVENTS : invalid ? [] : (events as string[]);
  const names: string[] = [...SINK_EVENTS];
  for (const e of list) if (!names.includes(e)) names.push(e);
  return { names, checked: new Set(list), isDefault, invalid };
}

/** Toggle one event: always writes an explicit array (from the defaults when `events` was absent), keeping every other name. */
export function sinkEventEdit(text: string, i: number, events: unknown, name: string, checked: boolean): string {
  const base: string[] = Array.isArray(events) ? events.filter((e): e is string => typeof e === "string") : [...DEFAULT_SINK_EVENTS];
  const next = checked ? (base.includes(name) ? base : [...base, name]) : base.filter((e) => e !== name);
  return setPath(text, sinkPath(i, "events"), next);
}

/** Remove `raw[key]` when an edit left it an empty object (the digest block, like `identityEdit`'s `ui`). */
export function dropEmptyBlock(text: string, key: string): string {
  const raw = JSON.parse(text);
  return isObj(raw) && isObj(raw[key]) && Object.keys(raw[key]).length === 0 ? setPath(text, [key], undefined) : text;
}

export { pricingErrors };
export { quotaErrors };

/** One `pricing` row as typed: the model pattern and its four $/Mtok rates ("" = unset). */
export type PricingRow = { pattern: string; input: string; output: string; cacheRead: string; cacheWrite: string };
export const PRICING_RATES = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** `pricing` as editable rows (insertion order); a non-object `pricing` reads as no rows. */
export function pricingRows(pricing: unknown): PricingRow[] {
  if (!isObj(pricing)) return [];
  return Object.entries(pricing).map(([pattern, r]) => {
    const rate = isObj(r) ? r : {};
    const cell = (k: string) => (rate[k] === undefined ? "" : fieldText(rate[k]));
    return { pattern, input: cell("input"), output: cell("output"), cacheRead: cell("cacheRead"), cacheWrite: cell("cacheWrite") };
  });
}

/**
 * `pricing` edit: a blank-pattern row is dropped, a blank rate is left unset, a numeric one is
 * written as a number and anything else verbatim (so `pricingErrors` flags it, never a silent
 * drop). No rows left removes `pricing`; absent stays absent (the `envEdit` guard).
 */
export function pricingEdit(text: string, rows: PricingRow[]): string {
  const clean = rows.filter((r) => r.pattern.trim() !== "");
  if (clean.length === 0) {
    const raw = JSON.parse(text);
    return isObj(raw) && raw.pricing !== undefined ? setPath(text, ["pricing"], undefined) : text;
  }
  const value = Object.fromEntries(
    clean.map((r) => {
      const rate: Record<string, unknown> = {};
      for (const k of PRICING_RATES) {
        const t = r[k].trim();
        if (t === "") continue;
        const n = Number(t);
        rate[k] = Number.isFinite(n) ? n : t;
      }
      return [r.pattern.trim(), rate];
    }),
  );
  return setPath(text, ["pricing"], value);
}

/** The `energy` block when it is an object, else undefined. */
export function readEnergy(raw: unknown): Record<string, unknown> | undefined {
  return isObj(raw) && isObj(raw.energy) ? raw.energy : undefined;
}

/**
 * An `energy` edit's cleanup: an emptied `energy.source` is removed, then an emptied `energy`
 * (like `dropEmptyBlock`'s digest). A source `type` change also drops the old type's own key, so
 * switching hwmon → watts never leaves a stray `name` for `energyErrors` to reject.
 */
export function energyEdit(text: string, next: string): string {
  const before = JSON.parse(text);
  const raw = JSON.parse(next);
  const was = isObj(before) && isObj(before.energy) && isObj(before.energy.source) ? before.energy.source.type : undefined;
  const src = isObj(raw) && isObj(raw.energy) && isObj(raw.energy.source) ? raw.energy.source : undefined;
  let out = next;
  if (src && src.type !== was) {
    const own: Record<string, string> = { hwmon: "name", command: "cmd", watts: "watts" };
    for (const [t, k] of Object.entries(own)) if (t !== src.type && src[k] !== undefined) out = setPath(out, ["energy", "source", k], undefined);
  }
  const after = JSON.parse(out);
  if (isObj(after) && isObj(after.energy) && isObj(after.energy.source) && Object.keys(after.energy.source).length === 0) out = setPath(out, ["energy", "source"], undefined);
  return dropEmptyBlock(out, "energy");
}

/** The `quota` block when it is an object, else undefined. */
export function readQuotaConfig(raw: unknown): Record<string, unknown> | undefined {
  return isObj(raw) && isObj(raw.quota) ? raw.quota : undefined;
}

/** The `digest` block when it is an object, else undefined. */
export function readDigest(raw: unknown): Record<string, unknown> | undefined {
  return isObj(raw) && isObj(raw.digest) ? raw.digest : undefined;
}

const REPOS: JSONPath = ["repos"];

export { reposErrors };

/** `repos` as-is (each element untouched, a non-object element included); [] when absent or not an array. */
export function readRepos(raw: unknown): unknown[] {
  const r = isObj(raw) ? raw.repos : undefined;
  return Array.isArray(r) ? r : [];
}

/** A repo element the form can edit: an object; else null (read-only "edit in Raw" card). */
export function knownRepo(r: unknown): Record<string, unknown> | null {
  return isObj(r) ? r : null;
}

export const repoFieldPath = (i: number, key: string): JSONPath => [...REPOS, i, key];

/**
 * Append a repo card. Absent `repos` seeds `[{ id: "default", path: <repoPath or "">, default: true }]`
 * — the same default the receiver synthesizes on its own (src/config.js `resolveRepos`), so routing
 * doesn't change. A later add appends `{ id: "", path: "" }`.
 */
export function addRepo(text: string): string {
  const raw = JSON.parse(text);
  if (!isObj(raw) || !Array.isArray(raw.repos)) {
    const seedPath = isObj(raw) && typeof raw.repoPath === "string" ? raw.repoPath : "";
    return setPath(text, REPOS, [{ id: "default", path: seedPath, default: true }]);
  }
  const value = { id: "", path: "" };
  return applyEdits(text, modify(text, [...REPOS, raw.repos.length], value, { isArrayInsertion: true, formattingOptions: formattingFor(text) }));
}

/** Remove repo `i`; removing the last one deletes the `repos` key entirely (an empty array is invalid). */
export function removeRepo(text: string, i: number): string {
  const repos = readRepos(JSON.parse(text));
  if (repos.length <= 1) return setPath(text, REPOS, undefined);
  return setPath(text, [...REPOS, i], undefined);
}

/** Swap repo `i` with its neighbour, verbatim (`swapItems`). */
export function moveRepo(text: string, i: number, dir: -1 | 1): string {
  return swapItems(text, REPOS, i, dir);
}

/**
 * Check `default` on repo `i`: sets it there and clears `default` on every other repo card, in one
 * edit. Uncheck removes the key (not `false`) — only one edit, applied back to front so earlier
 * offsets stay valid as later edits are applied.
 */
export function repoDefaultEdit(text: string, repos: unknown[], i: number, checked: boolean): string {
  let next = text;
  for (let j = repos.length - 1; j >= 0; j--) {
    if (j === i) continue;
    const r = repos[j];
    if (isObj(r) && r.default === true) next = setPath(next, repoFieldPath(j, "default"), undefined);
  }
  return setPath(next, repoFieldPath(i, "default"), checked ? true : undefined);
}

/** The list of `errors` that name `repos[i]` or `repos "<id>"` for that repo's card. */
export function errorsForRepo(errors: string[], repos: unknown[], i: number): string[] {
  const r = repos[i];
  const id = isObj(r) && typeof r.id === "string" ? r.id : undefined;
  return errors.filter((e) => {
    if (e.startsWith(`config: repos[${i}]`)) return true;
    if (id === undefined) return false;
    if (e.includes(`repos "${id}"`) || e.includes(`and "${id}"`)) return true;
    if (e.includes(`duplicate repos id "${id}"`)) return true;
    if (e.startsWith("config: at most one repo may set default:true") && e.includes(`"${id}"`)) return true;
    return false;
  });
}

/** `current` is a valid string-list field value: unset, or an array of only strings. Any other
 * shape (including a mixed array) is left to Raw. */
export function stringListInvalid(current: unknown): boolean {
  return current !== undefined && !(Array.isArray(current) && current.every((e) => typeof e === "string"));
}

/**
 * Add/remove one entry of a string-list field (`match`, future `lite.descriptionHeadings`): trimmed,
 * non-empty, de-duplicated (case-sensitive). Removing the last entry removes the key. A non-string-
 * array value (including a mixed array) is left untouched (the field shows "edit in Raw" instead).
 */
export function stringListAdd(text: string, path: JSONPath, current: unknown, value: string): string {
  const v = value.trim();
  if (!v || stringListInvalid(current)) return text;
  const list = Array.isArray(current) ? (current as string[]) : [];
  if (list.includes(v)) return text;
  return setPath(text, path, [...list, v]);
}

export function stringListRemove(text: string, path: JSONPath, current: unknown, value: string): string {
  if (stringListInvalid(current)) return text;
  const list = Array.isArray(current) ? (current as string[]) : [];
  const next = list.filter((e) => e !== value);
  return setPath(text, path, next.length ? next : undefined);
}

/** The card lists a config error can sit on: a sink (Integrations), a repo (Repos), a step (Pipeline). */
export type CardList = "sinks" | "repos" | "steps";
export type CardRef = { list: CardList; index: number };

/**
 * The card that renders `error`, by the same rules the cards use: a client sink check naming
 * `sinks[i]` (`errorsForSink`), a client repo check `errorsForRepo` puts on exactly one card (one
 * naming two repos — a route-key clash, two defaults — stays a banner error), and a step error by `stepErrors`' rules (the step's own check, else
 * `tracker.pipeline[i]` / `pipeline step "<id>"`). The sink/repo cards only list client checks, so a
 * server-only sink/repo error stays unattributed. Digest, cross-repo and top-level errors → null.
 */
export function cardFor(error: string, raw: unknown): CardRef | null {
  const r = isObj(raw) ? raw : {};
  const sink = /^config: sinks\[(\d+)\]/.exec(error);
  if (sink && sinkErrors(r.sinks).includes(error)) {
    const index = Number(sink[1]);
    return index < readSinks(raw).length ? { list: "sinks", index } : null;
  }
  const repos = readRepos(raw);
  if (reposErrors(r.repos).includes(error)) {
    const on = repos.flatMap((_, i) => (errorsForRepo([error], repos, i).length > 0 ? [i] : []));
    return on.length === 1 ? { list: "repos", index: on[0] } : null;
  }
  const own = pipelineChecks(raw).find((c) => c.error === error);
  if (own) return { list: "steps", index: own.index };
  for (const [index, list] of stepErrors(raw, [error])) if (list.includes(error)) return { list: "steps", index };
  return null;
}

/**
 * Whether a step's `closeIssue` / `completeTask` checkbox shows: they act only when a task enters
 * the flagged step, so on the last step or a manual one — or anywhere the key is already set, so a
 * set value is never hidden (like `completeOnMerge`). Tracker scoping is the caller's.
 */
export function showTerminalFlag(step: Record<string, unknown>, i: number, count: number, key: "closeIssue" | "completeTask"): boolean {
  return i === count - 1 || step.manual === true || step[key] !== undefined;
}
