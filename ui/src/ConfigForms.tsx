import { Children, cloneElement, isValidElement, useContext, useEffect, useId, useRef, useState } from "react";
import type { JSONPath } from "jsonc-parser";
import {
  KNOWN_MODELS,
  STAGE_ROLES,
  DEFAULT_SINK_EVENTS,
  addRepo,
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
  pricingEdit,
  pricingErrors,
  energyEdit,
  readEnergy,
  pricingRows,
  quotaErrors,
  readQuotaConfig,
  PRICING_RATES,
  errorsForRepo,
  errorsForSink,
  escalateEdit,
  fieldText,
  identityEdit,
  knownRepo,
  knownSink,
  liteEdit,
  liteHeadingsEdit,
  moveRepo,
  moveSink,
  moveStep,
  numberEdit,
  readBasics,
  readDigest,
  readRepos,
  readSinks,
  readSteps,
  ingressFields,
  ingressType,
  readBlock,
  refInProgress,
  removeRepo,
  removeSink,
  removeStep,
  renameEdit,
  repoDefaultEdit,
  sandboxTypeEdit,
  repoFieldPath,
  reposErrors,
  secretState,
  sectionFields,
  setCount,
  setPath,
  showTerminalFlag,
  sinkEventEdit,
  sinkEvents,
  sinkPath,
  stageKeysFor,
  stepPath,
  stringListAdd,
  stringListInvalid,
  stringListRemove,
  textEdit,
  sandboxReadinessUrl,
} from "./configEdit";
import type { SandboxReadiness } from "./contract";
import type { CardList, Discover, PricingRow, StageKeys, StageOption, StageSource } from "./configEdit";
import { PROFILE_COLORS, PROFILE_EMOJIS, accentStyle } from "./identity";
import { resolveIdentity } from "../../src/identity.js";
import { schemaEntry } from "../../src/config-schema.js";
import type { SchemaEntry } from "../../src/config-schema.js";
import { SECRET_FIELDS } from "../../src/ui/sensitive.js";
import { sinkErrors } from "../../src/sinks-config.js";
import { digestErrors } from "../../src/digest-config.js";
import { energyErrors } from "../../src/energy.js";
import { HelpTip, ProfileMark } from "./components";
import { ConfirmContext } from "./Modal";

/** The stage-picker feed for the open profile: the discover outcome, `null` before the first fetch. */
export type StagesState = { source: StageSource; body: Discover | null };

type EditProps = { text: string; onEdit: (text: string) => void };

/**
 * The just-added cards (ConfigView's view state): a pristine card's errors render as an amber
 * "incomplete" hint, not red. "+ Add" marks the new index (`onAdded`), the first blur of a field in
 * the card clears it (`onTouched`), and ↑/↓/remove clear the whole list (`onShifted` — indices move).
 */
export type CardHooks = {
  pristine: Record<CardList, ReadonlySet<number>>;
  onAdded: (list: CardList, i: number) => void;
  onTouched: (list: CardList, i: number) => void;
  onShifted: (list: CardList) => void;
};

/** The card `<section>`'s `onBlur` (blur bubbles in React): a field leaving focus touches a pristine card. */
const touchOnBlur = (cards: CardHooks | undefined, list: CardList, i: number) => (e: React.FocusEvent) => {
  if (cards?.pristine[list].has(i) && (e.target as HTMLElement).matches?.("input, select, textarea")) cards.onTouched(list, i);
};

const INPUT = "w-full min-w-0 rounded border border-[var(--color-border)] bg-transparent px-1.5 py-0.5 font-mono text-xs";
const BUTTON = "rounded border border-[var(--color-border)] px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50";
// Below `sm` (phones): a 40px touch target for expand / move / remove; desktop keeps BUTTON's size.
const TOUCH = "min-h-10 min-w-10 sm:min-h-0 sm:min-w-0";
const ICON_BUTTON = `${BUTTON} ${TOUCH} shrink-0`;

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
      <span className="flex min-w-0 items-center gap-1 text-xs text-[var(--color-muted)]">
        <label htmlFor={controlId} className="whitespace-nowrap">
          {props.label}
        </label>
        {props.hint && (
          <span className="min-w-0 truncate font-mono opacity-70" title={props.hint}>
            {props.hint}
          </span>
        )}
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
      <div className={FIELD_GRID_3}>{props.children}</div>
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
            <div key={d} data-escalate-row={d} className={FIELD_GRID_3}>
              <span className="col-span-full -mb-1 text-xs font-medium capitalize text-[var(--color-muted)]">{d}</span>
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
    <div className="col-span-full flex flex-col gap-1" data-step-env>
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
            <button type="button" className={ICON_BUTTON} aria-label="remove variable" onClick={() => commit(rows.filter((_, j) => j !== idx))}>
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

/**
 * The `pricing` editor: one row per model pattern with its four $/Mtok rates, plus "add model".
 * Rows are a local draft committed on blur (a blank pattern is dropped); removing the last row
 * removes `pricing`. Same shape as the step `env` editor.
 */
function PricingField(props: EditProps & { pricing: unknown }) {
  const initial = pricingRows(props.pricing);
  const [rows, setRows] = useState(initial);
  const key = JSON.stringify(initial);
  useEffect(() => setRows(initial), [key]);
  const m = fieldMeta(["pricing"]);
  const commit = (next: PricingRow[]) => props.onEdit(pricingEdit(props.text, next));
  const change = (idx: number, col: keyof PricingRow, value: string) => setRows(rows.map((r, j) => (j === idx ? { ...r, [col]: value } : r)));
  return (
    <div className="flex flex-col gap-1" data-pricing>
      <span className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
        {m.label}
        <span className="ml-1 font-mono opacity-70">{m.hint}</span>
        {m.help && <HelpTip label={m.label} help={m.help} />}
      </span>
      <ul className="flex flex-col gap-1">
        {rows.map((r, idx) => (
          <li key={idx} className="flex flex-wrap items-center gap-1" data-pricing-row={idx}>
            <input className={INPUT} aria-label="model pattern" placeholder="qwen3.8*" value={r.pattern} onChange={(e) => change(idx, "pattern", e.target.value)} onBlur={() => commit(rows)} />
            {PRICING_RATES.map((k) => {
              const f = fieldMeta(["pricing", "*", k]);
              return (
                <input key={k} className={`${INPUT} w-24`} inputMode="decimal" aria-label={f.label} title={f.help} placeholder={k === "input" || k === "output" ? f.label : `${f.label} (opt.)`} value={r[k]} onChange={(e) => change(idx, k, e.target.value)} onBlur={() => commit(rows)} />
              );
            })}
            <button type="button" className={ICON_BUTTON} aria-label="remove model" onClick={() => commit(rows.filter((_, j) => j !== idx))}>
              remove
            </button>
          </li>
        ))}
      </ul>
      <div>
        <button type="button" className={BUTTON} data-add-pricing onClick={() => setRows([...rows, { pattern: "", input: "", output: "", cacheRead: "", cacheWrite: "" }])}>
          add model
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
    <div className="col-span-full flex flex-col gap-1" data-lite-headings>
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
              className={ICON_BUTTON}
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
              className={ICON_BUTTON}
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
            <button type="button" className={ICON_BUTTON} aria-label="remove heading" onClick={() => commit(rows.filter((_, j) => j !== idx))}>
              remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-1">
        <input className={INPUT} placeholder="add heading" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} />
        <button type="button" className={`${BUTTON} shrink-0`} disabled={!draft.trim()} onClick={add}>
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
      <div className={FIELD_GRID_3}>
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

const SANDBOX_TYPE_OPTIONS = [
  { value: "", label: "Off" },
  { value: "docker", label: "Docker" },
  { value: "podman", label: "Podman" },
] as const;

/**
 * The Basics form's Sandbox group: a backend select (Off removes the whole `sandbox` block) and,
 * once a backend is set, the image/memory/cpus/egress fields and the readiness card. Egress `open`
 * gets an inline warning; static help points at `agenthook doctor --fix` and docs/sandbox.md.
 */
function SandboxGroup(props: EditProps & { sandbox: Record<string, unknown> | undefined; profile: string }) {
  const edit = { text: props.text, onEdit: props.onEdit };
  const typeMeta = fieldMeta(["sandbox", "type"]);
  const cur = fieldText(props.sandbox?.type);
  const egressRaw = props.sandbox?.egress;
  const egress = egressRaw && typeof egressRaw === "object" && !Array.isArray(egressRaw) ? (egressRaw as Record<string, unknown>) : undefined;
  return (
    <div className="col-span-full flex flex-col gap-2">
      <h4 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">Sandbox</h4>
      <div className={FIELD_GRID}>
        <Field label={typeMeta.label} hint={typeMeta.hint} help={typeMeta.help}>
          <select className={INPUT} name="sandbox.type" value={cur} onChange={(e) => props.onEdit(sandboxTypeEdit(props.text, e.target.value as "" | "docker" | "podman"))}>
            {SANDBOX_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {props.sandbox !== undefined && (
          <>
            <TextField {...edit} path={["sandbox", "image"]} value={props.sandbox.image} />
            <TextField {...edit} path={["sandbox", "memory"]} value={props.sandbox.memory} />
            <NumberField {...edit} path={["sandbox", "cpus"]} value={props.sandbox.cpus} />
            <SelectField {...edit} path={["sandbox", "egress", "mode"]} value={egress?.mode} />
            <StringListField {...edit} path={["sandbox", "egress", "allow"]} value={egress?.allow} />
            <StringListField {...edit} path={["sandbox", "egress", "deny"]} value={egress?.deny} />
          </>
        )}
      </div>
      {props.sandbox !== undefined && egress?.mode === "open" && (
        <p className="text-xs text-status-held">unrestricted network: a hijacked agent can send data anywhere</p>
      )}
      {props.sandbox !== undefined && <SandboxReadinessCard profile={props.profile} type={cur} />}
      <p className={NOTE}>
        A sandboxed claude step needs <span className="font-mono">CLAUDE_CODE_OAUTH_TOKEN</span> (from{" "}
        <span className="font-mono">claude setup-token</span>) or <span className="font-mono">ANTHROPIC_API_KEY</span> in this profile's{" "}
        <span className="font-mono">.env</span>, and the agent image: run <span className="font-mono">agenthook doctor --fix</span>. See{" "}
        <span className="font-mono">docs/sandbox.md</span>.
      </p>
    </div>
  );
}

type ReadinessState = { kind: "loading" } | { kind: "ok"; body: SandboxReadiness } | { kind: "error"; why: string };

/**
 * "Sandbox readiness": GET /api/sandbox-readiness for the form's backend — the runtime, the agent
 * image and a claude credential in the profile's .env, each ✓/✗ with the CLI command that fixes it.
 * Read-only; fetched on mount, on a backend change and on Refresh (no polling).
 */
export function SandboxReadinessCard(props: { profile: string; type: string }) {
  const [state, setState] = useState<ReadinessState>({ kind: "loading" });
  const seq = useRef(0);
  const load = () => {
    const n = ++seq.current;
    setState({ kind: "loading" });
    const land = (s: ReadinessState) => {
      if (n === seq.current) setState(s);
    };
    fetch(sandboxReadinessUrl(props.profile, props.type))
      .then((res) =>
        res.ok
          ? res.json().then((body: SandboxReadiness) => land({ kind: "ok", body }))
          : land({ kind: "error", why: res.status === 404 ? "no config published for this profile" : `status ${res.status}` }),
      )
      .catch(() => land({ kind: "error", why: "request failed" }));
  };
  useEffect(load, [props.profile, props.type]);
  const rows = state.kind === "ok" ? state.body.rows : [];
  return (
    <div className="flex flex-col gap-1.5 rounded border border-[var(--color-border)] p-2" data-sandbox-readiness>
      <div className="flex items-center gap-2">
        <h5 className="text-xs font-medium">Sandbox readiness</h5>
        <button type="button" className={BUTTON} disabled={state.kind === "loading"} onClick={load}>
          Refresh
        </button>
        {state.kind === "loading" && <span className={NOTE}>checking…</span>}
        {state.kind === "error" && <span className="text-xs text-status-failed">couldn't check ({state.why})</span>}
      </div>
      {state.kind === "ok" && !state.body.enabled && <p className={NOTE}>pick a sandbox backend to check it</p>}
      {rows.length > 0 && (
        <ul className="flex flex-col gap-1">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start gap-1.5 text-xs" data-readiness-row={r.id} data-ok={r.ok}>
              <span className={r.ok ? "text-status-done" : "text-status-failed"} aria-label={r.ok ? "ok" : "missing"}>
                {r.ok ? "✓" : "✗"}
              </span>
              <span className="flex min-w-0 flex-col">
                <span>
                  {r.label}
                  {r.note && <span className="text-[var(--color-muted)]"> — {r.note}</span>}
                </span>
                {r.remedy && <span className="break-all font-mono text-[var(--color-muted)]">{r.remedy}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BasicsForm(props: EditProps & { raw: unknown; stateKey: string }) {
  const b = readBasics(props.raw);
  const edit = { text: props.text, onEdit: props.onEdit };
  const name = fieldMeta(["name"]);
  return (
    <div className="@container max-w-5xl rounded border border-[var(--color-border)] p-3">
      <div className={FIELD_GRID}>
        <div className="col-span-full flex flex-col gap-1">
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
        <TextField {...edit} path={["instructionsFile"]} value={b.instructionsFile} />
        <AppearanceFields text={props.text} onEdit={props.onEdit} ui={b.ui} stateKey={props.stateKey} />
        <div className="col-span-full flex flex-col gap-1">
          <CheckField {...edit} path={["fullAuto"]} value={b.fullAuto} explicitFalse />
          <p className="text-xs text-status-held">
            fullAuto runs agents with --dangerously-skip-permissions: a verified webhook runs unsandboxed code on this host.
          </p>
          {b.fullAuto === true && b.sandbox === undefined && (
            <p className="text-xs text-status-held">
              fullAuto without a sandbox: a verified webhook runs code on this host as your user. Enable the sandbox below.
            </p>
          )}
        </div>
        <SandboxGroup {...edit} sandbox={b.sandbox} profile={props.stateKey} />
        <details className="col-span-full" data-advanced>
          <summary className="cursor-pointer text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Advanced · {(["agent", "agentProvider", "claudeBin"] as const).filter((k) => b[k] !== undefined && b[k] !== "" && b[k] !== fieldMeta([k]).entry?.default).length} set
          </summary>
          <div className={`mt-2 ${FIELD_GRID}`}>
            <SelectField {...edit} path={["agent"]} value={b.agent} />
            <TextField {...edit} path={["agentProvider"]} value={b.agentProvider} />
            <TextField {...edit} path={["claudeBin"]} value={b.claudeBin} />
            <div className="flex flex-col gap-1">
              <TextField {...edit} path={["stateId"]} value={b.stateId} readOnly />
              <p className={NOTE}>
                Keys the state dir — change it with <span className="font-mono">agenthook rename --move</span>, not here.
              </p>
            </div>
          </div>
        </details>
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
    <div className="col-span-full flex flex-col gap-2" data-appearance>
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
          <div role="radiogroup" aria-label="profile emoji" aria-describedby={emojiHelp} className="grid max-h-56 max-w-md grid-cols-6 gap-1 overflow-y-auto @[28rem]:grid-cols-10 rounded border border-[var(--color-border-subtle)] p-1">
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
 * a card whose step gains an error (`errors`, from `stepErrors`) opens itself and keeps a red badge
 * (a pristine card — `cards`, just added and untouched — shows an amber "incomplete" one and stays
 * as it is), and `focus` (a graph click) opens + scrolls to the step with that id. All of it is view state —
 * nothing here edits the buffer except the fields and the ↑/↓/remove/add buttons.
 */
export function PipelineForm(
  props: EditProps & {
    raw: unknown;
    stages: StagesState | null;
    onRefresh: () => void;
    errors?: Map<number, string[]>;
    focus?: { id: string; nonce: number } | null;
    cards?: CardHooks;
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
  const pristine = props.cards?.pristine.steps ?? new Set<number>();
  const [open, setOpen] = useState<Set<number>>(new Set());
  const ask = useContext(ConfirmContext);
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const cards = useRef<(HTMLElement | null)[]>([]);
  // A step that goes from no errors to some opens itself (once — the user may collapse it again).
  // A pristine card's errors don't count until it is touched.
  const errored = useRef<Set<number>>(new Set());
  const loud = [...errors.keys()].filter((i) => !pristine.has(i));
  const errorKey = loud.sort((x, y) => x - y).join(",");
  useEffect(() => {
    const now = new Set(loud);
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
    <div className="@container flex flex-col gap-3" data-pipeline-form>
      <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-muted)]">
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
        // provider / isolated / toolsets are hermes-only keys: shown on a hermes step, or once set
        const isHermes = (s.agent ?? (props.raw as any)?.agent ?? "claude") === "hermes";
        const isOpen = open.has(i);
        const errs = errors.get(i) ?? [];
        const incomplete = errs.length > 0 && pristine.has(i);
        return (
          <section
            key={i}
            ref={(el) => {
              cards.current[i] = el;
            }}
            data-step-card={fieldText(s.id)}
            data-open={isOpen}
            data-incomplete={incomplete ? "" : undefined}
            onBlur={touchOnBlur(props.cards, "steps", i)}
            className={`rounded border p-3 ${incomplete ? "border-status-held" : errs.length ? "border-status-failed" : "border-[var(--color-border)]"}`}
          >
            {/* Wraps below `sm`: the summary may take its own line; ↑/↓/remove stay together. */}
            <div data-step-header className={`flex flex-wrap items-center gap-2 sm:flex-nowrap ${isOpen ? "mb-2" : ""}`}>
              <button className={ICON_BUTTON} aria-label={isOpen ? "collapse step" : "expand step"} aria-expanded={isOpen} onClick={() => toggle(i)}>
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
              {incomplete ? (
                <span
                  data-step-incomplete={errs.length}
                  title={errs.join("\n")}
                  className="shrink-0 rounded-full border border-status-held bg-status-held-bg px-1.5 text-xs text-status-held"
                >
                  incomplete
                </span>
              ) : (
                errs.length > 0 && (
                  <span
                    data-step-error={errs.length}
                    title={errs.join("\n")}
                    className="shrink-0 rounded-full border border-status-failed bg-status-failed-bg px-1.5 text-xs text-status-failed"
                  >
                    ! {errs.length}
                  </span>
                )
              )}
              <span className="ml-auto flex shrink-0 gap-1">
                <button
                  className={ICON_BUTTON}
                  aria-label="move up"
                  disabled={i === 0}
                  onClick={() => {
                    setOpen((prev) => openAfterMove(prev, i, -1));
                    props.cards?.onShifted("steps");
                    props.onEdit(moveStep(props.text, i, -1));
                  }}
                >
                  ↑
                </button>
                <button
                  className={ICON_BUTTON}
                  aria-label="move down"
                  disabled={i === steps.length - 1}
                  onClick={() => {
                    setOpen((prev) => openAfterMove(prev, i, 1));
                    props.cards?.onShifted("steps");
                    props.onEdit(moveStep(props.text, i, 1));
                  }}
                >
                  ↓
                </button>
                <button
                  className={ICON_BUTTON}
                  onClick={() =>
                    ask({ title: `Remove step "${fieldText(s.id) || i + 1}"?`, body: "Its comment keys go with it.", confirmLabel: "Remove", destructive: true }).then((ok) => {
                      if (!ok) return;
                      setOpen((prev) => openAfterRemove(prev, i));
                      props.cards?.onShifted("steps");
                      props.onEdit(removeStep(props.text, i));
                    })
                  }
                >
                  remove
                </button>
              </span>
            </div>
            {isOpen && errs.length > 0 && (
              <ul className={`mb-2 list-disc pl-4 text-xs ${incomplete ? "text-status-held" : "text-status-failed"}`}>
                {errs.map((e, k) => (
                  <li key={k} className="break-words">
                    {e}
                  </li>
                ))}
              </ul>
            )}
            {isOpen && (
              <div className="flex flex-col gap-3">
                <div className={FIELD_GRID_3}>
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
                    <span className="col-span-full text-xs text-[var(--color-muted)]">no stage fields for this tracker type — edit stage bindings in Raw</span>
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
                    <div className={FIELD_GRID_3}>
                      <NumberField {...edit} path={at("maxMinutes")} value={s.maxMinutes} />
                      <NumberField {...edit} path={at("idleMinutes")} value={s.idleMinutes} />
                      <NumberField {...edit} path={at("maxConcurrent")} value={s.maxConcurrent} />
                    </div>
                    {keys && advancedRoles.length > 0 && (
                      <div className={FIELD_GRID_3}>
                        {advancedRoles.map((role) => (
                          <StageField key={role} {...edit} label={ROLE_LABEL[role]} stageKey={keys[role]} path={at(keys[role])} value={s[keys[role]]} stages={props.stages} />
                        ))}
                      </div>
                    )}
                    <div className={FIELD_GRID_3}>
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
                      {showCloseIssue && showTerminalFlag(s, i, steps.length, "closeIssue") && (
                        <CheckField {...edit} path={at("closeIssue")} value={s.closeIssue} />
                      )}
                      {showCompleteTask && showTerminalFlag(s, i, steps.length, "completeTask") && (
                        <CheckField {...edit} path={at("completeTask")} value={s.completeTask} />
                      )}
                      {(s.manual !== true || s.requireVerdict !== undefined) && (
                        <CheckField {...edit} path={at("requireVerdict")} value={s.requireVerdict} />
                      )}
                      {(s.manual !== true || s.energy !== undefined) && <CheckField {...edit} path={at("energy")} value={s.energy} />}
                    </div>
                    <div className={FIELD_GRID_3}>
                      <SelectField {...edit} path={at("agent")} value={s.agent} />
                      <TextField {...edit} path={at("bin")} value={s.bin} />
                      <EnvField {...edit} i={i} env={s.env} />
                      {(isHermes || s.provider !== undefined) && <TextField {...edit} path={at("provider")} value={s.provider} />}
                      {(isHermes || s.isolated !== undefined) && <CheckField {...edit} path={at("isolated")} value={s.isolated} defaultValue={true} />}
                      {(isHermes || s.toolsets !== undefined) && <StringListField {...edit} path={at("toolsets")} value={s.toolsets} />}
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
            props.cards?.onAdded("steps", steps.length);
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
      {props.fields.common.length > 0 && <div className={FIELD_GRID}>{props.fields.common.map(one)}</div>}
      {props.fields.advanced.length > 0 && (
        <details data-advanced>
          <summary className="cursor-pointer text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Advanced · {setCount(props.block, props.fields.advanced)} set
          </summary>
          <div className={`mt-2 ${FIELD_GRID}`}>{props.fields.advanced.map(one)}</div>
        </details>
      )}
    </>
  );
}

const PANEL = "@container flex max-w-5xl flex-col gap-3 rounded border border-[var(--color-border)] p-3";
// One column below ~900px of pane width (the container, not the viewport), two above it.
const FIELD_GRID = "grid grid-cols-1 gap-3 @[56rem]:grid-cols-2";
// The step cards' three-up grids: one column on a phone, two from ~450px of pane width, three from
// ~700px (a 768px window's pane) — so ≥ 768px looks as before. `col-span-full` children span every row.
export const FIELD_GRID_3 = "grid grid-cols-1 gap-3 @[28rem]:grid-cols-2 @[44rem]:grid-cols-3";
const FORM_WRAP = "flex max-w-5xl flex-col gap-4";
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
  const ask = useContext(ConfirmContext);
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
        fields={sectionFields("forge", block.type)}
        block={block}
        render={(e, value) => (e.path[1] === "ciTarget" ? <CiTargetField {...edit} raw={props.raw} value={value} /> : undefined)}
      />
      <div>
        <button
          className={BUTTON}
          data-remove-forge
          onClick={() =>
            ask({
              title: "Remove the forge block?",
              body: "Every forge key (type, token, webhook secret, CI settings) is deleted.",
              confirmLabel: "Remove",
              destructive: true,
            }).then((ok) => ok && props.onEdit(setPath(props.text, ["forge"], undefined)))
          }
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

/** A card's error list; `incomplete` (a pristine card) renders it as an amber hint instead of red. */
function ErrorList(props: { errors: string[]; incomplete?: boolean }) {
  if (!props.errors.length) return null;
  return (
    <ul className={`list-disc pl-4 text-xs ${props.incomplete ? "text-status-held" : "text-status-failed"}`}>
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
        <div role="group" aria-label="events" aria-describedby={m.help ? helpId : undefined} className="grid grid-cols-1 gap-x-3 gap-y-0.5 @[28rem]:grid-cols-2 @[44rem]:grid-cols-3">
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
function SinkCard(props: EditProps & { index: number; count: number; sink: unknown; errors: string[]; cards?: CardHooks }) {
  const ask = useContext(ConfirmContext);
  const i = props.index;
  const edit = { text: props.text, onEdit: props.onEdit };
  const s = knownSink(props.sink);
  const typeName = s ? String(s.type) : "";
  const unknownLabel =
    props.sink !== null && typeof props.sink === "object" && !Array.isArray(props.sink)
      ? `unknown sink type ${JSON.stringify((props.sink as Record<string, unknown>).type ?? null)}`
      : "not a sink object";
  const incomplete = props.errors.length > 0 && !!props.cards?.pristine.sinks.has(i);
  return (
    <section
      data-sink-card={i}
      data-sink-unknown={s ? undefined : ""}
      data-incomplete={incomplete ? "" : undefined}
      onBlur={touchOnBlur(props.cards, "sinks", i)}
      className={`flex flex-col gap-2 rounded border p-3 ${incomplete ? "border-status-held" : props.errors.length ? "border-status-failed" : "border-[var(--color-border)]"}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--color-muted)]">#{i + 1}</span>
        <span className="font-mono text-sm">{s ? typeName : "?"}</span>
        <span className="ml-auto flex shrink-0 gap-1">
          <button className={ICON_BUTTON} aria-label="move sink up" disabled={i === 0} onClick={() => {
              props.cards?.onShifted("sinks");
              props.onEdit(moveSink(props.text, i, -1));
            }}>
            ↑
          </button>
          <button className={ICON_BUTTON} aria-label="move sink down" disabled={i === props.count - 1} onClick={() => {
              props.cards?.onShifted("sinks");
              props.onEdit(moveSink(props.text, i, 1));
            }}>
            ↓
          </button>
          <button
            className={ICON_BUTTON}
            data-remove-sink
            onClick={() =>
              ask({ title: `Remove sink #${i + 1}${s ? ` (${typeName})` : ""}?`, body: "Its comment keys go with it.", confirmLabel: "Remove", destructive: true }).then(
                (ok) => {
                  if (!ok) return;
                  props.cards?.onShifted("sinks");
                  props.onEdit(removeSink(props.text, i));
                },
              )
            }
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
          <div className={FIELD_GRID}>
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
      <ErrorList errors={props.errors} incomplete={incomplete} />
    </section>
  );
}

/**
 * The Integrations tab: the `sinks` list (add / remove / reorder, per-type fields, event filter),
 * the optional `digest` block (an emptied block is removed, like `identityEdit`'s `ui`), `pricing`, `energy` and the
 * `overlapGuard` opt-in. Each group lists its own client checks; the server's 422 stays authoritative.
 */
export function IntegrationsForm(props: EditProps & { raw: unknown; cards?: CardHooks }) {
  const sinks = readSinks(props.raw);
  const digest = readDigest(props.raw);
  const edit = { text: props.text, onEdit: props.onEdit };
  const digestEdit = { text: props.text, onEdit: (next: string) => props.onEdit(dropEmptyBlock(next, "digest")) };
  const raw = props.raw as Record<string, unknown> | null;
  const sinkErrs = sinkErrors(raw?.sinks);
  const budget = fieldMeta(["digest", "maxBudgetUsd"]).entry!;
  const energy = readEnergy(props.raw);
  const source = energy && typeof energy.source === "object" && energy.source && !Array.isArray(energy.source) ? (energy.source as Record<string, unknown>) : undefined;
  const energyEdits = { text: props.text, onEdit: (next: string) => props.onEdit(energyEdit(props.text, next)) };
  const quota = readQuotaConfig(props.raw);
  const quotaEdit = { text: props.text, onEdit: (next: string) => props.onEdit(dropEmptyBlock(next, "quota")) };
  return (
    <div className={FORM_WRAP} data-integrations-form>
      <div className={PANEL} data-sinks>
        <h3 className="text-sm font-semibold">Sinks</h3>
        <p className={NOTE}>Forward lifecycle events to Slack, Telegram or a webhook. Best-effort: a sink never blocks the pipeline.</p>
        {sinkErrs.length > 0 && sinks.length === 0 && <ErrorList errors={sinkErrs} />}
        {sinks.map((s, i) => (
          <SinkCard key={i} {...edit} index={i} count={sinks.length} sink={s} errors={errorsForSink(sinkErrs, i)} cards={props.cards} />
        ))}
        <div>
          <button
            className={BUTTON}
            data-add-sink
            onClick={() => {
              props.cards?.onAdded("sinks", sinks.length);
              props.onEdit(addSink(props.text));
            }}
          >
            + Add sink
          </button>
        </div>
      </div>
      <div className={PANEL} data-digest>
        <h3 className="text-sm font-semibold">Digest</h3>
        <div className={FIELD_GRID}>
          <TextField {...digestEdit} path={["digest", "soul"]} value={digest?.soul} />
          <SelectField {...digestEdit} path={["digest", "access"]} value={digest?.access} />
          <ModelField {...digestEdit} path={["digest", "model"]} value={digest?.model} />
        </div>
        <details data-advanced>
          <summary className="cursor-pointer text-xs uppercase tracking-wide text-[var(--color-muted)]">Advanced · {setCount(digest, [budget])} set</summary>
          <div className={`mt-2 ${FIELD_GRID}`}>
            <NumberField {...digestEdit} path={["digest", "maxBudgetUsd"]} value={digest?.maxBudgetUsd} />
          </div>
        </details>
        <ErrorList errors={digestErrors(raw?.digest)} />
      </div>
      <div className={PANEL} data-pricing-panel>
        <h3 className="text-sm font-semibold">Pricing</h3>
        <p className={NOTE}>
          An agent that reports no dollars (Cursor, Hermes, OpenCode, a local model) gets an API-equivalent estimate, shown as{" "}
          <span className="font-mono">~$x est.</span> and never added to reported cost. Claude models are built in; map any other model here.
        </p>
        <PricingField {...edit} pricing={raw?.pricing} />
        <ErrorList errors={pricingErrors(raw?.pricing)} />
      </div>
      <div className={PANEL} data-energy-panel>
        <h3 className="text-sm font-semibold">Energy</h3>
        <p className={NOTE}>
          Steps that set <span className="font-mono">energy</span> record their runs&apos; electricity, shown as{" "}
          <span className="font-mono">energy $x (y Wh)</span> beside the cost or estimate and never added to it. Gross draw incl. idle; hwmon reads the GPU only.
        </p>
        <div className={FIELD_GRID}>
          <NumberField {...energyEdits} path={["energy", "usdPerKwh"]} value={energy?.usdPerKwh} />
          <SelectField {...energyEdits} path={["energy", "source", "type"]} value={source?.type} />
          {(source?.type === "hwmon" || source?.name !== undefined) && <TextField {...energyEdits} path={["energy", "source", "name"]} value={source?.name} />}
          {(source?.type === "command" || source?.cmd !== undefined) && <TextField {...energyEdits} path={["energy", "source", "cmd"]} value={source?.cmd} />}
          {(source?.type === "watts" || source?.watts !== undefined) && <NumberField {...energyEdits} path={["energy", "source", "watts"]} value={source?.watts} />}
        </div>
        <ErrorList errors={energyErrors(raw?.energy)} />
      </div>
      <div className={PANEL} data-quota-panel>
        <h3 className="text-sm font-semibold">Quota pacing</h3>
        <p className={NOTE}>
          Claude runs report the subscription quota (5-hour and weekly windows). Set a threshold to pause new runs at or above it; they resume by
          themselves when that window resets. Running agents always finish; your own pause or resume wins. Unset = never pauses.
        </p>
        <div className={FIELD_GRID}>
          <NumberField {...quotaEdit} path={["quota", "pauseAboveSevenDay"]} value={quota?.pauseAboveSevenDay} />
          <NumberField {...quotaEdit} path={["quota", "pauseAboveFiveHour"]} value={quota?.pauseAboveFiveHour} />
        </div>
        <ErrorList errors={quotaErrors(raw?.quota)} />
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

/**
 * A string-list field (`repos.*.match`, and later `lite.descriptionHeadings`): chips with × plus a
 * text input that adds a trimmed, non-empty, de-duplicated entry on Enter or comma. A non-array value
 * is left to Raw instead of being rewritten.
 */
function StringListField(props: EditProps & { path: JSONPath; value: unknown }) {
  const m = fieldMeta(props.path);
  const [draft, setDraft] = useState("");
  const invalid = stringListInvalid(props.value);
  const list = invalid ? [] : Array.isArray(props.value) ? (props.value as string[]) : [];
  const add = () => {
    if (!draft.trim()) return;
    props.onEdit(stringListAdd(props.text, props.path, props.value, draft));
    setDraft("");
  };
  return (
    <Field label={m.label} hint={m.hint} help={m.help}>
      {invalid ? (
        <span className={NOTE}>not a list of strings — edit in Raw.</span>
      ) : (
        <div className="flex flex-col gap-1">
          {list.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {list.map((v) => (
                <span key={v} className="flex items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-xs">
                  {v}
                  <button type="button" className={`${TOUCH} inline-flex items-center justify-center`} aria-label={`remove ${v}`} onClick={() => props.onEdit(stringListRemove(props.text, props.path, props.value, v))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            className={INPUT}
            name={props.path.join(".")}
            value={draft}
            placeholder="add…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add();
              }
            }}
            onBlur={add}
          />
        </div>
      )}
    </Field>
  );
}

/** The list of `errors` that attribute to a specific repo card, so the top panel can skip them. */
const anyRepoErrors = (errors: string[], repos: unknown[]): string[] => errors.filter((e) => repos.every((_, i) => !errorsForRepo([e], repos, i).length));

/**
 * One `repos[i]` card: id, path, match (chips) and default in the common grid; instructionsFile and
 * worktreePrefix under Advanced. ↑/↓/remove in the header; a non-object element is a read-only card.
 */
function RepoCard(props: EditProps & { index: number; count: number; repos: unknown[]; repo: unknown; errors: string[]; cards?: CardHooks }) {
  const ask = useContext(ConfirmContext);
  const i = props.index;
  const edit = { text: props.text, onEdit: props.onEdit };
  const r = knownRepo(props.repo);
  const label = r && typeof r.id === "string" && r.id !== "" ? r.id : "?";
  const advancedCount = r ? (["instructionsFile", "worktreePrefix"] as const).filter((k) => r[k] !== undefined && r[k] !== "").length : 0;
  const incomplete = props.errors.length > 0 && !!props.cards?.pristine.repos.has(i);
  return (
    <section
      data-repo-card={i}
      data-repo-unknown={r ? undefined : ""}
      data-incomplete={incomplete ? "" : undefined}
      onBlur={touchOnBlur(props.cards, "repos", i)}
      className={`flex flex-col gap-2 rounded border p-3 ${incomplete ? "border-status-held" : props.errors.length ? "border-status-failed" : "border-[var(--color-border)]"}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--color-muted)]">#{i + 1}</span>
        <span className="font-mono text-sm">{label}</span>
        <span className="ml-auto flex shrink-0 gap-1">
          <button className={ICON_BUTTON} aria-label="move repo up" disabled={i === 0} onClick={() => {
              props.cards?.onShifted("repos");
              props.onEdit(moveRepo(props.text, i, -1));
            }}>
            ↑
          </button>
          <button className={ICON_BUTTON} aria-label="move repo down" disabled={i === props.count - 1} onClick={() => {
              props.cards?.onShifted("repos");
              props.onEdit(moveRepo(props.text, i, 1));
            }}>
            ↓
          </button>
          <button
            className={ICON_BUTTON}
            data-remove-repo
            onClick={() =>
              ask({ title: `Remove repo #${i + 1}${r ? ` (${label})` : ""}?`, confirmLabel: "Remove", destructive: true }).then(
                (ok) => {
                  if (!ok) return;
                  props.cards?.onShifted("repos");
                  props.onEdit(removeRepo(props.text, i));
                },
              )
            }
          >
            remove
          </button>
        </span>
      </div>
      {!r ? (
        <p className={NOTE}>not an object — edit in Raw.</p>
      ) : (
        <>
          <div className={FIELD_GRID}>
            <TextField {...edit} path={repoFieldPath(i, "id")} value={r.id} />
            <TextField {...edit} path={repoFieldPath(i, "path")} value={r.path} />
            <StringListField {...edit} path={repoFieldPath(i, "match")} value={r.match} />
            <div className="flex items-center gap-1 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name={repoFieldPath(i, "default").join(".")}
                  checked={r.default === true}
                  onChange={(e) => props.onEdit(repoDefaultEdit(props.text, props.repos, i, e.target.checked))}
                />
                <span className="text-xs">
                  {fieldMeta(repoFieldPath(i, "default")).label}
                  <span className="ml-1 font-mono opacity-70 text-[var(--color-muted)]">default</span>
                </span>
              </label>
            </div>
          </div>
          <details data-advanced>
            <summary className="cursor-pointer text-xs uppercase tracking-wide text-[var(--color-muted)]">Advanced · {advancedCount} set</summary>
            <div className={`mt-2 ${FIELD_GRID}`}>
              <TextField {...edit} path={repoFieldPath(i, "instructionsFile")} value={r.instructionsFile} />
              <TextField {...edit} path={repoFieldPath(i, "worktreePrefix")} value={r.worktreePrefix} />
            </div>
          </details>
        </>
      )}
      <ErrorList errors={props.errors} incomplete={incomplete} />
    </section>
  );
}

/**
 * The Repos tab: `repoPath` / `worktreePrefix` always shown (single-repo profiles read them
 * directly; a declared `repos` block keeps `repoPath` only as the legacy default-naming fallback),
 * then the `repos` cards (add/remove/reorder, the single-default rule enforced inline) or, absent a
 * `repos` block, a note and "+ Add repo".
 */
export function ReposForm(props: EditProps & { raw: unknown; cards?: CardHooks }) {
  const repos = readRepos(props.raw);
  const raw = props.raw as Record<string, unknown> | null;
  const hasRepos = Array.isArray(raw?.repos);
  const edit = { text: props.text, onEdit: props.onEdit };
  const errs = reposErrors(raw?.repos);
  const wtp = fieldMeta(["worktreePrefix"]).entry;
  const wtpSet = raw?.worktreePrefix !== undefined && raw?.worktreePrefix !== "" && raw?.worktreePrefix !== wtp?.default ? 1 : 0;
  return (
    <div className={FORM_WRAP} data-repos-form>
      <div className={PANEL} data-repos-top>
        <TextField {...edit} path={["repoPath"]} value={raw?.repoPath} />
        {hasRepos && (
          <p className={NOTE}>
            Legacy: with <span className="font-mono">repos</span> set, repoPath only names the default repo when no card below is marked default.
          </p>
        )}
        <details data-advanced>
          <summary className="cursor-pointer text-xs uppercase tracking-wide text-[var(--color-muted)]">Advanced · {wtpSet} set</summary>
          <div className={`mt-2 ${FIELD_GRID}`}>
            <TextField {...edit} path={["worktreePrefix"]} value={raw?.worktreePrefix} />
          </div>
        </details>
      </div>
      <div className={PANEL} data-repos-list>
        <h3 className="text-sm font-semibold">Repositories</h3>
        {!hasRepos ? (
          <>
            <p className={NOTE}>Single repo: agents work in repoPath.</p>
            <p className={NOTE}>
              Declaring repos nests worktrees under <span className="font-mono">worktreePrefix/&lt;id&gt;/</span> — finish or drain in-flight tickets first.
            </p>
          </>
        ) : (
          <>
            {errs.length > 0 && repos.length === 0 && <ErrorList errors={errs} />}
            {repos.length > 0 && <ErrorList errors={anyRepoErrors(errs, repos)} />}
            {repos.map((r, i) => (
              <RepoCard key={i} {...edit} index={i} count={repos.length} repos={repos} repo={r} errors={errorsForRepo(errs, repos, i)} cards={props.cards} />
            ))}
          </>
        )}
        <div>
          <button
            className={BUTTON}
            data-add-repo
            onClick={() => {
              props.cards?.onAdded("repos", repos.length);
              props.onEdit(addRepo(props.text));
            }}
          >
            + Add repo
          </button>
        </div>
      </div>
    </div>
  );
}
