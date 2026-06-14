// `agenthook agents` — list running headless `claude -p` agent processes (pid,
// runtime, kind, ref). These are plain OS processes the receiver spawns; no claude
// subcommand tracks them. Cross-platform via `ps` (-ww avoids arg truncation).
import { spawnSync } from "node:child_process";

export async function agents() {
  const ps = spawnSync("ps", ["-eo", "pid=,etime=,args=", "-ww"], { encoding: "utf8" });
  if (ps.status !== 0) throw new Error(`ps failed: ${ps.stderr || ps.error?.message || "unknown"}`);

  let found = 0;
  for (const line of ps.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, etime, cmd] = m;
    if (!cmd.includes("claude -p")) continue;
    if (cmd.includes("agenthook")) continue; // skip the CLI itself, just in case
    const kind = cmd.includes("A CHANGE has been requested") ? "change" : "implement";
    const ref = cmd.match(/ Ref: (\S+)/)?.[1] || "?";
    console.log(`pid=${pid.padEnd(7)} ${etime.padEnd(11)} kind=${kind.padEnd(9)} ref=${ref}`);
    found++;
  }
  console.log(`── ${found} agent(s) running ──`);
}
