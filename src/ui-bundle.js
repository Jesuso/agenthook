// Pure check for the `ui/dist` bundle vs. `ui/src` — shared by `ah ui` (src/commands/ui.js)
// and `ah doctor` (src/commands/doctor.js). Kept dependency-free so doctor doesn't pull in
// `src/ui/server.js` just to warn about a stale bundle.
import fs from "node:fs";
import path from "node:path";

/** Newest mtime of any file under `dir`, skipping `*.test.*` files (not part of the bundle).
 * @param {string} dir @returns {{path: string, mtimeMs: number}|null} */
function newestSourceFile(dir) {
  /** @type {{path: string, mtimeMs: number}|null} */
  let newest = null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = newestSourceFile(full);
      if (sub && (!newest || sub.mtimeMs > newest.mtimeMs)) newest = sub;
      continue;
    }
    if (entry.name.includes(".test.")) continue;
    const mtimeMs = fs.statSync(full).mtimeMs;
    if (!newest || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
  }
  return newest;
}

/** Whether the built bundle is missing or older than `ui/src` (a `git pull` that touched the
 * frontend with no rebuild). Quiet (`no-src`) when `ui/src` doesn't exist — an npm install ships
 * only `ui/dist`. Pure given the two dirs.
 * @param {{srcDir: string, distDir: string}} args
 * @returns {{state: 'no-src'|'missing'|'stale'|'fresh', newest?: string}} */
export function uiBundleState({ srcDir, distDir }) {
  if (!fs.existsSync(srcDir)) return { state: "no-src" };
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) return { state: "missing" };
  const newest = newestSourceFile(srcDir);
  if (!newest || newest.mtimeMs <= fs.statSync(indexPath).mtimeMs) return { state: "fresh" };
  return { state: "stale", newest: path.relative(srcDir, newest.path) };
}
