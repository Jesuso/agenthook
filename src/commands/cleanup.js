// `agenthook cleanup [--apply [--force]]` — tear down agent worktrees, but ONLY
// when truly done: the branch's PR is merged/closed OR the tracker item is
// completed. Agents never remove their own worktrees (INSTRUCTIONS §7); this is the
// one place that does. Provider-blind: PR state from `gh` run inside each worktree,
// item completion through the active tracker adapter. Dry-run unless --apply.
// Multi-repo profiles sweep every declared repo, tagging each line with its id.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createStore } from "../store.js";
import { createAdapter } from "../trackers/index.js";
import { worktreeDir } from "../paths.js";
import { listWorktrees } from "../worktree.js";
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

/** @param {any} args */
export async function cleanup(args) {
  const cfg = loadConfig({ configPath: args.config });
  const adapter = createAdapter(cfg, createStore(cfg.dataDir));
  const apply = !!args.apply;
  const force = !!args.force;

  let removed = 0;
  for (const repo of reposOf(cfg)) {
    const wtdir = worktreeDir(cfg, repo);
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
      if (!(rec.path === wtdir || rec.path.startsWith(wtdir + path.sep))) continue; // agent worktrees only

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
          const rm = run("git", ["-C", repo.path, "worktree", "remove", ...(force ? ["--force"] : []), rec.path]);
          console.log(rm.ok ? "        removed." : `        SKIP (dirty? use --force): ${rm.err}`);
          if (rm.ok) removed++;
        }
      } else {
        console.log(`${tag}KEEP    ${rec.path}  [branch=${rec.branch || "?"} item=${ref} done=${done} pr=${prstate || "none"}]`);
      }
    }

    if (apply) run("git", ["-C", repo.path, "worktree", "prune"]);
  }

  if (apply) {
    console.log(`(pruned stale refs; removed ${removed})`);
  } else {
    console.log("Dry run — re-run with --apply to remove the REMOVE-marked worktrees (add --force for dirty ones).");
  }
}
