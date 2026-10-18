// Best-effort PR lookup for a ref's deterministic branch (`gh pr list --head`).
import { execFile } from "node:child_process";
import { branchName } from "../worktree.js";

// Upper bound on the best-effort `gh pr list` lookup, so a slow/absent `gh` never
// delays a run by more than this.
const PR_LOOKUP_TIMEOUT_MS = 5000;

/** @typedef {(cmd: string, args: string[], opts: {cwd: string, timeout: number}) => Promise<string>} ExecFn */

/** @type {ExecFn} */
const execOut = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/**
 * Best-effort PR number for a ref's deterministic branch (`gh pr list --head`). Any
 * error, timeout or empty result → undefined; never throws. Exported (with an
 * injectable exec) for offline tests.
 * @param {string} repoPath @param {string} ref @param {ExecFn} [exec]
 * @returns {Promise<number|undefined>}
 */
export async function lookupPr(repoPath, ref, exec = execOut) {
  try {
    const out = await exec(
      "gh",
      ["pr", "list", "--head", branchName(ref), "--state", "all", "--json", "number", "-q", ".[0].number"],
      { cwd: repoPath, timeout: PR_LOOKUP_TIMEOUT_MS },
    );
    const n = Number(String(out).trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}
