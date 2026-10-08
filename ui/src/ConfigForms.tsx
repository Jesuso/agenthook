import { useEffect, useState } from "react";
import type { JSONPath } from "jsonc-parser";
import {
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
  stageKeysFor,
  stepPath,
  textEdit,
} from "./configEdit";
import type { Discover, StageSource } from "./configEdit";

/** The stage-picker feed for the open profile: the discover outcome, `null` before the first fetch. */
export type StagesState = { source: StageSource; body: Discover | null };

type EditProps = { text: string; onEdit: (text: string) => void };

const INPUT = "w-full rounded border border-[var(--color-border)] bg-transparent px-1.5 py-0.5 font-mono text-xs";
const BUTTON = "rounded border border-[var(--color-border)] px-2 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50";

function Field(props: { label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5 text-sm">
      <span className="text-xs text-[var(--color-muted)]">
        {props.label}
        {props.hint && <span className="ml-1 font-mono opacity-70">{props.hint}</span>}
      </span>
      {props.children}
      {props.error && <span className="text-xs text-[var(--color-err)]">{props.error}</span>}
    </label>
  );
}

function TextField(props: EditProps & { label: string; path: JSONPath; value: unknown; readOnly?: boolean; hint?: string }) {
  return (
    <Field label={props.label} hint={props.hint}>
      <input
        className={props.readOnly ? `${INPUT} cursor-not-allowed opacity-60` : INPUT}
        value={fieldText(props.value)}
        readOnly={props.readOnly}
        onChange={(e) => !props.readOnly && props.onEdit(textEdit(props.text, props.path, e.target.value))}
      />
    </Field>
  );
}

/** Keeps its own draft so a non-numeric entry stays visible (with the error) instead of being applied. */
function NumberField(props: EditProps & { label: string; path: JSONPath; value: unknown }) {
  const shown = fieldText(props.value);
  const [draft, setDraft] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  // Any buffer change (this field's own valid edit, another field, Raw) re-syncs from the buffer.
  useEffect(() => {
    setDraft(shown);
    setError(null);
  }, [props.text]);
  return (
    <Field label={props.label} error={error}>
      <input
        className={INPUT}
        inputMode="decimal"
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

function CheckField(props: EditProps & { label: string; path: JSONPath; value: unknown; explicitFalse?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={props.value === true}
        onChange={(e) => props.onEdit(boolEdit(props.text, props.path, e.target.checked, props.value, props.explicitFalse))}
      />
      <span className="font-mono text-xs">{props.label}</span>
    </label>
  );
}

/** First option "(default)" removes the key; an unknown current value stays selectable. */
function SelectField(props: EditProps & { label: string; path: JSONPath; value: unknown; options: readonly string[] }) {
  const cur = fieldText(props.value);
  const extra = cur !== "" && !props.options.includes(cur);
  return (
    <Field label={props.label}>
      <select className={INPUT} value={cur} onChange={(e) => props.onEdit(textEdit(props.text, props.path, e.target.value))}>
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

function StageField(props: EditProps & { label: string; stageKey: string; path: JSONPath; value: unknown; stages: StagesState | null }) {
  const cur = fieldText(props.value);
  const src = props.stages?.source ?? { kind: "loading" as const };
  if (src.kind !== "list") {
    return (
      <Field label={props.label} hint={props.stageKey}>
        <input className={INPUT} value={cur} onChange={(e) => props.onEdit(textEdit(props.text, props.path, e.target.value))} />
        <span className="text-xs text-[var(--color-muted)]">{src.kind === "loading" ? "loading stages…" : src.hint}</span>
      </Field>
    );
  }
  const offBoard = cur !== "" && !src.stages.some((s) => s.id === cur);
  return (
    <Field label={props.label} hint={props.stageKey}>
      <select className={INPUT} value={cur} onChange={(e) => props.onEdit(textEdit(props.text, props.path, e.target.value))}>
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

export function BasicsForm(props: EditProps & { raw: unknown }) {
  const b = readBasics(props.raw);
  const edit = { text: props.text, onEdit: props.onEdit };
  return (
    <div className="grid max-w-xl grid-cols-2 gap-3">
      <TextField
        {...edit}
        label="name"
        path={["name"]}
        value={b.name}
        readOnly
        hint="renaming moves ~/.agenthook/<name>/ and loses history — edit the file by hand"
      />
      <TextField {...edit} label="trigger" path={["trigger"]} value={b.trigger} />
      <NumberField {...edit} label="maxConcurrent" path={["maxConcurrent"]} value={b.maxConcurrent} />
      <NumberField {...edit} label="port" path={["port"]} value={b.port} />
      <div className="col-span-2">
        <CheckField {...edit} label="fullAuto" path={["fullAuto"]} value={b.fullAuto} explicitFalse />
        <p className="mt-1 text-xs text-[var(--color-warn)]">
          fullAuto runs agents with --dangerously-skip-permissions: a verified webhook runs unsandboxed code on this host.
        </p>
      </div>
    </div>
  );
}

/**
 * The ordered step list: ↑/↓/remove per card and "+ Add step". Only the listed fields are shown;
 * every other step key (escalate, lite, completeOnMerge, `//` comments, …) is preserved and edited in Raw.
 */
export function PipelineForm(props: EditProps & { raw: unknown; stages: StagesState | null; onRefresh: () => void }) {
  const steps = readSteps(props.raw);
  const tracker = (props.raw as any)?.tracker?.type;
  const keys = stageKeysFor(props.stages?.body ?? null, tracker);
  const edit = { text: props.text, onEdit: props.onEdit };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-xs text-[var(--color-muted)]">
        <span>
          tracker <span className="font-mono">{fieldText(tracker) || "(unset)"}</span>
        </span>
        <button className={BUTTON} disabled={props.stages?.source.kind === "loading"} onClick={props.onRefresh}>
          Refresh stages
        </button>
        {!keys && <span>no stage fields for this tracker type — edit stage bindings in Raw</span>}
      </div>
      {steps.map((s, i) => {
        const at = (k: string) => stepPath(i, k);
        return (
          <section key={i} className="rounded border border-[var(--color-border)] p-3">
            <div className="mb-2 flex items-center gap-2">
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
            <div className="grid grid-cols-3 gap-3">
              <TextField {...edit} label="id" path={at("id")} value={s.id} />
              <SelectField {...edit} label="kind" path={at("kind")} value={s.kind} options={STEP_KINDS} />
              <TextField {...edit} label="instructionsFile" path={at("instructionsFile")} value={s.instructionsFile} />
              <TextField {...edit} label="model" path={at("model")} value={s.model} />
              <SelectField {...edit} label="effort" path={at("effort")} value={s.effort} options={STEP_EFFORTS} />
              <NumberField {...edit} label="maxAttempts" path={at("maxAttempts")} value={s.maxAttempts} />
              <NumberField {...edit} label="maxMinutes" path={at("maxMinutes")} value={s.maxMinutes} />
              <NumberField {...edit} label="idleMinutes" path={at("idleMinutes")} value={s.idleMinutes} />
              <div className="flex flex-col justify-end gap-1">
                <CheckField {...edit} label="createsWorktree" path={at("createsWorktree")} value={s.createsWorktree} />
                <CheckField {...edit} label="drainWorktree" path={at("drainWorktree")} value={s.drainWorktree} />
                <CheckField {...edit} label="manual" path={at("manual")} value={s.manual} />
              </div>
              {keys &&
                STAGE_ROLES.map((role) => (
                  <StageField key={role} {...edit} label={role} stageKey={keys[role]} path={at(keys[role])} value={s[keys[role]]} stages={props.stages} />
                ))}
            </div>
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
