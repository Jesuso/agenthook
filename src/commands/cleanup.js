// `agenthook cleanup [--apply [--force]]` — tear down agent worktrees, but ONLY
// when truly done: the branch's PR is merged/closed OR the tracker item is
// completed. Agents never remove their own worktrees (INSTRUCTIONS §7); this is the
// one place that does. Provider-blind: PR state from `gh` run inside each worktree,
// item completion through the active tracker adapter. Dry-run unless --apply.
// Multi-repo profiles sweep every declared repo, tagging each line with its id.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createStore } from "../store.js";
import { createAdapter } from "../trackers/index.js";
import { worktreeDir, legacyWorktreeDir } from "../paths.js";
import { listWorktrees, gitArgv } from "../worktree.js";
import { reposOf } from "../repos.js";

/** @param {string} cmd @param {string[]} args @param {string} [cwd] */
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/** Best-effort: is this tracker item completed? "unknown" never blocks on API error.
 * @param {import('../types.js').Adapter} adapter @param {string} ref */
async function itemDone(adapter, ref) {
  if (!ref) return "unknown";
  try {
    const task = await adapter.fetchTask(ref);
    return task?.completed === true ? "true" : "false";
  } catch {
    return "unknown";
  }
}

// A live run's credentials dir is rewritten at least hourly (its token refresh), so one
// untouched this long belongs to a run that crashed before disposing it (#474).
export const RUN_CREDS_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Per-run credential dirs (`<dataDir>/run-creds/*`) untouched for `maxAgeMs`: the newest mtime
 * of the dir, its `gh/` and `gh/hosts.yml` (the refresh rewrites the file, not the dir).
 * @param {string} dataDir @param {{now?: number, maxAgeMs?: number}} [o] @returns {string[]} */
export function staleRunCreds(dataDir, { now = Date.now(), maxAgeMs = RUN_CREDS_MAX_AGE_MS } = {}) {
  const root = path.join(dataDir, "run-creds");
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((n) => path.join(root, n))
    .filter((dir) => {
      const newest = Math.max(
        ...[dir, path.join(dir, "gh"), path.join(dir, "gh", "hosts.yml")].map((p) => {
          try {
            return fs.statSync(p).mtimeMs;
          } catch {
            return 0;
          }
        }),
      );
      return now - newest > maxAgeMs;
    });
}

/** @param {any} args */
export async function cleanup(args) {
  const cfg = loadConfig({ configPath: args.config });
  const adapter = createAdapter(cfg, createStore(cfg.dataDir));
  const apply = !!args.apply;
  const force = !!args.force;

  let removed = 0;
  for (const repo of reposOf(cfg)) {
    const wtdir = worktreeDir(cfg, repo);
    const legacyWtdir = legacyWorktreeDir(cfg, repo);
    // Multi-repo lines carry the repo id; single-repo output stays as it was.
    const tag = cfg.multiRepo ? `[${repo.id}] ` : "";

    /** @type {{path:string, branch:string}[]} */
    let records;
    try {
      records = listWorktrees(repo.path);
    } catch (e) {
      throw new Error(`git worktree list failed${cfg.multiRepo ? ` (${repo.id})` : ""}: ${(e.stderr || e.message || "").toString().trim()}`);
    }

    for (const rec of records) {
      /** @param {string|null} dir */
      const underBase = (dir) => dir != null && (rec.path === dir || rec.path.startsWith(dir + path.sep));
      if (!(underBase(wtdir) || underBase(legacyWtdir))) continue; // agent worktrees only (new or legacy base)

      const prstate = rec.branch
        ? run("gh", ["pr", "list", "--head", rec.branch, "--state", "all", "--json", "state", "-q", ".[0].state"], rec.path)
            .out
        : "";
      const ref = path.basename(rec.path).split("-")[0];
      const done = await itemDone(adapter, ref);

      /** @type {string[]} */
      const reasons = [];
      if (done === "true") reasons.push("item-completed");
      if (prstate === "MERGED" || prstate === "CLOSED") reasons.push(`pr-${prstate}`);

      if (reasons.length) {
        console.log(`${tag}REMOVE  ${rec.path}  [branch=${rec.branch || "?"} item=${ref} pr=${prstate || "none"} -> ${reasons.join(",")}]`);
        if (apply) {
          const rm = run("git", gitArgv(cfg, repo.path, ["worktree", "remove", ...(force ? ["--force"] : []), rec.path]));
          console.log(rm.ok ? "        removed." : `        SKIP (dirty? use --force): ${rm.err}`);
          if (rm.ok) removed++;
        }
      } else {
        console.log(`${tag}KEEP    ${rec.path}  [branch=${rec.branch || "?"} item=${ref} done=${done} pr=${prstate || "none"}]`);
      }
    }

    if (apply) run("git", gitArgv(cfg, repo.path, ["worktree", "prune"]));
  }

  // Crash leftovers: a run that died before dispose. Its token has already expired (1h).
  for (const dir of staleRunCreds(cfg.dataDir)) {
    console.log(`REMOVE  ${dir}  [run credentials untouched > 2h]`);
    if (apply) fs.rmSync(dir, { recursive: true, force: true });
  }

  if (apply) {
    console.log(`(pruned stale refs; removed ${removed})`);
  } else {
    console.log("Dry run — re-run with --apply to remove the REMOVE-marked worktrees (add --force for dirty ones).");
  }
}
