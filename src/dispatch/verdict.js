// The agent's verdict: pure parsing (outcome, summary, timeout reason) plus the per-dispatcher
// readVerdict and the changes-loop guard.
import fs from "node:fs";
import { sanitizePaths } from "../overlap.js";
import { findStep, prevStep, DEFAULT_MAX_ATTEMPTS } from "../pipeline.js";
import { parseFollowUp } from "../followup.js";

/** The fail reason for a killed run. @param {"max"|"idle"} kind @param {number} minutes */
export function timeoutReason(kind, minutes) {
  return kind === "max" ? `timeout: exceeded maxMinutes=${minutes}` : `timeout: no output for idleMinutes=${minutes}`;
}

const DIFFICULTIES = /** @type {const} */ (["easy", "medium", "hard"]);

/** Serialised-size cap for a verdict's free-form `summary` object (its `plain` key excluded). */
export const MAX_SUMMARY_CHARS = 300;

/** Cap for `summary.plain`, the one-sentence human summary: clipped, never counted toward MAX_SUMMARY_CHARS. */
export const MAX_PLAIN_CHARS = 300;

/** Cap for each `summary.options` entry (a short discrete answer the human can click instead of typing). */
export const MAX_OPTION_CHARS = 80;

/**
 * Validate `summary.options`: kept only as a whitespace-collapsed, trimmed array of 2–4
 * non-empty strings each ≤ MAX_OPTION_CHARS. Anything else (wrong length, non-string or
 * empty/oversize entry) is dropped whole.
 * @param {unknown} raw
 * @returns {string[]|undefined}
 */
function cleanOptions(raw) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) return undefined;
  const cleaned = raw.map((o) => (typeof o === "string" ? o.replace(/\s+/g, " ").trim() : null));
  if (cleaned.some((o) => !o || o.length > MAX_OPTION_CHARS)) return undefined;
  return /** @type {string[]} */ (cleaned);
}

/**
 * The verdict's optional `summary`: a small plain object, stored as-is (never interpreted)
 * for supervisors. Anything else — non-object, array, null, or over MAX_SUMMARY_CHARS
 * serialised — is dropped with one log line; it never affects the outcome. `plain` and
 * `options` are each measured on their own (dropped/clipped independently), so neither pushes
 * an otherwise-valid summary over the cap.
 * @param {unknown} raw
 * @returns {Record<string, unknown>|undefined}
 */
export function parseSummary(raw) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.log("[verdict] dropping summary (non-object)");
    return undefined;
  }
  const { plain, options, ...rest } = /** @type {Record<string, unknown>} */ (raw);
  const n = JSON.stringify(rest).length; // raw came from JSON.parse — always serialisable
  if (n > MAX_SUMMARY_CHARS) {
    console.log(`[verdict] dropping summary (oversize ${n} chars)`);
    return undefined;
  }
  if (options === undefined) {
    // No options: unchanged from before — return `raw` itself when nothing needs clipping/dropping.
    if (plain === undefined || (typeof plain === "string" && plain.length <= MAX_PLAIN_CHARS)) return /** @type {Record<string, unknown>} */ (raw);
    if (typeof plain !== "string") return rest;
    return { ...rest, plain: plain.slice(0, MAX_PLAIN_CHARS - 1).trimEnd() + "…" };
  }
  const cleanedOptions = cleanOptions(options);
  if (!cleanedOptions) console.log("[verdict] dropping summary.options (not 2-4 short strings)");
  /** @type {Record<string, unknown>} */
  const out = { ...rest };
  if (plain !== undefined && typeof plain === "string") out.plain = plain.length <= MAX_PLAIN_CHARS ? plain : plain.slice(0, MAX_PLAIN_CHARS - 1).trimEnd() + "…";
  if (cleanedOptions) out.options = cleanedOptions;
  return out;
}

const MAX_FINDINGS = 20000;

/** The hold reason for a clean exit with a missing/unparseable/unrecognized verdict file. */
export const NO_VALID_VERDICT = "no valid verdict";

/**
 * The hold reason for a clean exit with no valid verdict whose last line is a question.
 * Distinct from NO_VALID_VERDICT: it names the specific failure mode (the agent ended its turn
 * asking a question instead of acting) and carries the quoted question in the `reason` it
 * produces (see endedWithQuestion / finish.js).
 */
export const QUESTION_HOLD = "no verdict: the agent ended by asking a question instead of acting";

/** Max characters of a question line kept in a hold reason (a longer tail gets "…" clipped). */
export const MAX_QUESTION_CHARS = 200;

/**
 * Phrases that mark a line as a question even without a trailing "?" — small/local models end a
 * turn with a confirmation prompt ("want me to?", "should i…?") whose last line may drop the
 * mark. Matched case-insensitively on word boundaries, in the whitespace-collapsed line.
 */
const QUESTION_PHRASES = ["want me to", "should i", "shall i", "do you want", "let me know"];

/**
 * Detect that a run's last output line is a question, so a clean exit with no verdict holds with a
 * specific reason naming the question instead of the generic "no valid verdict". Takes the last
 * non-empty line (whitespace-collapsed, trimmed), strips trailing quote/markdown chars, and
 * reports it if it ends in "?" OR contains one of QUESTION_PHRASES. Returns the clipped question
 * (≤ MAX_QUESTION_CHARS, "…" when clipped) or undefined when the text is not a question — which
 * is the signal to fall back to the generic reason.
 * @param {string|undefined} text  the run's last output line (its stdout tail, or the final result text)
 * @returns {string|undefined}
 */
export function endedWithQuestion(text) {
  if (typeof text !== "string") return undefined;
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return undefined;
  const line = last.replace(/["'`*_)\]]+$/, "");
  // Ends in an ASCII or full-width question mark (a run of them), allowing trailing space,
  // OR carries one of the confirmation phrases — either marks a question.
  const questionish =
    /[?？]+\s*$/.test(line) ||
    QUESTION_PHRASES.some((p) => new RegExp(`\\b${p}\\b`, "i").test(line));
  if (!questionish) return undefined;
  return line.length > MAX_QUESTION_CHARS ? line.slice(0, MAX_QUESTION_CHARS - 1).trimEnd() + "…" : line;
}

/**
 * Resolve the run's verdict from (exit code, raw verdict-file text or null when
 * unreadable). A non-zero exit is a crashed/errored agent → fail, and its text is NOT
 * trusted. A clean exit honors a valid verdict; a missing/garbage one holds (a run that
 * can't write its verdict has not finished) unless the step opts out with
 * `requireVerdict: false`, which restores the old "clean exit advances" default.
 * @param {number} code @param {string|null} text @param {{requireVerdict?: boolean}} [opts]
 * @returns {import('../types.js').Verdict}
 */
export function parseVerdict(code, text, { requireVerdict = true } = {}) {
  if (code !== 0) return { outcome: "fail", reason: `non-zero exit (${code})` };
  let raw;
  if (text === null) {
    return requireVerdict
      ? { outcome: "hold", reason: NO_VALID_VERDICT }
      : { outcome: "advance", reason: "no verdict file — defaulting to advance" };
  }
  try {
    raw = JSON.parse(text);
  } catch {
    return requireVerdict
      ? { outcome: "hold", reason: NO_VALID_VERDICT }
      : { outcome: "advance", reason: "no verdict file — defaulting to advance" };
  }
  const allowed = ["advance", "fail", "hold", "changes"];
  if (!allowed.includes(raw?.outcome)) {
    return requireVerdict
      ? { outcome: "hold", reason: NO_VALID_VERDICT }
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
    // Only on an advance (an approval with checks to verify once the change is live); absent otherwise.
    ...(raw.outcome === "advance" && parseFollowUp(raw.followUp) ? { followUp: parseFollowUp(raw.followUp) } : {}),
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
    return parseVerdict(code, text, { requireVerdict: !!(step?.requireVerdict ?? agent.defaults.requireVerdict ?? true) });
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
