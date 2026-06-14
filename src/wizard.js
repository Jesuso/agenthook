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
 * @property {(value: any, answers: Record<string, any>) => true|string} [validate]
 */

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
        const choices = await resolveChoices(step.choices, answers);
        if (!choices.length) throw new Error(`no choices available for "${step.key}"`);
        console.log(`\n${step.message}`);
        choices.forEach((c, i) => console.log(`  ${i + 1}) ${c.title}`));
        for (;;) {
          const def = step.default != null ? choices.findIndex((c) => c.value === step.default) + 1 : 1;
          const raw = (await rl.question(`  choice [${def}]: `)).trim();
          const n = raw === "" ? def : Number(raw);
          if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
            answers[step.key] = choices[n - 1].value;
            break;
          }
          console.log(`  enter 1-${choices.length}`);
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
