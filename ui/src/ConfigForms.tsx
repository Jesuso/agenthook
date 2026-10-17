import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState } from "react";
import type { JSONPath } from "jsonc-parser";
import {
  KNOWN_MODELS,
  STAGE_ROLES,
  DEFAULT_SINK_EVENTS,
  addSink,
  addStep,
  advancedSet,
  boolEdit,
  ciTargetOptions,
  defaultBoolEdit,
  dropEmptyBlock,
  effectiveBool,
  envEdit,
  envRows,
  escalateEdit,
  fieldText,
  identityEdit,
  liteEdit,
  liteHeadingsEdit,
  knownSink,
  moveSink,
  moveStep,
  numberEdit,
  readBasics,
  readDigest,
  readSinks,
  readSteps,
  ingressFields,
  ingressType,
  readBlock,
  refInProgress,
  removeSink,
  removeStep,
  renameEdit,
  secretState,
  sectionFields,
  setCount,
  setPath,
  sinkEventEdit,
  sinkEvents,
  sinkPath,
  stageKeysFor,
  stepPath,
  textEdit,
} from "./configEdit";
import type { Discover, StageKeys, StageOption, StageSource } from "./configEdit";
import { PROFILE_COLORS, PROFILE_EMOJIS, accentStyle } from "./identity";
import { resolveIdentity } from "../../src/identity.js";
import { schemaEntry } from "../../src/config-schema.js";
import type { SchemaEntry } from "../../src/config-schema.js";
import { SECRET_FIELDS } from "../../src/ui/sensitive.js";
import { sinkErrors } from "../../src/sinks-config.js";
import { digestErrors } from "../../src/digest-config.js";
import { HelpTip, ProfileMark } from "./components";

/** The stage-picker feed for the open profile: the discover outcome, `null` before the first fetch. */
export type StagesState = { source: StageSource; body: Discover | null };

type EditProps = { text: string; onEdit: (text: string) => void };

const INPUT = "w-full rounded border border-[var(--color-border)] bg-transparent px-1.5 py-0.5 font-mono text-xs";
const BUTTON = "rounded border border-[var(--color-border)] px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50";

/** The tracker-neutral human label for each stage role; the hint shown beside it is the tracker's real key. */
const ROLE_LABEL: Record<(typeof STAGE_ROLES)[number], string> = {
  source: "Starts when in",
  success: "On success →",
  failure: "On failure →",
  hold: "On hold →",
  queue: "Backlog (queue)",
};

/**
 * Pure: a form field's display, from its config-schema entry (src/config-schema.js) — label, help,
 * the raw key shown in monospace (people search the docs by key), and a placeholder from the
 * entry's `default` ("3 (default)"). A path with no entry falls back to its raw key.
 */
export function fieldMeta(path: JSONPath): { entry: SchemaEntry | undefined; label: string; hint: string; help?: string; placeholder?: string } {
  const entry = schemaEntry(path);
  const hint = String(path[path.length - 1]);
  const placeholder = entry?.placeholder ?? (entry?.default !== undefined ? `${entry.default} (default)` : undefined);
  return { entry, label: entry?.label ?? hint, hint, help: entry?.help, placeholder };
}

/**
 * Label row (label + raw key + HelpTip) over a control. The first child is the control: it gets
 * the label's `id` and `aria-describedby` → the help bubble; any further children follow it.
 */
function Field(props: { label: string; hint?: string; help?: string; error?: string | null; children: React.ReactNode }) {
  const id = useId();
  const controlId = `${id}control`;
  const helpId = props.help ? `${id}help` : undefined;
  const [control, ...rest] = Children.toArray(props.children);
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <span className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
        <label htmlFor={controlId}>
          {props.label}
          {props.hint && <span className="ml-1 font-mono opacity-70">{props.hint}</span>}
        </label>
        {props.help && <HelpTip id={helpId} label={props.label} help={props.help} />}
      </span>
      {isValidElement<Record<string, unknown>>(control) ? cloneElement(control, { id: controlId, "aria-describedby": helpId }) : control}
      {rest}
      {props.error && <span className="text-xs text-status-failed">{props.error}</span>}
    </div>
  );
}

/** Small uppercase group heading over a field grid — the step card's Triggers&lanes/Agent/Limits/Worktree sections. */
function Group(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">{props.title}</h4>
      <div className="grid grid-cols-3 gap-3">{props.children}</div>
    </div>
  );
}

function TextField(props: EditProps & { path: JSONPath; value: unknown; readOnly?: boolean }) {
  const m = fieldMeta(props.path);
  return (
    <Field label={m.label} hint={m.hint} help={m.help}>
      <input
        className={props.readOnly ? `${INPUT} cursor-not-allowed opacity-60` : INPUT}
        name={props.path.join(".")}
        value={fieldText(props.value)}
        placeholder={m.placeholder}
        readOnly={props.readOnly}
        onChange={(e) => !props.readOnly && props.onEdit(textEdit(props.text, props.path, e.target.value))}
      />
    </Field>
  );
}

/**
 * Keeps its own draft so a non-numeric entry stays visible (with the error) instead of being applied.
 * The schema's min/max are HTML hints only — never clamped here; validateRawConfig judges on save.
 */
function NumberField(props: EditProps & { path: JSONPath; value: unknown }) {
  const m = fieldMeta(props.path);
  const shown = fieldText(props.value);
  const [draft, setDraft] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  // Any buffer change (this field's own valid edit, another field, Raw) re-syncs from the buffer.
  useEffect(() => {
    setDraft(shown);
    setError(null);
  }, [props.text]);
  return (
    <Field label={m.label} hint={m.hint} help={m.help} error={error}>
      <input
        className={INPUT}
        name={props.path.join(".")}
        inputMode="decimal"
        min={m.entry?.min}
        max={m.entry?.max}
        placeholder={m.placeholder}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const r = numberEdit(props.text, props.path, e.target.value);
          setError(r.ok ? null : r.error);
          if (r.ok) props.onEdit(r.text);
        }}
      />
    </Field>
  );
}

/**
 * `defaultValue` (a schema `default: true` key — `assigneeFilter`, `redCi`, `greenCi`) shows the
 * effective value (absent = the default) and edits via `defaultBoolEdit`: unchecking writes `false`,
 * checking removes the key again. Without it, `boolEdit` as before.
 */
function CheckField(props: EditProps & { path: JSONPath; value: unknown; explicitFalse?: boolean; defaultValue?: boolean }) {
  const m = fieldMeta(props.path);
  const helpId = useId();
  const dv = props.defaultValue;
  return (
    <div className="flex items-center gap-1 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name={props.path.join(".")}
          aria-describedby={m.help ? helpId : undefined}
          checked={dv === undefined ? props.value === true : effectiveBool(props.value, dv)}
          onChange={(e) =>
            props.onEdit(
              dv === undefined ? boolEdit(props.text, props.path, e.target.checked, props.value, props.explicitFalse) : defaultBoolEdit(props.text, props.path, e.target.checked, dv),
            )
          }
        />
        <span className="text-xs">
          {m.label}
          <span className="ml-1 font-mono opacity-70 text-[var(--color-muted)]">{m.hint}</span>
        </span>
      </label>
      {m.help && <HelpTip id={helpId} label={m.label} help={m.help} />}
    </div>
  );
}

/**
 * First option "(default)" removes the key; an unknown current value stays selectable. `edit`
 * overrides the default `textEdit(path)` write — the escalate/lite rows pass their own (nested
 * cleanup, not a plain key set) while every other caller keeps the default. `required` (a block's
 * `type`) has no removing option — only an unset value shows a disabled "(choose…)".
 */
function SelectField(props: EditProps & { path: JSONPath; value: unknown; edit?: (input: string) => string; required?: boolean }) {
  const m = fieldMeta(props.path);
  const options = m.entry?.options ?? [];
  const cur = fieldText(props.value);
  const extra = cur !== "" && !options.includes(cur);
  const commit = (input: string) => props.onEdit(props.edit ? props.edit(input) : textEdit(props.text, props.path, input));
  return (
    <Field label={m.label} hint={m.hint} help={m.help}>
      <select className={INPUT} name={props.path.join(".")} value={cur} onChange={(e) => commit(e.target.value)}>
        {!props.required ? (
          <option value="">(default)</option>
        ) : (
          cur === "" && (
            <option value="" disabled>
              (choose…)
            </option>
          )
        )}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {extra && <option value={cur}>{cur}</option>}
      </select>
    </Field>
  );
}

const CUSTOM = "__custom__";

/**
 * Model select: known models + "(default)" + "custom…". An unknown current value (or an explicit
 * "custom…" pick) shows a free-text input prefilled with it; rendering never edits the buffer —
 * only typing in the text input does, via `textEdit`, so an unrecognized model is never rewritten.
 */
/** Pure: the select's value and whether to show the custom text input, for a given current value. */
export function modelSelectState(cur: string): { selectValue: string; showCustom: boolean } {
  const known = (KNOWN_MODELS as readonly string[]).includes(cur);
  return { selectValue: known ? cur : cur === "" ? "" : CUSTOM, showCustom: cur !== "" && !known };
}

/** `edit` overrides the default `textEdit(path)` write, same as `SelectField`'s. */
export function ModelField(props: EditProps & { path: JSONPath; value: unknown; edit?: (input: string) => string }) {
  const m = fieldMeta(props.path);
  const cur = fieldText(props.value);
  const [forceCustom, setForceCustom] = useState(false);
  useEffect(() => setForceCustom(false), [props.text]);
  const { selectValue, showCustom: unknownValue } = modelSelectState(cur);
  const showCustom = forceCustom || unknownValue;
  const commit = (input: string) => props.onEdit(props.edit ? props.edit(input) : textEdit(props.text, props.path, input));
  return (
    <Field label={m.label} hint={m.hint} help={m.help}>
      <select
        className={INPUT}
        name={props.path.join(".")}
        value={selectValue}
        onChange={(e) => {
          if (e.target.value === CUSTOM) return setForceCustom(true);
          setForceCustom(false);
          commit(e.target.value);
        }}
      >
        <option value="">(default)</option>
        {KNOWN_MODELS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
        <option value={CUSTOM}>custom…</option>
      </select>
      {showCustom && <input className={`${INPUT} mt-1`} placeholder="model name" value={cur} onChange={(e) => commit(e.target.value)} />}
    </Field>
  );
}

const DIFFICULTIES = ["easy", "medium", "hard"] as const;

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The step's Escalation editor: a model + effort pick per difficulty, wired to `escalateEdit`'s nested cleanup. */
function EscalateGroup(props: EditProps & { i: number; step: Record<string, unknown> }) {
  const escalate = asRecord(props.step.escalate);
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Escalation</h4>
      <div className="flex flex-col gap-3">
        {DIFFICULTIES.map((d) => {
          const row = asRecord(escalate[d]);
          const modelPath: JSONPath = [...stepPath(props.i, "escalate"), d, "model"];
          const effortPath: JSONPath = [...stepPath(props.i, "escalate"), d, "effort"];
          return (
            <div key={d} data-escalate-row={d} className="grid grid-cols-3 gap-3">
              <span className="col-span-3 -mb-1 text-xs font-medium capitalize text-[var(--color-muted)]">{d}</span>
              <ModelField text={props.text} onEdit={props.onEdit} path={modelPath} value={row.model} edit={(input) => escalateEdit(props.text, props.i, d, "model", input)} />
              <SelectField text={props.text} onEdit={props.onEdit} path={effortPath} value={row.effort} edit={(input) => escalateEdit(props.text, props.i, d, "effort", input)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The step's `env` editor: one key/value row each, plus "add variable". Rows are a local draft
 * committed on blur (a blank key is dropped); removing the last row removes `env`.
 */
function EnvField(props: EditProps & { i: number; env: unknown }) {
  const initial = envRows(props.env);
  const [rows, setRows] = useState(initial);
  const key = JSON.stringify(initial);
  useEffect(() => setRows(initial), [key]);
  const m = fieldMeta(stepPath(props.i, "env"));
  const commit = (next: [string, string][]) => props.onEdit(envEdit(props.text, props.i, next));
  const change = (idx: number, col: 0 | 1, value: string) => {
    const next = rows.map((r) => [...r] as [string, string]);
    next[idx][col] = value;
    setRows(next);
  };
  return (
    <div className="col-span-3 flex flex-col gap-1" data-step-env>
      <span className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
        {m.label}
        <span className="ml-1 font-mono opacity-70">{m.hint}</span>
        {m.help && <HelpTip label={m.label} help={m.help} />}
      </span>
      <ul className="flex flex-col gap-1">
        {rows.map(([k, v], idx) => (
          <li key={idx} className="flex items-center gap-1">
            <input className={INPUT} aria-label="variable name" placeholder="NAME" value={k} onChange={(e) => change(idx, 0, e.target.value)} onBlur={() => commit(rows)} />
            <input className={INPUT} aria-label="variable value" placeholder="value or ${VAR}" value={v} onChange={(e) => change(idx, 1, e.target.value)} onBlur={() => commit(rows)} />
            <button type="button" className={BUTTON} aria-label="remove variable" onClick={() => commit(rows.filter((_, j) => j !== idx))}>
              remove
            </button>
          </li>
        ))}
      </ul>
      <div>
        <button type="button" className={BUTTON} onClick={() => setRows([...rows, ["", ""]])}>
          add variable
        </button>
      </div>
    </div>
  );
}

/** `lite.descriptionHeadings`: add / remove / reorder rows. A new heading stays a local draft until it is non-blank. */
function LiteHeadingsField(props: EditProps & { i: number; headings: string[] }) {
  const [draft, setDraft] = useState("");
  const [rows, setRows] = useState(props.headings);
  useEffect(() => setRows(props.headings), [props.headings]);
  const m = fieldMeta([...stepPath(props.i, "lite"), "descriptionHeadings"]);
  const commit = (next: string[]) => props.onEdit(liteHeadingsEdit(props.text, props.i, next));
  const add = () => {
    const h = draft.trim();
    if (!h) return;
    commit([...rows, h]);
    setDraft("");
  };
  return (
    <div className="col-span-3 flex flex-col gap-1" data-lite-headings>
      <span className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
        {m.label}
        <span className="ml-1 font-mono opacity-70">{m.hint}</span>
        {m.help && <HelpTip label={m.label} help={m.help} />}
      </span>
      <ul className="flex flex-col gap-1">
        {rows.map((h, idx) => (
          <li key={idx} className="flex items-center gap-1">
            <input
              className={INPUT}
              value={h}
              onChange={(e) => {
                const next = [...rows];
                next[idx] = e.target.value;
                setRows(next);
              }}
              onBlur={() => commit(rows)}
            />
            <button
              type="button"
              className={BUTTON}
              aria-label="move heading up"
              disabled={idx === 0}
              onClick={() => {
                const next = [...rows];
                [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                commit(next);
              }}
            >
              ↑
            </button>
            <button
              type="button"
              className={BUTTON}
              aria-label="move heading down"
              disabled={idx === rows.length - 1}
              onClick={() => {
                const next = [...rows];
                [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                commit(next);
              }}
            >
              ↓
            </button>
            <button type="button" className={BUTTON} aria-label="remove heading" onClick={() => commit(rows.filter((_, j) => j !== idx))}>
              remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-1">
        <input className={INPUT} placeholder="add heading" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} />
        <button type="button" className={BUTTON} disabled={!draft.trim()} onClick={add}>
          add heading
        </button>
      </div>
    </div>
  );
}

/** The step's Lite-mode editor: the heading list plus a model + effort pick, wired to `liteEdit`/`liteHeadingsEdit`. */
function LiteGroup(props: EditProps & { i: number; step: Record<string, unknown> }) {
  const lite = asRecord(props.step.lite);
  const headings = Array.isArray(lite.descriptionHeadings) ? lite.descriptionHeadings.map((h) => (typeof h === "string" ? h : String(h))) : [];
  const modelPath: JSONPath = [...stepPath(props.i, "lite"), "model"];
  const effortPath: JSONPath = [...stepPath(props.i, "lite"), "effort"];
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Lite mode</h4>
      <div className="grid grid-cols-3 gap-3">
        <LiteHeadingsField text={props.text} onEdit={props.onEdit} i={props.i} headings={headings} />
        <ModelField text={props.text} onEdit={props.onEdit} path={modelPath} value={lite.model} edit={(input) => liteEdit(props.text, props.i, "model", input)} />
        <SelectField text={props.text} onEdit={props.onEdit} path={effortPath} value={lite.effort} edit={(input) => liteEdit(props.text, props.i, "effort", input)} />
      </div>
    </div>
  );
}

/** `label` is the tracker-neutral ROLE_LABEL; the help comes from the tracker's own stage key's schema entry. */
function StageField(props: EditProps & { label: string; stageKey: string; path: JSONPath; value: unknown; stages: StagesState | null }) {
  const help = fieldMeta(props.path).help;
  const cur = fieldText(props.value);
  const src = props.stages?.source ?? { kind: "loading" as const };
  if (src.kind !== "list") {
    return (
      <Field label={props.label} hint={props.stageKey} help={help}>
        <input className={INPUT} name={props.path.join(".")} value={cur} onChange={(e) => props.onEdit(textEdit(props.text, props.path, e.target.value))} />
        <span className="text-xs text-[var(--color-muted)]">{src.kind === "loading" ? "loading stages…" : src.hint}</span>
      </Field>
    );
  }
  const offBoard = cur !== "" && !src.stages.some((s) => s.id === cur);
  return (
    <Field label={props.label} hint={props.stageKey} help={help}>
      <select className={INPUT} name={props.path.join(".")} value={cur} onChange={(e) => props.onEdit(textEdit(props.text, props.path, e.target.value))}>
        <option value="">(none)</option>
        {src.stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
        {offBoard && <option value={cur}>{cur} (not on board)</option>}
      </select>
    </Field>
  );
}

const labelFor = (id: string, list: StageOption[] | null): string => list?.find((s) => s.id === id)?.label ?? id;

/**
 * Pure: a step's one-line summary, shown in every card's header —
 * `kind · <source> → <success> / <failure> · manual · worktree · drain · model · effort`, each part
 * omitted when absent (model / effort only when the step overrides them). Lanes read as the discovered
 * stage names, else the raw value. The id sits beside it in the header, so it isn't repeated here.
 * `advancedCount` (from `advancedSet`), when > 0, appends "+N advanced"; 0/omitted leaves the
 * summary unchanged from before the Advanced section existed.
 */
export function summarizeStep(s: Record<string, unknown>, keys: StageKeys | null, stageList: StageOption[] | null, advancedCount = 0): string {
  const parts: string[] = [];
  const kind = fieldText(s.kind);
  if (kind) parts.push(kind);
  if (keys) {
    const [src, succ, fail] = [keys.source, keys.success, keys.failure].map((k) => fieldText(s[k]));
    let lane = src ? labelFor(src, stageList) : "";
    if (succ || fail) lane += `${lane ? " " : ""}→ ${succ ? labelFor(succ, stageList) : "—"}`;
    if (fail) lane += ` / ${labelFor(fail, stageList)}`;
    if (lane) parts.push(lane);
  }
  if (s.manual === true) parts.push("manual");
  if (s.createsWorktree === true) parts.push("worktree");
  if (s.drainWorktree === true) parts.push("drain");
  for (const k of ["model", "effort"] as const) {
    const v = fieldText(s[k]);
    if (v) parts.push(v);
  }
  if (advancedCount > 0) parts.push(`+${advancedCount} advanced`);
  return parts.join(" · ");
}

export function BasicsForm(props: EditProps & { raw: unknown; stateKey: string }) {
  const b = readBasics(props.raw);
  const edit = { text: props.text, onEdit: props.onEdit };
  const name = fieldMeta(["name"]);
  return (
    <div className="max-w-xl rounded border border-[var(--color-border)] p-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 flex flex-col gap-1">
          <Field label={name.label} hint={name.hint} help={name.help}>
            <input
              className={INPUT}
              name="name"
              value={fieldText(b.name)}
              onChange={(e) => props.onEdit(renameEdit(props.text, e.target.value, props.stateKey))}
            />
          </Field>
          <p className="text-xs text-[var(--color-muted)]">
            Display label only. State stays in <span className="font-mono">~/.agenthook/{props.stateKey}/</span> (a rename adds{" "}
            <span className="font-mono">stateId</span> to keep it there).
          </p>
        </div>
        <TextField {...edit} path={["trigger"]} value={b.trigger} />
        <NumberField {...edit} path={["maxConcurrent"]} value={b.maxConcurrent} />
        <NumberField {...edit} path={["port"]} value={b.port} />
        <AppearanceFields text={props.text} onEdit={props.onEdit} ui={b.ui} stateKey={props.stateKey} />
        <div className="col-span-2 flex flex-col gap-1">
          <CheckField {...edit} path={["fullAuto"]} value={b.fullAuto} explicitFalse />
          <p className="text-xs text-status-held">
            fullAuto runs agents with --dangerously-skip-permissions: a verified webhook runs unsandboxed code on this host.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The profile's Appearance: a colour from the palette and an emoji from the curated list
 * (`ui.color` / `ui.emoji`). "Automatic" removes the key, so the identity derives from the state
 * key again. The receiver reports it in its heartbeat, so a save shows up after its next restart.
 */
export function AppearanceFields(props: EditProps & { ui: { color?: unknown; emoji?: unknown } | undefined; stateKey: string }) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const color = typeof props.ui?.color === "string" ? props.ui.color : undefined;
  const emoji = typeof props.ui?.emoji === "string" ? props.ui.emoji : undefined;
  const shown = resolveIdentity(props.stateKey, props.ui);
  const pick = (field: "color" | "emoji", v: string | undefined) => props.onEdit(identityEdit(props.text, field, v));
  const OPTION = "rounded border px-1.5 py-0.5 text-xs";
  const [ui, colorMeta, emojiMeta] = [["ui"], ["ui", "color"], ["ui", "emoji"]].map(fieldMeta);
  const colorHelp = useId();
  const emojiHelp = useId();
  /** A sub-field's label + raw key + HelpTip (its control carries `aria-describedby` → `helpId`). */
  const subLabel = (m: ReturnType<typeof fieldMeta>, helpId: string) => (
    <span className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
      {m.label}
      <span className="font-mono opacity-70">{m.hint}</span>
      {m.help && <HelpTip id={helpId} label={m.label} help={m.help} />}
    </span>
  );
  return (
    <div className="col-span-2 flex flex-col gap-2" data-appearance>
      <span className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
        {ui.label} <span className="ml-1 font-mono opacity-70">{ui.hint}</span>
        {ui.help && <HelpTip label={ui.label} help={ui.help} />}
      </span>
      <div className="flex items-center gap-3">
        <ProfileMark p={shown} />
        <span className="text-xs text-[var(--color-muted)]">
          {color || emoji ? "custom" : "automatic"} · shows on Home and the app bar after the receiver restarts
        </span>
      </div>
      {subLabel(colorMeta, colorHelp)}
      <div role="radiogroup" aria-label="profile colour" aria-describedby={colorHelp} className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          role="radio"
          aria-checked={color === undefined}
          className={`${OPTION} ${color === undefined ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"}`}
          onClick={() => pick("color", undefined)}
        >
          automatic
        </button>
        {PROFILE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={c}
            title={c}
            data-color={c}
            style={accentStyle(c)}
            className={`size-6 rounded-full bg-[var(--profile-accent)] ring-offset-1 ring-offset-[var(--color-surface)] ${color === c ? "ring-2 ring-[var(--color-fg)]" : "ring-1 ring-[var(--color-border)]"}`}
            onClick={() => pick("color", c)}
          />
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          {subLabel(emojiMeta, emojiHelp)}
          <button type="button" className={BUTTON} aria-expanded={emojiOpen} aria-describedby={emojiHelp} onClick={() => setEmojiOpen((o) => !o)}>
            {emojiOpen ? "Hide emoji" : "Choose emoji"}
          </button>
        </div>
        {emojiOpen && (
          <div role="radiogroup" aria-label="profile emoji" aria-describedby={emojiHelp} className="grid max-h-56 max-w-md grid-cols-10 gap-1 overflow-y-auto rounded border border-[var(--color-border-subtle)] p-1">
            {PROFILE_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={emoji === e}
                aria-label={e}
                data-emoji={e}
                className={`rounded border py-0.5 text-base ${emoji === e ? "border-[var(--color-accent)] bg-[var(--color-surface-raised)]" : "border-transparent hover:border-[var(--color-border)]"}`}
                onClick={() => pick("emoji", e)}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Pure: the open-card set after `moveStep(i, dir)` — the two swapped cards keep their own state. */
export function openAfterMove(open: ReadonlySet<number>, i: number, dir: -1 | 1): Set<number> {
  const j = i + dir;
  return new Set([...open].map((k) => (k === i ? j : k === j ? i : k)));
}

/** Pure: the open-card set after `removeStep(i)` — later cards shift up one. */
export function openAfterRemove(open: ReadonlySet<number>, i: number): Set<number> {
  return new Set([...open].filter((k) => k !== i).map((k) => (k > i ? k - 1 : k)));
}

/**
 * The ordered step list: ↑/↓/remove per card and "+ Add step". Only `lite`/`escalate`, `//`
 * comment keys and unknown keys are left to Raw; every other step key has a field, split into the
 * common section and a collapsed `<details data-step-advanced>` per the schema's `advanced` flag.
 * Every card starts collapsed to its header (id + `summarizeStep`); "+ Add step" opens the new one,
 * a card whose step gains an error (`errors`, from `stepErrors`) opens itself and keeps a red badge,
 * and `focus` (a graph click) opens + scrolls to the step with that id. All of it is view state —
 * nothing here edits the buffer except the fields and the ↑/↓/remove/add buttons.
 */
export function PipelineForm(
  props: EditProps & {
    raw: unknown;
    stages: StagesState | null;
    onRefresh: () => void;
    errors?: Map<number, string[]>;
    focus?: { id: string; nonce: number } | null;
  },
) {
  const steps = readSteps(props.raw);
  const tracker = (props.raw as any)?.tracker?.type;
  const keys = stageKeysFor(props.stages?.body ?? null, tracker);
  const stageList = props.stages?.source.kind === "list" ? props.stages.source.stages : null;
  const roleAdvanced = (role: (typeof STAGE_ROLES)[number]) => !!keys && fieldMeta(["tracker", "pipeline", "*", keys[role]]).entry?.advanced === true;
  const commonRoles = STAGE_ROLES.filter((role) => !roleAdvanced(role));
  const advancedRoles = STAGE_ROLES.filter((role) => roleAdvanced(role));
  const closeIssueEntry = fieldMeta(["tracker", "pipeline", "*", "closeIssue"]).entry;
  const completeTaskEntry = fieldMeta(["tracker", "pipeline", "*", "completeTask"]).entry;
  const trackerStr = String(tracker);
  const showCloseIssue = !closeIssueEntry?.scope || closeIssueEntry.scope.includes(trackerStr);
  const showCompleteTask = !completeTaskEntry?.scope || completeTaskEntry.scope.includes(trackerStr);
  const edit = { text: props.text, onEdit: props.onEdit };
  const errors = props.errors ?? new Map<number, string[]>();
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const cards = useRef<(HTMLElement | null)[]>([]);
  // A step that goes from no errors to some opens itself (once — the user may collapse it again).
  const errored = useRef<Set<number>>(new Set());
  const errorKey = [...errors.keys()].sort((x, y) => x - y).join(",");
  useEffect(() => {
    const now = new Set(errors.keys());
    const fresh = [...now].filter((i) => !errored.current.has(i));
    errored.current = now;
    if (fresh.length) setOpen((prev) => new Set([...prev, ...fresh]));
  }, [errorKey]);
  useEffect(() => {
    if (!props.focus) return;
    const i = steps.findIndex((s) => fieldText(s.id) === props.focus!.id);
    if (i < 0) return;
    setOpen((prev) => (prev.has(i) ? prev : new Set([...prev, i])));
    cards.current[i]?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [props.focus?.nonce]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-xs text-[var(--color-muted)]">
        <span>
          tracker <span className="font-mono">{fieldText(tracker) || "(unset)"}</span>
        </span>
        <button className={BUTTON} disabled={props.stages?.source.kind === "loading"} onClick={props.onRefresh}>
          Refresh stages
        </button>
        <button className={BUTTON} data-expand-all disabled={!steps.length} onClick={() => setOpen(new Set(steps.map((_, i) => i)))}>
          Expand all
        </button>
        <button className={BUTTON} data-collapse-all disabled={!steps.length} onClick={() => setOpen(new Set())}>
          Collapse all
        </button>
      </div>
      {steps.map((s, i) => {
        const at = (k: string) => stepPath(i, k);
        const isOpen = open.has(i);
        const errs = errors.get(i) ?? [];
        return (
          <section
            key={i}
            ref={(el) => {
              cards.current[i] = el;
            }}
            data-step-card={fieldText(s.id)}
            data-open={isOpen}
            className={`rounded border p-3 ${errs.length ? "border-status-failed" : "border-[var(--color-border)]"}`}
          >
            <div className={isOpen ? "mb-2 flex items-center gap-2" : "flex items-center gap-2"}>
              <button className={BUTTON} aria-label={isOpen ? "collapse step" : "expand step"} aria-expanded={isOpen} onClick={() => toggle(i)}>
                {isOpen ? "▾" : "▸"}
              </button>
              <span className="text-xs text-[var(--color-muted)]">#{i + 1}</span>
              <span className="font-mono text-sm">{fieldText(s.id) || "(no id)"}</span>
              <span
                data-step-summary
                className="min-w-0 truncate font-mono text-xs text-[var(--color-muted)]"
                title={summarizeStep(s, keys, stageList, advancedSet(s, tracker, keys).length)}
              >
                {summarizeStep(s, keys, stageList, advancedSet(s, tracker, keys).length) || "—"}
              </span>
              {errs.length > 0 && (
                <span
                  data-step-error={errs.length}
                  title={errs.join("\n")}
                  className="shrink-0 rounded-full border border-status-failed bg-status-failed-bg px-1.5 text-xs text-status-failed"
                >
                  ! {errs.length}
                </span>
              )}
              <span className="ml-auto flex shrink-0 gap-1">
                <button
                  className={BUTTON}
                  aria-label="move up"
                  disabled={i === 0}
                  onClick={() => {
                    setOpen((prev) => openAfterMove(prev, i, -1));
                    props.onEdit(moveStep(props.text, i, -1));
                  }}
                >
                  ↑
                </button>
                <button
                  className={BUTTON}
                  aria-label="move down"
                  disabled={i === steps.length - 1}
                  onClick={() => {
                    setOpen((prev) => openAfterMove(prev, i, 1));
                    props.onEdit(moveStep(props.text, i, 1));
                  }}
                >
                  ↓
                </button>
                <button
                  className={BUTTON}
                  onClick={() => {
                    if (!window.confirm(`Remove step "${fieldText(s.id) || i + 1}"? Its comment keys go with it.`)) return;
                    setOpen((prev) => openAfterRemove(prev, i));
                    props.onEdit(removeStep(props.text, i));
                  }}
                >
                  remove
                </button>
              </span>
            </div>
            {isOpen && errs.length > 0 && (
              <ul className="mb-2 list-disc pl-4 text-xs text-status-failed">
                {errs.map((e, k) => (
                  <li key={k} className="break-words">
                    {e}
                  </li>
                ))}
              </ul>
            )}
            {isOpen && (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-3 gap-3">
                  <TextField {...edit} path={at("id")} value={s.id} />
                  <SelectField {...edit} path={at("kind")} value={s.kind} />
                  <div className="flex items-end">
                    <CheckField {...edit} path={at("manual")} value={s.manual} />
                  </div>
                </div>
                <Group title="Triggers & lanes">
                  {keys ? (
                    commonRoles.map((role) => (
                      <StageField key={role} {...edit} label={ROLE_LABEL[role]} stageKey={keys[role]} path={at(keys[role])} value={s[keys[role]]} stages={props.stages} />
                    ))
                  ) : (
                    <span className="col-span-3 text-xs text-[var(--color-muted)]">no stage fields for this tracker type — edit stage bindings in Raw</span>
                  )}
                </Group>
                <Group title="Agent">
                  <ModelField {...edit} path={at("model")} value={s.model} />
                  <SelectField {...edit} path={at("effort")} value={s.effort} />
                  <TextField {...edit} path={at("instructionsFile")} value={s.instructionsFile} />
                </Group>
                <Group title="Limits">
                  <NumberField {...edit} path={at("maxAttempts")} value={s.maxAttempts} />
                </Group>
                <Group title="Worktree">
                  <CheckField {...edit} path={at("createsWorktree")} value={s.createsWorktree} />
                  <CheckField {...edit} path={at("drainWorktree")} value={s.drainWorktree} />
                </Group>
                <details data-step-advanced>
                  <summary className="cursor-pointer text-xs uppercase tracking-wide text-[var(--color-muted)]">
                    Advanced · {advancedSet(s, tracker, keys).length} set
                  </summary>
                  <div className="mt-2 flex flex-col gap-3">
                    <div className="grid grid-cols-3 gap-3">
                      <NumberField {...edit} path={at("maxMinutes")} value={s.maxMinutes} />
                      <NumberField {...edit} path={at("idleMinutes")} value={s.idleMinutes} />
                      <NumberField {...edit} path={at("maxConcurrent")} value={s.maxConcurrent} />
                    </div>
                    {keys && advancedRoles.length > 0 && (
                      <div className="grid grid-cols-3 gap-3">
                        {advancedRoles.map((role) => (
                          <StageField key={role} {...edit} label={ROLE_LABEL[role]} stageKey={keys[role]} path={at(keys[role])} value={s[keys[role]]} stages={props.stages} />
                        ))}
                      </div>
                    )}
                    <div className="grid grid-cols-3 gap-3">
                      {(s.manual === true || s.completeOnMerge !== undefined) && (
                        <div className="flex flex-col gap-1">
                          <CheckField {...edit} path={at("completeOnMerge")} value={s.completeOnMerge} />
                          <span className="text-xs text-[var(--color-muted)]">
                            Manual steps only; at most one step may set it.
                            {(() => {
                              const owner = steps.findIndex((st, idx) => idx !== i && st.completeOnMerge === true);
                              return owner >= 0 ? ` Already set on step "${fieldText(steps[owner].id) || owner + 1}".` : "";
                            })()}
                          </span>
                        </div>
                      )}
                      {showCloseIssue && <CheckField {...edit} path={at("closeIssue")} value={s.closeIssue} />}
                      {showCompleteTask && <CheckField {...edit} path={at("completeTask")} value={s.completeTask} />}
                      {(s.manual !== true || s.requireVerdict !== undefined) && (
                        <CheckField {...edit} path={at("requireVerdict")} value={s.requireVerdict} />
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <TextField {...edit} path={at("bin")} value={s.bin} />
                      <EnvField {...edit} i={i} env={s.env} />
                    </div>
                    <EscalateGroup {...edit} i={i} step={s} />
                    <LiteGroup {...edit} i={i} step={s} />
                  </div>
                </details>
              </div>
            )}
          </section>
        );
      })}
      <div>
        <button
          className={BUTTON}
          onClick={() => {
            setOpen((prev) => new Set([...prev, steps.length]));
            props.onEdit(addStep(props.text));
          }}
        >
          + Add step
        </button>
      </div>
    </div>
  );
}

/** SECRET_FIELDS, matched with an array index (or a schema `*`) standing for `[*]`: `["sinks", 0, "url"]` → `sinks[*].url`. */
const SECRET_PATHS = new Set<string>(SECRET_FIELDS);
export const isSecretPath = (path: JSONPath): boolean =>
  SECRET_PATHS.has(
    path
      .map((seg) => (typeof seg === "number" || seg === "*" ? "[*]" : `.${seg}`))
      .join("")
      .slice(1),
  );

/**
 * A secret (`tracker.token`, `*.webhookSecret`, `forge.token`, `ingress.authtoken`, `sinks[*].url` /
 * `sinks[*].botToken`). A `${VAR}` ref is shown and edited as text. A literal already in the file is
 * never put in the DOM — not even in `value` — only a warning naming the path, an empty "replace with
 * ${VAR}" input and Clear. What the user types here is a draft: shown in clear while it is (on its
 * way to) a ref, masked otherwise, with the warning live. `webhookSecret: false` reads "verification disabled" and is left as-is until
 * the user acts. Saving a literal stays allowed.
 */
function SecretField(props: EditProps & { path: JSONPath; value: unknown }) {
  const m = fieldMeta(props.path);
  const at = props.path.join(".");
  const state = secretState(props.value);
  // What the user typed since the buffer last changed elsewhere; null = nothing typed.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    if (draft !== null && draft !== fieldText(props.value)) setDraft(null);
  }, [props.text]);
  const shown = draft ?? (state === "ref" ? String(props.value) : "");
  const masked = shown !== "" && !refInProgress(shown);
  const clear = () => {
    setDraft(null);
    props.onEdit(setPath(props.text, props.path, undefined));
  };
  return (
    <Field label={m.label} hint={m.hint} help={m.help}>
      <input
        className={INPUT}
        name={at}
        type={masked ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        value={shown}
        placeholder={state === "literal" || state === "disabled" ? "replace with ${VAR}" : "${ENV_VAR}"}
        onChange={(e) => {
          setDraft(e.target.value);
          props.onEdit(textEdit(props.text, props.path, e.target.value));
        }}
      />
      {state === "absent" && <span className="text-xs text-[var(--color-muted)]">Put the value in the .env beside the config and reference it here.</span>}
      {(state === "literal" || state === "disabled") && (
        <span data-secret-state={state} className="flex items-center gap-2 text-xs text-status-held">
          {state === "literal" ? (
            <span>
              ⚠ literal secret in <span className="font-mono">{at}</span> — replace with a <span className="font-mono">{"${VAR}"}</span> ref
            </span>
          ) : (
            <span>
              verification disabled (<span className="font-mono">false</span>)
            </span>
          )}
          <button type="button" className={BUTTON} data-secret-clear onClick={clear}>
            Clear
          </button>
        </span>
      )}
    </Field>
  );
}

/** One schema entry's control, by its `type`; secrets get `SecretField`, default-`true` booleans the effective-value checkbox. */
function SchemaField(props: EditProps & { entry: SchemaEntry; value: unknown }) {
  const { entry } = props;
  const edit = { text: props.text, onEdit: props.onEdit };
  if (isSecretPath(entry.path)) return <SecretField {...edit} path={entry.path} value={props.value} />;
  if (entry.type === "boolean") return <CheckField {...edit} path={entry.path} value={props.value} defaultValue={entry.default === true ? true : undefined} />;
  if (entry.type === "enum") return <SelectField {...edit} path={entry.path} value={props.value} />;
  if (entry.type === "number") return <NumberField {...edit} path={entry.path} value={props.value} />;
  return <TextField {...edit} path={entry.path} value={props.value} />;
}

/**
 * A block's schema fields: the common ones in a grid, the `advanced` ones in a collapsed
 * `<details data-advanced>` "Advanced · N set" (the step card's pattern). `render` overrides an
 * entry's control (a note beside it, the ciTarget picker); undefined falls back to `SchemaField`.
 */
function SchemaFields(
  props: EditProps & {
    fields: { common: SchemaEntry[]; advanced: SchemaEntry[] };
    block: Record<string, unknown> | undefined;
    render?: (e: SchemaEntry, value: unknown) => React.ReactNode | undefined;
  },
) {
  const one = (e: SchemaEntry) => {
    const value = props.block?.[e.path[1]];
    return <div key={e.path.join(".")}>{props.render?.(e, value) ?? <SchemaField text={props.text} onEdit={props.onEdit} entry={e} value={value} />}</div>;
  };
  return (
    <>
      {props.fields.common.length > 0 && <div className="grid grid-cols-2 gap-3">{props.fields.common.map(one)}</div>}
      {props.fields.advanced.length > 0 && (
        <details data-advanced>
          <summary className="cursor-pointer text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Advanced · {setCount(props.block, props.fields.advanced)} set
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-3">{props.fields.advanced.map(one)}</div>
        </details>
      )}
    </>
  );
}

const PANEL = "flex max-w-xl flex-col gap-3 rounded border border-[var(--color-border)] p-3";
const NOTE = "text-xs text-[var(--color-muted)]";

/**
 * The `tracker` block minus the pipeline: `type` read-only once set (every step's stage keys depend
 * on it — change it in Raw), a picker only while absent; then the schema entries scoped to that type.
 */
export function TrackerForm(props: EditProps & { raw: unknown }) {
  const block = readBlock(props.raw, "tracker");
  const type = block?.type;
  const edit = { text: props.text, onEdit: props.onEdit };
  return (
    <div className={PANEL} data-tracker-form>
      {type !== undefined ? (
        <div className="flex flex-col gap-1">
          <TextField {...edit} path={["tracker", "type"]} value={type} readOnly />
          <p className={NOTE}>Changing the tracker type invalidates every step's stage keys — do it in Raw.</p>
        </div>
      ) : (
        <SelectField {...edit} path={["tracker", "type"]} value={undefined} required />
      )}
      <SchemaFields
        {...edit}
        fields={sectionFields("tracker", type)}
        block={block}
        render={(e, value) =>
          e.path[1] === "assigneeFilter" ? (
            <div className="flex flex-col gap-1">
              <CheckField {...edit} path={e.path} value={value} defaultValue />
              <p className="text-xs text-status-held">Unchecked, agents act on every item in the project — not only the ones assigned to you.</p>
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

/**
 * `forge.ciTarget`: the agent (non-manual) step ids, "(default — …)" removing the key. A current value
 * that isn't one stays selectable and is flagged with the config-load rule.
 */
function CiTargetField(props: EditProps & { raw: unknown; value: unknown }) {
  const path = ["forge", "ciTarget"];
  const m = fieldMeta(path);
  const { ids, defaultId } = ciTargetOptions(props.raw);
  const cur = fieldText(props.value);
  const invalid = cur !== "" && !ids.includes(cur);
  return (
    <Field label={m.label} hint={m.hint} help={m.help} error={invalid ? `"${cur}" must be an agent (non-manual) pipeline step id` : null}>
      <select className={INPUT} name="forge.ciTarget" value={cur} onChange={(e) => props.onEdit(textEdit(props.text, path, e.target.value))}>
        <option value="">{defaultId ? `(default — the createsWorktree step: ${defaultId})` : "(default — no createsWorktree step)"}</option>
        {ids.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
        {invalid && <option value={cur}>{cur} (not an agent step)</option>}
      </select>
      <span className={NOTE}>Must be an agent (non-manual) pipeline step id; unset = the createsWorktree step.</span>
    </Field>
  );
}

/** The optional `forge` block: Add (`{"type":"github"}`) when absent; its schema fields and Remove (confirmed) when present. */
export function ForgeForm(props: EditProps & { raw: unknown }) {
  const block = readBlock(props.raw, "forge");
  const edit = { text: props.text, onEdit: props.onEdit };
  if (!block) {
    return (
      <div className={PANEL} data-forge-form>
        <p className="text-sm">No forge configured.</p>
        <p className={NOTE}>A forge watches the agent PRs: a merged PR completes its task, red CI sends it back for changes.</p>
        <div>
          <button className={BUTTON} data-add-forge onClick={() => props.onEdit(setPath(props.text, ["forge"], { type: "github" }))}>
            Add GitHub forge
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={PANEL} data-forge-form>
      <SelectField {...edit} path={["forge", "type"]} value={block.type} required />
      <SchemaFields
        {...edit}
        fields={sectionFields("forge", undefined)}
        block={block}
        render={(e, value) => (e.path[1] === "ciTarget" ? <CiTargetField {...edit} raw={props.raw} value={value} /> : undefined)}
      />
      <div>
        <button
          className={BUTTON}
          data-remove-forge
          onClick={() => {
            if (!window.confirm("Remove the forge block? Every forge key (type, token, webhook secret, CI settings) is deleted.")) return;
            props.onEdit(setPath(props.text, ["forge"], undefined));
          }}
        >
          Remove forge block
        </button>
      </div>
    </div>
  );
}

/**
 * The `ingress` block. Absent (block or type) = manual. The type picker writes `ingress.type`
 * (creating the block); switching type only changes which fields show — the other type's keys stay.
 */
export function IngressForm(props: EditProps & { raw: unknown }) {
  const block = readBlock(props.raw, "ingress");
  const type = ingressType(props.raw);
  const edit = { text: props.text, onEdit: props.onEdit };
  const fields = ingressFields(type);
  return (
    <div className={PANEL} data-ingress-form>
      <div className="flex flex-col gap-1">
        <SelectField {...edit} path={["ingress", "type"]} value={type} required />
        {(block?.type === undefined || block.type === "") && <p className={NOTE}>No ingress type set — absent = manual.</p>}
      </div>
      {fields.common.length + fields.advanced.length === 0 && <p className={NOTE}>No form fields for ingress "{type}" — edit it in Raw.</p>}
      <SchemaFields
        {...edit}
        fields={fields}
        block={block}
        render={(e, value) =>
          e.path[1] === "domain" ? (
            <div className="flex flex-col gap-1">
              <TextField {...edit} path={e.path} value={value} />
              <p className={NOTE}>Unset = a new public URL on every start.</p>
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

/** The list of `errors` that name `sinks[i]` (sinkErrors' wording), for that sink's card. */
const errorsForSink = (errors: string[], i: number): string[] => errors.filter((e) => e.startsWith(`config: sinks[${i}]`));

function ErrorList(props: { errors: string[] }) {
  if (!props.errors.length) return null;
  return (
    <ul className="list-disc pl-4 text-xs text-status-failed">
      {props.errors.map((e, k) => (
        <li key={k} className="break-words">
          {e}
        </li>
      ))}
    </ul>
  );
}

/**
 * A sink's event filter: a checkbox per `sinkEvents` name. Absent `events` shows the defaults checked
 * ("default"); any toggle writes an explicit array; "Use default" removes the key. A name the file
 * lists that isn't offered is shown checked and kept. A non-array `events` is left to Raw.
 */
function SinkEventsField(props: EditProps & { index: number; value: unknown }) {
  const m = fieldMeta(sinkPath(props.index, "events"));
  const helpId = useId();
  const ev = sinkEvents(props.value);
  return (
    <div className="flex flex-col gap-1 text-sm" data-sink-events>
      <span className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
        {m.label}
        <span className="ml-1 font-mono opacity-70">{m.hint}</span>
        {m.help && <HelpTip id={helpId} label={m.label} help={m.help} />}
        {ev.isDefault ? (
          <span data-sink-events-default-note className="ml-2">
            default
          </span>
        ) : (
          <button type="button" className={`${BUTTON} ml-2`} data-sink-events-default onClick={() => props.onEdit(setPath(props.text, sinkPath(props.index, "events"), undefined))}>
            Use default
          </button>
        )}
      </span>
      {ev.invalid ? (
        <span className={NOTE}>events is not a list of names — edit it in Raw.</span>
      ) : (
        <div role="group" aria-label="events" aria-describedby={m.help ? helpId : undefined} className="grid grid-cols-3 gap-x-3 gap-y-0.5">
          {ev.names.map((name) => (
            <label key={name} className="flex items-center gap-1.5 font-mono text-xs">
              <input
                type="checkbox"
                data-sink-event={name}
                checked={ev.checked.has(name)}
                onChange={(e) => props.onEdit(sinkEventEdit(props.text, props.index, props.value, name, e.target.checked))}
              />
              {name}
            </label>
          ))}
        </div>
      )}
      {ev.isDefault && <span className={NOTE}>Unset: forwards {DEFAULT_SINK_EVENTS.join(", ")}.</span>}
    </div>
  );
}

/**
 * One `sinks[i]` card: ↑/↓/remove in the header; a known type gets its type select and that type's
 * fields (switching type only changes which show — the other type's keys stay in the file). An
 * unknown type or a non-object entry is a read-only card — nothing in it is ever rewritten.
 */
function SinkCard(props: EditProps & { index: number; count: number; sink: unknown; errors: string[] }) {
  const i = props.index;
  const edit = { text: props.text, onEdit: props.onEdit };
  const s = knownSink(props.sink);
  const typeName = s ? String(s.type) : "";
  const unknownLabel =
    props.sink !== null && typeof props.sink === "object" && !Array.isArray(props.sink)
      ? `unknown sink type ${JSON.stringify((props.sink as Record<string, unknown>).type ?? null)}`
      : "not a sink object";
  return (
    <section data-sink-card={i} data-sink-unknown={s ? undefined : ""} className={`flex flex-col gap-2 rounded border p-3 ${props.errors.length ? "border-status-failed" : "border-[var(--color-border)]"}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--color-muted)]">#{i + 1}</span>
        <span className="font-mono text-sm">{s ? typeName : "?"}</span>
        <span className="ml-auto flex shrink-0 gap-1">
          <button className={BUTTON} aria-label="move sink up" disabled={i === 0} onClick={() => props.onEdit(moveSink(props.text, i, -1))}>
            ↑
          </button>
          <button className={BUTTON} aria-label="move sink down" disabled={i === props.count - 1} onClick={() => props.onEdit(moveSink(props.text, i, 1))}>
            ↓
          </button>
          <button
            className={BUTTON}
            data-remove-sink
            onClick={() => {
              if (!window.confirm(`Remove sink #${i + 1}${s ? ` (${typeName})` : ""}? Its comment keys go with it.`)) return;
              props.onEdit(removeSink(props.text, i));
            }}
          >
            remove
          </button>
        </span>
      </div>
      {!s ? (
        <p className={NOTE}>
          <span className="font-mono">{unknownLabel}</span> — edit in Raw.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <SelectField {...edit} path={sinkPath(i, "type")} value={s.type} required />
            {typeName === "telegram" ? (
              <>
                <SecretField {...edit} path={sinkPath(i, "botToken")} value={s.botToken} />
                <TextField {...edit} path={sinkPath(i, "chatId")} value={s.chatId} />
              </>
            ) : (
              <SecretField {...edit} path={sinkPath(i, "url")} value={s.url} />
            )}
          </div>
          <SinkEventsField {...edit} index={i} value={s.events} />
        </>
      )}
      <ErrorList errors={props.errors} />
    </section>
  );
}

/**
 * The Integrations tab: the `sinks` list (add / remove / reorder, per-type fields, event filter),
 * the optional `digest` block (an emptied block is removed, like `identityEdit`'s `ui`) and the
 * `overlapGuard` opt-in. Each group lists its own client checks; the server's 422 stays authoritative.
 */
export function IntegrationsForm(props: EditProps & { raw: unknown }) {
  const sinks = readSinks(props.raw);
  const digest = readDigest(props.raw);
  const edit = { text: props.text, onEdit: props.onEdit };
  const digestEdit = { text: props.text, onEdit: (next: string) => props.onEdit(dropEmptyBlock(next, "digest")) };
  const raw = props.raw as Record<string, unknown> | null;
  const sinkErrs = sinkErrors(raw?.sinks);
  const budget = fieldMeta(["digest", "maxBudgetUsd"]).entry!;
  return (
    <div className="flex max-w-xl flex-col gap-4" data-integrations-form>
      <div className={PANEL} data-sinks>
        <h3 className="text-sm font-semibold">Sinks</h3>
        <p className={NOTE}>Forward lifecycle events to Slack, Telegram or a webhook. Best-effort: a sink never blocks the pipeline.</p>
        {sinkErrs.length > 0 && sinks.length === 0 && <ErrorList errors={sinkErrs} />}
        {sinks.map((s, i) => (
          <SinkCard key={i} {...edit} index={i} count={sinks.length} sink={s} errors={errorsForSink(sinkErrs, i)} />
        ))}
        <div>
          <button className={BUTTON} data-add-sink onClick={() => props.onEdit(addSink(props.text))}>
            + Add sink
          </button>
        </div>
      </div>
      <div className={PANEL} data-digest>
        <h3 className="text-sm font-semibold">Digest</h3>
        <div className="grid grid-cols-2 gap-3">
          <TextField {...digestEdit} path={["digest", "soul"]} value={digest?.soul} />
          <SelectField {...digestEdit} path={["digest", "access"]} value={digest?.access} />
          <ModelField {...digestEdit} path={["digest", "model"]} value={digest?.model} />
        </div>
        <details data-advanced>
          <summary className="cursor-pointer text-xs uppercase tracking-wide text-[var(--color-muted)]">Advanced · {setCount(digest, [budget])} set</summary>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <NumberField {...digestEdit} path={["digest", "maxBudgetUsd"]} value={digest?.maxBudgetUsd} />
          </div>
        </details>
        <ErrorList errors={digestErrors(raw?.digest)} />
      </div>
      <div className={PANEL} data-overlap-guard>
        <h3 className="text-sm font-semibold">Overlap guard</h3>
        <CheckField {...edit} path={["overlapGuard"]} value={raw?.overlapGuard} />
        <p className={NOTE}>
          A worktree step whose triage-predicted paths overlap another in-flight task's lock waits in its source stage (emits{" "}
          <span className="font-mono">overlap_held</span>), and is re-offered when that task drains, fails or merges (
          <span className="font-mono">overlap_released</span>).
        </p>
      </div>
    </div>
  );
}
