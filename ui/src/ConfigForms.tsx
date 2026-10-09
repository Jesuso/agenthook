import { useEffect, useState } from "react";
import type { JSONPath } from "jsonc-parser";
import {
  KNOWN_MODELS,
  STAGE_ROLES,
  STEP_EFFORTS,
  STEP_KINDS,
  addStep,
  boolEdit,
  fieldText,
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

function Field(props: { label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5 text-sm">
      <span className="text-xs text-[var(--color-muted)]">
        {props.label}
        {props.hint && <span className="ml-1 font-mono opacity-70">{props.hint}</span>}
      </span>
      {props.children}
      {props.error && <span className="text-xs text-status-failed">{props.error}</span>}
    </label>
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

function TextField(props: EditProps & { label: string; path: JSONPath; value: unknown; readOnly?: boolean; hint?: string; placeholder?: string }) {
  return (
    <Field label={props.label} hint={props.hint}>
      <input
        className={props.readOnly ? `${INPUT} cursor-not-allowed opacity-60` : INPUT}
        name={props.path.join(".")}
        value={fieldText(props.value)}
        placeholder={props.placeholder}
        readOnly={props.readOnly}
        onChange={(e) => !props.readOnly && props.onEdit(textEdit(props.text, props.path, e.target.value))}
      />
    </Field>
  );
}

/** Keeps its own draft so a non-numeric entry stays visible (with the error) instead of being applied. */
function NumberField(props: EditProps & { label: string; path: JSONPath; value: unknown; hint?: string; placeholder?: string }) {
  const shown = fieldText(props.value);
  const [draft, setDraft] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  // Any buffer change (this field's own valid edit, another field, Raw) re-syncs from the buffer.
  useEffect(() => {
    setDraft(shown);
    setError(null);
  }, [props.text]);
  return (
    <Field label={props.label} hint={props.hint} error={error}>
      <input
        className={INPUT}
        name={props.path.join(".")}
        inputMode="decimal"
        placeholder={props.placeholder}
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

function CheckField(props: EditProps & { label: string; path: JSONPath; value: unknown; hint?: string; explicitFalse?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        name={props.path.join(".")}
        checked={props.value === true}
        onChange={(e) => props.onEdit(boolEdit(props.text, props.path, e.target.checked, props.value, props.explicitFalse))}
      />
      <span className="text-xs">
        {props.label}
        {props.hint && <span className="ml-1 font-mono opacity-70 text-[var(--color-muted)]">{props.hint}</span>}
      </span>
    </label>
  );
}

/** First option "(default)" removes the key; an unknown current value stays selectable. */
function SelectField(props: EditProps & { label: string; path: JSONPath; value: unknown; options: readonly string[]; hint?: string }) {
  const cur = fieldText(props.value);
  const extra = cur !== "" && !props.options.includes(cur);
  return (
    <Field label={props.label} hint={props.hint}>
      <select className={INPUT} name={props.path.join(".")} value={cur} onChange={(e) => props.onEdit(textEdit(props.text, props.path, e.target.value))}>
        <option value="">(default)</option>
        {props.options.map((o) => (
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

export function ModelField(props: EditProps & { label: string; path: JSONPath; value: unknown; hint?: string }) {
  const cur = fieldText(props.value);
  const [forceCustom, setForceCustom] = useState(false);
  useEffect(() => setForceCustom(false), [props.text]);
  const { selectValue, showCustom: unknownValue } = modelSelectState(cur);
  const showCustom = forceCustom || unknownValue;
  return (
    <Field label={props.label} hint={props.hint}>
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

function StageField(props: EditProps & { label: string; stageKey: string; path: JSONPath; value: unknown; stages: StagesState | null }) {
  const cur = fieldText(props.value);
  const src = props.stages?.source ?? { kind: "loading" as const };
  if (src.kind !== "list") {
    return (
      <Field label={props.label} hint={props.stageKey}>
        <input className={INPUT} name={props.path.join(".")} value={cur} onChange={(e) => props.onEdit(textEdit(props.text, props.path, e.target.value))} />
        <span className="text-xs text-[var(--color-muted)]">{src.kind === "loading" ? "loading stages…" : src.hint}</span>
      </Field>
    );
  }
  const offBoard = cur !== "" && !src.stages.some((s) => s.id === cur);
  return (
    <Field label={props.label} hint={props.stageKey}>
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

/** Pure: a step's one-line collapsed summary — `kind · model · effort · <source> → <success>`, each part omitted when absent. */
export function summarizeStep(s: Record<string, unknown>, keys: StageKeys | null, stageList: StageOption[] | null): string {
  const parts: string[] = [];
  for (const k of ["kind", "model", "effort"] as const) {
    const v = fieldText(s[k]);
    if (v) parts.push(v);
  }
  if (keys) {
    const src = fieldText(s[keys.source]);
    const succ = fieldText(s[keys.success]);
    if (src && succ) parts.push(`${labelFor(src, stageList)} → ${labelFor(succ, stageList)}`);
    else if (src) parts.push(labelFor(src, stageList));
    else if (succ) parts.push(`→ ${labelFor(succ, stageList)}`);
  }
  return parts.join(" · ");
}

export function BasicsForm(props: EditProps & { raw: unknown; stateKey: string }) {
  const b = readBasics(props.raw);
  const edit = { text: props.text, onEdit: props.onEdit };
  return (
    <div className="max-w-xl rounded border border-[var(--color-border)] p-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 flex flex-col gap-1">
          <Field label="Profile name" hint="name">
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
        <TextField {...edit} label="Resume trigger" hint="trigger" path={["trigger"]} value={b.trigger} placeholder="@agent (default)" />
        <NumberField {...edit} label="Max concurrent agents" hint="maxConcurrent" path={["maxConcurrent"]} value={b.maxConcurrent} placeholder="1 (default)" />
        <NumberField {...edit} label="Local port" hint="port" path={["port"]} value={b.port} placeholder="4123 (default)" />
        <div className="col-span-2 flex flex-col gap-1">
          <CheckField {...edit} label="Full auto (skip permissions)" hint="fullAuto" path={["fullAuto"]} value={b.fullAuto} explicitFalse />
          <p className="text-xs text-status-held">
            fullAuto runs agents with --dangerously-skip-permissions: a verified webhook runs unsandboxed code on this host.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The ordered step list: ↑/↓/remove per card and "+ Add step". Only the listed fields are shown;
 * every other step key (escalate, lite, completeOnMerge, `//` comments, …) is preserved and edited in Raw.
 * Each card collapses to a one-line summary (local `useState`, default expanded — a newly added
 * step should be visible); ↑/↓ may reset a card's collapse state since it's keyed by index.
 */
export function PipelineForm(props: EditProps & { raw: unknown; stages: StagesState | null; onRefresh: () => void }) {
  const steps = readSteps(props.raw);
  const tracker = (props.raw as any)?.tracker?.type;
  const keys = stageKeysFor(props.stages?.body ?? null, tracker);
  const stageList = props.stages?.source.kind === "list" ? props.stages.source.stages : null;
  const edit = { text: props.text, onEdit: props.onEdit };
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-xs text-[var(--color-muted)]">
        <span>
          tracker <span className="font-mono">{fieldText(tracker) || "(unset)"}</span>
        </span>
        <button className={BUTTON} disabled={props.stages?.source.kind === "loading"} onClick={props.onRefresh}>
          Refresh stages
        </button>
      </div>
      {steps.map((s, i) => {
        const at = (k: string) => stepPath(i, k);
        const isCollapsed = collapsed.has(i);
        return (
          <section key={i} data-step-card className="rounded border border-[var(--color-border)] p-3">
            <div className={isCollapsed ? "flex items-center gap-2" : "mb-2 flex items-center gap-2"}>
              <button className={BUTTON} aria-label={isCollapsed ? "expand step" : "collapse step"} onClick={() => toggle(i)}>
                {isCollapsed ? "▸" : "▾"}
              </button>
              <span className="text-xs text-[var(--color-muted)]">#{i + 1}</span>
              <span className="font-mono text-sm">{fieldText(s.id) || "(no id)"}</span>
              <span className="ml-auto flex gap-1">
                <button className={BUTTON} aria-label="move up" disabled={i === 0} onClick={() => props.onEdit(moveStep(props.text, i, -1))}>
                  ↑
                </button>
                <button
                  className={BUTTON}
                  aria-label="move down"
                  disabled={i === steps.length - 1}
                  onClick={() => props.onEdit(moveStep(props.text, i, 1))}
                >
                  ↓
                </button>
                <button
                  className={BUTTON}
                  onClick={() => {
                    if (window.confirm(`Remove step "${fieldText(s.id) || i + 1}"? Its comment keys go with it.`)) props.onEdit(removeStep(props.text, i));
                  }}
                >
                  remove
                </button>
              </span>
            </div>
            {isCollapsed ? (
              <p className="mt-2 font-mono text-xs text-[var(--color-muted)]">{summarizeStep(s, keys, stageList) || "—"}</p>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-3 gap-3">
                  <TextField {...edit} label="Step id" hint="id" path={at("id")} value={s.id} />
                  <SelectField {...edit} label="Kind" hint="kind" path={at("kind")} value={s.kind} options={STEP_KINDS} />
                  <div className="flex items-end">
                    <CheckField {...edit} label="Manual (no agent)" hint="manual" path={at("manual")} value={s.manual} />
                  </div>
                </div>
                <Group title="Triggers & lanes">
                  {keys ? (
                    STAGE_ROLES.map((role) => (
                      <StageField key={role} {...edit} label={ROLE_LABEL[role]} stageKey={keys[role]} path={at(keys[role])} value={s[keys[role]]} stages={props.stages} />
                    ))
                  ) : (
                    <span className="col-span-3 text-xs text-[var(--color-muted)]">no stage fields for this tracker type — edit stage bindings in Raw</span>
                  )}
                </Group>
                <Group title="Agent">
                  <ModelField {...edit} label="Model" hint="model" path={at("model")} value={s.model} />
                  <SelectField {...edit} label="Reasoning effort" hint="effort" path={at("effort")} value={s.effort} options={STEP_EFFORTS} />
                  <TextField {...edit} label="Instructions file" hint="instructionsFile" path={at("instructionsFile")} value={s.instructionsFile} />
                </Group>
                <Group title="Limits">
                  <NumberField {...edit} label="Max attempts" hint="maxAttempts" path={at("maxAttempts")} value={s.maxAttempts} placeholder="3 (default)" />
                  <NumberField {...edit} label="Wall-clock limit (min)" hint="maxMinutes" path={at("maxMinutes")} value={s.maxMinutes} placeholder="120 (default)" />
                  <NumberField {...edit} label="Idle timeout (min)" hint="idleMinutes" path={at("idleMinutes")} value={s.idleMinutes} placeholder="off" />
                </Group>
                <Group title="Worktree">
                  <CheckField {...edit} label="Creates worktree" hint="createsWorktree" path={at("createsWorktree")} value={s.createsWorktree} />
                  <CheckField {...edit} label="Removes worktree" hint="drainWorktree" path={at("drainWorktree")} value={s.drainWorktree} />
                </Group>
              </div>
            )}
          </section>
        );
      })}
      <div>
        <button className={BUTTON} onClick={() => props.onEdit(addStep(props.text))}>
          + Add step
        </button>
      </div>
    </div>
  );
}
