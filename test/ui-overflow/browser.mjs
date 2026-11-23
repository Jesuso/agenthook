// Pure option-building + failure classification for the real-browser overflow check
// (check.mjs, "Horizontal-overflow check" in docs/web-ui.md). No top-level side effects, no
// playwright import — check.mjs owns the server/browser/fixture lifecycle, this module only
// decides *how* to launch the browser and *what* a launch failure means.
//
// AH_OVERFLOW_BROWSER=<path> (an installed Chrome/Chromium executable):
//   - set and the path exists  → launch that executable (executablePath), never touching
//     playwright's own download/install path;
//   - set and the path is missing → an error line naming the variable and the path, exit 1
//     with or without CI (a typo in the variable is never a skip);
//   - unset or empty → today's playwright path: install chromium-headless-shell, then
//     launch with no executablePath; a download/launch failure there is a *skip* (exit 0,
//     or 1 when CI is set), and the line now points at AH_OVERFLOW_BROWSER.
import fs from "node:fs";

/** Every launch gets this wall-clock bound so a wedged browser can't hang the check. */
export const LAUNCH_TIMEOUT_MS = 30_000;

/** One-line reason from an error. @param {unknown} e */
export const brief = (e) =>
  String(e instanceof Error ? e.message : e).replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * Pick the browser plan from the environment.
 * @param {NodeJS.ProcessEnv} env
 * @param {(p: string) => boolean} [exists] injectable for tests; defaults to fs.existsSync.
 * @returns {{mode:"playwright", launchOptions:{timeout:number}} |
 *           {mode:"explicit", path:string, launchOptions:{executablePath:string, timeout:number}} |
 *           {mode:"error", line:string, code:1}}
 */
export function browserPlan(env, exists = fs.existsSync) {
  const raw = env.AH_OVERFLOW_BROWSER;
  if (raw === undefined || raw === "") return { mode: "playwright", launchOptions: { timeout: LAUNCH_TIMEOUT_MS } };
  if (!exists(raw)) return { mode: "error", line: `AH_OVERFLOW_BROWSER=${raw}: no such file`, code: 1 };
  return { mode: "explicit", path: raw, launchOptions: { executablePath: raw, timeout: LAUNCH_TIMEOUT_MS } };
}

/**
 * Classify an install/launch failure for a plan.
 * @param {{mode:string, path?:string}} plan
 * @param {unknown} err
 * @param {NodeJS.ProcessEnv} env
 * @returns {{line:string, code:number}}
 */
export function launchFailure(plan, err, env) {
  if (plan.mode === "explicit") {
    return { line: `AH_OVERFLOW_BROWSER=${plan.path}: cannot launch (${brief(err)})`, code: 1 };
  }
  return {
    line: `skipped: no browser available (${brief(err)}) — set AH_OVERFLOW_BROWSER to an installed Chrome/Chromium to use it`,
    code: env.CI ? 1 : 0,
  };
}
