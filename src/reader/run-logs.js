// `ah ui` run listing (docs/web-ui.md). Lists a ref's runs straight from the profile's `logs/`
// dir (no config: the step is the text between `-step-` and the ref). Blind reader — validates
// every name against a real directory listing and never writes anything.
import fs from "node:fs";
import path from "node:path";
import { listProfiles } from "../heartbeat.js";
import { isObj, readStateFile } from "./rows.js";
import { costOf } from "../shared/pricing.js";

/** `<ISO stamp with [:.]→->-step-` — the prefix dispatch.js gives every run log. */
export const RUN_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-step-/;
const RUN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-step-.+\.log$/;

/** dispatch.js's filename mapping of a ref. @param {string} ref */
export const safeRef = (ref) => String(ref).replace(/[^A-Za-z0-9_.-]/g, "_");

/** A known profile's state dir, or null. Only state keys `listProfiles` returns are accepted
 * (never a label — the UI API addresses profiles by state key).
 * @param {string} registry @param {string} profile */
export function profileDir(registry, profile) {
  if (!profile || !listProfiles(registry).some((p) => p.stateKey === profile)) return null;
  return path.join(registry, profile);
}

/**
 * The absolute path of one run log, or null unless: the profile is known, `run` is a plain
 * run-log basename that is actually listed in its `logs/`, and its realpath stays there
 * (a symlink out of the dir is rejected).
 * @param {string} registry @param {string} profile @param {string} run
 * @returns {string|null}
 */
export function resolveRunLog(registry, profile, run) {
  const dir = profileDir(registry, profile);
  if (!dir || typeof run !== "string") return null;
  if (run !== path.basename(run) || /[/\\\0]/.test(run) || run === "." || run === "..") return null;
  if (!RUN_RE.test(run)) return null;
  const logs = path.join(dir, "logs");
  try {
    if (!fs.readdirSync(logs).includes(run)) return null;
    const root = fs.realpathSync(logs);
    const real = fs.realpathSync(path.join(logs, run));
    if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/** `2026-10-08T15-31-28-123Z-step-…` → `2026-10-08T15:31:28.123Z`. @param {string} name */
const stampOf = (name) => {
  const m = RUN_PREFIX_RE.exec(name);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
};

/** A run_end's measured energy (src/shared/energy.js), when it has a finite one; else `{}`.
 * @param {Record<string, any>|null} end @returns {{ energyKwh?: number, energyUsd?: number }} */
function energyOf(end) {
  const kWh = end?.energyKwh;
  if (typeof kWh !== "number" || !Number.isFinite(kWh) || kWh < 0) return {};
  const usd = end?.energyUsd;
  return { energyKwh: kWh, energyUsd: typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : 0 };
}

/** A run_end's per-turn stats (#645), when `turns` is a finite number; else `{}`.
 * @param {Record<string, any>|null} end @returns {{turns?: number, firstContext?: number, peakContext?: number, lastContext?: number, compactions?: number}} */
function turnStatsOf(end) {
  if (typeof end?.turns !== "number" || !Number.isFinite(end.turns)) return {};
  /** @type {{turns: number, firstContext?: number, peakContext?: number, lastContext?: number, compactions?: number}} */
  const out = { turns: end.turns };
  for (const k of /** @type {const} */ (["firstContext", "peakContext", "lastContext", "compactions"])) {
    if (typeof end[k] === "number" && Number.isFinite(end[k])) out[k] = end[k];
  }
  return out;
}

/**
 * A ref's runs, newest first. `outcome`/`costUsd` come from the first `run_end` for the same
 * (ref, step) at or after the log's stamp and before that step's next run; null when it isn't
 * in `events` (still running, or older than the events tail). `running` = no outcome yet, it's
 * the ref's newest run, and running.json has the ref on that step. `estUsd`/`costBasis` follow
 * src/shared/pricing.js `costOf` (the run_end's stamp, else the profile's rates); `energyKwh`/`energyUsd`
 * ride along when the run was measured (src/shared/energy.js). `model`/`harness` come from the matching
 * `run_end` when it names them, else the matching `run_start` (found the same way as the end: same
 * step, at/after this run's stamp, before the step's next run) — so a running run, or one whose
 * run_end carries no model, still shows what it started with.
 * @param {string} registry @param {string} profile @param {string} ref
 * @param {Record<string, any>[]} events  the profile's events tail, oldest first
 * @param {Record<string, import('../shared/pricing.js').Rate>|null} [pricing]  the heartbeat's `pricing` overrides
 * @returns {import('../shared/contract.js').RunView[]}
 */
export function listRuns(registry, profile, ref, events, pricing = null) {
  const dir = profileDir(registry, profile);
  if (!dir) return [];
  const logs = path.join(dir, "logs");
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(logs);
  } catch {
    return [];
  }
  const suffix = `-${safeRef(ref)}.log`;
  // Steps this profile is known to run. A filename can't separate `<step>-<ref>` on its own:
  // ref "5"'s suffix also matches ref "x-5"'s `code-x-5`; an unknown step that extends a
  // known one with "-" is that longer ref's log, not ours.
  const known = new Set();
  for (const e of events) if (typeof e.step === "string" && e.step) known.add(e.step);
  const running = readStateFile(dir, "running");
  for (const r of Object.values(running)) if (isObj(r) && typeof r.stepId === "string") known.add(r.stepId);

  /** @type {{ run: string, step: string, startedAt: string, bytes: number }[]} */
  const found = [];
  for (const run of names) {
    const m = RUN_PREFIX_RE.exec(run);
    if (!m || !run.endsWith(suffix) || run.length <= m[0].length + suffix.length) continue;
    const step = run.slice(m[0].length, -suffix.length);
    if (!known.has(step) && [...known].some((k) => step.startsWith(k + "-"))) continue;
    /** @type {fs.Stats} */
    let st;
    try {
      st = fs.lstatSync(path.join(logs, run)); // lstat: a symlink is never a run (resolveRunLog agrees)
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    found.push({ run, step, startedAt: /** @type {string} */ (stampOf(run)), bytes: st.size });
  }
  found.sort((a, b) => (a.run < b.run ? -1 : a.run > b.run ? 1 : 0));

  const ends = events.filter((e) => e.event === "run_end" && e.ref === ref && typeof e.ts === "string");
  const starts = events.filter((e) => e.event === "run_start" && e.ref === ref && typeof e.ts === "string");
  const cur = Object.hasOwn(running, ref) && isObj(running[ref]) ? running[ref] : null;
  /** @type {import('../shared/contract.js').RunView[]} */
  const out = [];
  found.forEach((r, i) => {
    const next = found.slice(i + 1).find((n) => n.step === r.step)?.startedAt ?? null;
    const end = ends.find((e) => e.step === r.step && e.ts >= r.startedAt && (next === null || e.ts < next)) || null;
    const start = starts.find((e) => e.step === r.step && e.ts >= r.startedAt && (next === null || e.ts < next)) || null;
    const model = (end && typeof end.model === "string" && end.model ? end.model : null) ?? (start && typeof start.model === "string" && start.model ? start.model : null);
    const harness = (end && typeof end.harness === "string" && end.harness ? end.harness : null) ?? (start && typeof start.harness === "string" && start.harness ? start.harness : null);
    const outcome = end && typeof end.outcome === "string" ? end.outcome : null;
    const c = end ? costOf(end, pricing) : {};
    out.push({
      run: r.run,
      step: r.step,
      startedAt: r.startedAt,
      outcome,
      ...(model ? { model } : {}),
      ...(harness ? { harness } : {}),
      ...(end && ["agent", "repaired", "deduced"].includes(end.verdictSource) ? { verdictSource: end.verdictSource } : {}),
      ...(end && typeof end.plain === "string" && end.plain ? { plain: end.plain.slice(0, 300) } : {}),
      costUsd: end && typeof end.costUsd === "number" && Number.isFinite(end.costUsd) ? end.costUsd : null,
      unpriced: !!end && end.unpriced === true,
      estUsd: c.estUsd ?? null,
      costBasis: c.costBasis ?? null,
      ...energyOf(end),
      ...turnStatsOf(end),
      endedAt: end && typeof end.ts === "string" ? end.ts : null,
      running: !end && i === found.length - 1 && !!cur && cur.stepId === r.step,
      bytes: r.bytes,
    });
  });
  return out.reverse();
}
