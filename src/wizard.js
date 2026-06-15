// Minimal interactive prompt runner for `agenthook init`. Zero deps — built on
// node:readline/promises. Tracker/ingress adapters contribute steps (optionally
// with live, API-backed choices) via their wizardSteps() hook, so init stays
// blind to any one platform.
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * @typedef {object} WizardStep
 * @property {string} key                  answer key written into the answers object
 * @property {string} message              prompt text shown to the user
 * @property {'text'|'select'|'confirm'} [type]  default "text"
 * @property {any} [default]               default value (Enter accepts it)
 * @property {(answers: Record<string, any>) => boolean} [when]  skip the step when false
 * @property {Array<{title:string,value:any}>
 *           | ((answers: Record<string, any>) => Promise<Array<{title:string,value:any}>>)} [choices]
 *                                         for type "select"; may fetch live (API discovery)
 * @property {(query: string, answers: Record<string, any>) => Promise<Array<{title:string,value:any}>>} [search]
 *                                         for type "select"; live server-side search by query. When
 *                                         present the picker prompts for a query each round instead of
 *                                         (or in addition to) the static `choices` list — use it when the
 *                                         option set is too large to enumerate (e.g. capped API listings).
 * @property {(value: any, answers: Record<string, any>) => true|string} [validate]
 */

const MAX_SHOWN = 50; // cap rows printed per round so a huge result set stays scannable

/** @param {WizardStep['choices']} choices @param {Record<string,any>} answers */
async function resolveChoices(choices, answers) {
  return typeof choices === "function" ? await choices(answers) : choices || [];
}

/**
 * Run a list of steps, mutating and returning `answers`.
 * @param {WizardStep[]} steps
 * @param {Record<string, any>} [answers]
 * @returns {Promise<Record<string, any>>}
 */
export async function runWizard(steps, answers = {}) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (const step of steps) {
      if (step.when && !step.when(answers)) continue;

      if (step.type === "select") {
        // Two pickers. Small static lists keep the plain numbered prompt. Large lists
        // (or any step with a live `search`) switch to a filter loop so you can narrow
        // by typing instead of scrolling — and `search` reaches options the static list
        // may never include (e.g. an API capped at the first N results).
        const all = step.search ? null : await resolveChoices(step.choices, answers);
        if (all && !all.length) throw new Error(`no choices available for "${step.key}"`);
        console.log(`\n${step.message}`);

        if (!step.search && all && all.length <= MAX_SHOWN) {
          all.forEach((c, i) => console.log(`  ${i + 1}) ${c.title}`));
          for (;;) {
            const def = step.default != null ? all.findIndex((c) => c.value === step.default) + 1 : 1;
            const raw = (await rl.question(`  choice [${def}]: `)).trim();
            const n = raw === "" ? def : Number(raw);
            if (Number.isInteger(n) && n >= 1 && n <= all.length) {
              answers[step.key] = all[n - 1].value;
              break;
            }
            console.log(`  enter 1-${all.length}`);
          }
          continue;
        }

        // Filter loop: prompt a query, list matches, pick a number — or blank to refine.
        for (;;) {
          const query = (await rl.question(`  filter (type to narrow, blank = list all): `)).trim();
          const matches = step.search
            ? await step.search(query, answers)
            : query
              ? /** @type {Array<{title:string,value:any}>} */ (all).filter((c) =>
                  c.title.toLowerCase().includes(query.toLowerCase()))
              : /** @type {Array<{title:string,value:any}>} */ (all);
          if (!matches.length) {
            console.log("  no matches — try a different filter");
            continue;
          }
          const shown = matches.slice(0, MAX_SHOWN);
          shown.forEach((c, i) => console.log(`  ${i + 1}) ${c.title}`));
          if (matches.length > MAX_SHOWN) console.log(`  …and ${matches.length - MAX_SHOWN} more — refine the filter`);
          const raw = (await rl.question(`  choice (number, or blank to filter again): `)).trim();
          if (raw === "") continue;
          const n = Number(raw);
          if (Number.isInteger(n) && n >= 1 && n <= shown.length) {
            answers[step.key] = shown[n - 1].value;
            break;
          }
          console.log(`  enter 1-${shown.length}, or blank to filter again`);
        }
        continue;
      }

      if (step.type === "confirm") {
        const def = step.default === false ? "n" : "y";
        const raw = (await rl.question(`${step.message} (y/n) [${def}]: `)).trim().toLowerCase();
        answers[step.key] = (raw === "" ? def : raw).startsWith("y");
        continue;
      }

      // text
      for (;;) {
        const suffix = step.default != null && step.default !== "" ? ` [${step.default}]` : "";
        let raw = (await rl.question(`${step.message}${suffix}: `)).trim();
        if (raw === "" && step.default != null) raw = String(step.default);
        const verdict = step.validate ? step.validate(raw, answers) : true;
        if (verdict === true) {
          answers[step.key] = raw;
          break;
        }
        console.log(`  ${verdict}`);
      }
    }
    return answers;
  } finally {
    rl.close();
  }
}
