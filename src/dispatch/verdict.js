// The agent's verdict: pure parsing (outcome, summary, timeout reason) plus the per-dispatcher
// readVerdict and the changes-loop guard.
import fs from "node:fs";
import { sanitizePaths } from "../overlap.js";
import { findStep, prevStep, DEFAULT_MAX_ATTEMPTS } from "../pipeline.js";

/** The fail reason for a killed run. @param {"max"|"idle"} kind @param {number} minutes */
export function timeoutReason(kind, minutes) {
  return kind === "max" ? `timeout: exceeded maxMinutes=${minutes}` : `timeout: no output for idleMinutes=${minutes}`;
}

const DIFFICULTIES = /** @type {const} */ (["easy", "medium", "hard"]);

/** Serialised-size cap for a verdict's free-form `summary` object. */
export const MAX_SUMMARY_CHARS = 300;

/**
 * The verdict's optional `summary`: a small plain object, stored as-is (never interpreted)
 * for supervisors. Anything else — non-object, array, null, or over MAX_SUMMARY_CHARS
 * serialised — is dropped with one log line; it never affects the outcome.
 * @param {unknown} raw
 * @returns {Record<string, unknown>|undefined}
 */
export function parseSummary(raw) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.log("[verdict] dropping summary (non-object)");
    return undefined;
  }
  const n = JSON.stringify(raw).length; // raw came from JSON.parse — always serialisable
  if (n > MAX_SUMMARY_CHARS) {
    console.log(`[verdict] dropping summary (oversize ${n} chars)`);
    return undefined;
  }
  return /** @type {Record<string, unknown>} */ (raw);
}

const MAX_FINDINGS = 20000;

/**
 * Resolve the run's verdict from (exit code, raw verdict-file text or null when
 * unreadable). A non-zero exit is a crashed/errored agent → fail, and its text is NOT
 * trusted. A clean exit honors a valid verdict; a missing/garbage one defaults to
 * `advance` (the "clean exit advances" spine from P1) unless the step opts into
 * `requireVerdict`, which holds it instead so a weak/local `bin` that exits 0 without
 * doing the work doesn't get silently pushed to the next step.
 * @param {number} code @param {string|null} text @param {{requireVerdict?: boolean}} [opts]
 * @returns {import('../types.js').Verdict}
 */
export function parseVerdict(code, text, { requireVerdict = false } = {}) {
  if (code !== 0) return { outcome: "fail", reason: `non-zero exit (${code})` };
  let raw;
  if (text === null) {
    return requireVerdict
      ? { outcome: "hold", reason: "no valid verdict (requireVerdict)" }
      : { outcome: "advance", reason: "no verdict file — defaulting to advance" };
  }
  try {
    raw = JSON.parse(text);
  } catch {
    return requireVerdict
      ? { outcome: "hold", reason: "no valid verdict (requireVerdict)" }
      : { outcome: "advance", reason: "no verdict file — defaulting to advance" };
  }
  const allowed = ["advance", "fail", "hold", "changes"];
  if (!allowed.includes(raw?.outcome)) {
    return requireVerdict
      ? { outcome: "hold", reason: "no valid verdict (requireVerdict)" }
      : { outcome: "advance", reason: `unrecognized verdict ${JSON.stringify(raw?.outcome)} — defaulting to advance` };
  }
  return {
    outcome: raw.outcome,
    target: typeof raw.target === "string" ? raw.target : undefined,
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
    difficulty: DIFFICULTIES.includes(raw?.difficulty) ? raw.difficulty : undefined,
    findings: typeof raw.findings === "string" && raw.findings.trim()
      ? (raw.findings.length > MAX_FINDINGS ? `${raw.findings.slice(0, MAX_FINDINGS)}…(truncated)` : raw.findings)
      : undefined,
    paths: sanitizePaths(raw.paths),
    summary: parseSummary(raw.summary),
  };
}

// DEFAULT_MAX_ATTEMPTS (pipeline.js): how many times one step may run for a single ref
// before a `changes` loop back into it is forced to fail. Caps an endless code↔review
// ping-pong (each loop is a fresh `claude -p` under fullAuto = real money + code exec).
// Per-step `maxAttempts` overrides. See store.bumpAttempt/getAttempt.

/** @param {import('./context.js').DispatchState} ctx */
export function createVerdictOps(ctx) {
  const { cfg, store } = ctx;
  /** @param {number} code @param {string} verdictFile @param {import('../types.js').Step} step
   * @param {import('../types.js').AgentAdapter} agent  its `defaults.requireVerdict` applies when the step sets none
   * @returns {import('../types.js').Verdict} */
  function readVerdict(code, verdictFile, step, agent) {
    let text = null;
    try {
      text = fs.readFileSync(verdictFile, "utf8");
    } catch {
      /* missing/unreadable — parseVerdict treats text=null like garbage JSON */
    }
    return parseVerdict(code, text, { requireVerdict: !!(step?.requireVerdict ?? agent.defaults.requireVerdict ?? false) });
  }

  /**
   * Changes-loop guard: route a `changes` verdict back to its target step (verdict.target,
   * else the step before `stepId`), but only while that step is under its attempt cap. At
   * the cap, stop the ping-pong — force fail. Mutates `verdict` (target resolved to a
   * concrete id for the adapter) and stores the findings for the target's next prompt.
   * @param {string} ref
   * @param {string} stepId  the step the verdict moves the task out of
   * @param {import('../types.js').Verdict} verdict
   * @param {string} fromStep  who the findings are attributed to in the rework prompt
   */
  function guardChanges(ref, stepId, verdict, fromStep) {
    if (verdict.outcome !== "changes") return;
    const target = verdict.target ? findStep(cfg, verdict.target) : prevStep(cfg, stepId);
    if (!target) {
      verdict.outcome = "fail";
      verdict.reason = `changes had no resolvable target from "${stepId}"`;
      return;
    }
    const ran = store?.getAttempt(ref, target.id) ?? 0;
    const cap = target.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (ran >= cap) {
      verdict.outcome = "fail";
      verdict.reason = `changes loop hit cap (${cap}) on step "${target.id}"`;
      return;
    }
    verdict.target = target.id;
    const text = verdict.findings || verdict.reason;
    if (text && store) store.setFindings(ref, { target: target.id, fromStep, text });
  }

  return { readVerdict, guardChanges };
}

/** @typedef {ReturnType<typeof createVerdictOps>} VerdictOps */
