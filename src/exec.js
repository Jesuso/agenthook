// General process helpers: run a CLI and collect its result, or check it's on PATH.
import { execFile, spawnSync } from "node:child_process";

/** One CLI call: a non-zero exit resolves, a spawn failure rejects.
 * @type {import('./types/index.js').IngressRun} */
export const execRun = (bin, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") return reject(err);
      resolve({ code: err ? Number(err.code) : 0, stdout, stderr });
    });
  });

/** @param {string} bin */
export function onPath(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0;
}
