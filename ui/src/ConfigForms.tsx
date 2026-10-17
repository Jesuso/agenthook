import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState } from "react";
import type { JSONPath } from "jsonc-parser";
import {
  KNOWN_MODELS,
  STAGE_ROLES,
  addStep,
  advancedSet,
  boolEdit,
  fieldText,
  identityEdit,
  moveStep,
  numberEdit,
  readBasics,
  readSteps,
  removeStep,
  renameEdit,
  stageKeysFor,
  stepPath,
  textEdit,
} from "./configEdit";
import type { Discover, StageKeys, StageOption, StageSource } from "./configEdit";
import { PROFILE_COLORS, PROFILE_EMOJIS, accentStyle } from "./identity";
import { resolveIdentity } from "../../src/identity.js";
import { schemaEntry } from "../../src/config-schema.js";
import type { SchemaEntry } from "../../src/config-schema.js";
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

function CheckField(props: EditProps & { path: JSONPath; value: unknown; explicitFalse?: boolean }) {
  const m = fieldMeta(props.path);
  const helpId = useId();
  return (
    <div className="flex items-center gap-1 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name={props.path.join(".")}
          aria-describedby={m.help ? helpId : undefined}
          checked={props.value === true}
          onChange={(e) => props.onEdit(boolEdit(props.text, props.path, e.target.checked, props.value, props.explicitFalse))}
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

/** First option "(default)" removes the key; an unknown current value stays selectable. */
function SelectField(props: EditProps & { path: JSONPath; value: unknown }) {
  const m = fieldMeta(props.path);
  const options = m.entry?.options ?? [];
  const cur = fieldText(props.value);
  const extra = cur !== "" && !options.includes(cur);
  return (
    <Field label={m.label} hint={m.hint} help={m.help}>
      <select className={INPUT} name={props.path.join(".")} value={cur} onChange={(e) => props.onEdit(textEdit(props.text, props.path, e.target.value))}>
        <option value="">(default)</option>
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

export function ModelField(props: EditProps & { path: JSONPath; value: unknown }) {
  const m = fieldMeta(props.path);
  const cur = fieldText(props.value);
  const [forceCustom, setForceCustom] = useState(false);
  useEffect(() => setForceCustom(false), [props.text]);
  const { selectValue, showCustom: unknownValue } = modelSelectState(cur);
  const showCustom = forceCustom || unknownValue;
  return (
    <Field label={m.label} hint={m.hint} help={m.help}>
      <select
        className={INPUT}
        name={props.path.join(".")}
        value={selectValue}
        onChange={(e) => {
          if (e.target.value === CUSTOM) return setForceCustom(true);
          setForceCustom(false);
          props.onEdit(textEdit(props.text, props.path, e.target.value));
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
      {showCustom && (
        <input
          className={`${INPUT} mt-1`}
          placeholder="model name"
          value={cur}
          onChange={(e) => props.onEdit(textEdit(props.text, props.path, e.target.value))}
        />
      )}
    </Field>
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
                    </div>
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
