// Pure prompt-assembly helpers: spec-heading detection, the step's model/effort, the
// prompt sidecar path, and the standing-instructions reader.
import fs from "node:fs";

/**
 * True iff every heading starts some line of `description`, case-insensitive, after
 * trimming leading whitespace and stripping heading/emphasis markers (`#`, `h1.`–`h6.`,
 * `*`, `_`, `>`). Empty/missing description → false. Pure. Exported for unit tests.
 * @param {string|undefined} description
 * @param {string[]} headings
 * @returns {boolean}
 */
export function descriptionHasHeadings(description, headings) {
  if (!description || !Array.isArray(headings) || !headings.length) return false;
  const lines = description.split(/\r?\n/).map((l) =>
    l.trim().replace(/^(?:h[1-6]\.|[#*_>])+\s*/i, "").toLowerCase());
  return headings.every((h) => {
    const want = String(h).trim().toLowerCase();
    return want !== "" && lines.some((l) => l.startsWith(want));
  });
}

/**
 * Resolve the effective model and effort for a step: base, then `lite` (when the task
 * description already carries the spec headings), then difficulty escalation on top.
 * Pure — no I/O. Exported for unit tests.
 * @param {import('../types.js').Step} step
 * @param {string|undefined} difficulty  the stored difficulty for this ref (may be absent)
 * @param {string} [description]  the task description, for `lite` gating
 * @returns {{model?: string, effort?: string}}
 */
export function resolveModelEffort(step, difficulty, description) {
  let base = { model: step.model, effort: step.effort };
  if (step.lite && descriptionHasHeadings(description, step.lite.descriptionHeadings)) {
    base = { model: step.lite.model ?? step.model, effort: step.lite.effort ?? step.effort };
  }
  if (!difficulty || !step.escalate?.[difficulty]) return base;
  const esc = step.escalate[difficulty];
  return {
    model: esc.model ?? base.model,
    effort: esc.effort ?? base.effort,
  };
}

/** The prompt sidecar path beside a run log (trailing `.log` → `.prompt.md`). Its
 * filename and the `=== TICKET ===` marker joining standing instructions to the base
 * prompt are a contract with `src/ui` (the v2 "what the agent sees" preview splits on
 * the marker) — changing either requires updating the UI. @param {string} logPath */
export function promptPathFor(logPath) {
  return logPath.replace(/\.log$/, ".prompt.md");
}

/** @param {string} file */
export const readInstructions = (file) => {
  // Read fresh each run so edits to a step's standing instructions need no restart.
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
};
