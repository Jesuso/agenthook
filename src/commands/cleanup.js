// `agenthook cleanup [--apply [--force]]` — tear down agent worktrees, but ONLY
// when truly done: the branch's PR is merged/closed OR the tracker item is
// completed. Agents never remove their own worktrees (INSTRUCTIONS §7); this is the
// one place that does. Provider-blind: PR state from `gh` run inside each worktree,
// item completion through the active tracker adapter. Dry-run unless --apply.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createStore } from "../store.js";
import { createAdapter } from "../trackers/index.js";
import { worktreeDir } from "../paths.js";

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
  const repo = cfg.repoPath;
  const wtdir = worktreeDir(cfg);
  const apply = !!args.apply;
  const force = !!args.force;

  const list = run("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  if (!list.ok) throw new Error(`git worktree list failed: ${list.err}`);

  // Parse porcelain records into { path, branch }.
  /** @type {{path:string, branch:string}[]} */
  const records = [];
  let cur = { path: "", branch: "" };
  for (const line of list.out.split("\n")) {
    if (line.startsWith("worktree ")) cur = { path: line.slice(9), branch: "" };
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "") {
      if (cur.path) records.push(cur);
      cur = { path: "", branch: "" };
    }
  }
  if (cur.path) records.push(cur);

  let removed = 0;
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
      console.log(`REMOVE  ${rec.path}  [branch=${rec.branch || "?"} item=${ref} pr=${prstate || "none"} -> ${reasons.join(",")}]`);
      if (apply) {
        const rm = run("git", ["-C", repo, "worktree", "remove", ...(force ? ["--force"] : []), rec.path]);
        console.log(rm.ok ? "        removed." : `        SKIP (dirty? use --force): ${rm.err}`);
        if (rm.ok) removed++;
      }
    } else {
      console.log(`KEEP    ${rec.path}  [branch=${rec.branch || "?"} item=${ref} done=${done} pr=${prstate || "none"}]`);
    }
  }

  if (apply) {
    run("git", ["-C", repo, "worktree", "prune"]);
    console.log(`(pruned stale refs; removed ${removed})`);
  } else {
    console.log("Dry run — re-run with --apply to remove the REMOVE-marked worktrees (add --force for dirty ones).");
  }
}
