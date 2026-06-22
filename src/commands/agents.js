// `agenthook agents` — list running headless `claude -p` agent processes (pid,
// runtime, step, ref). These are plain OS processes the receiver spawns; no claude
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
    const step = cmd.match(/the "([^"]+)" stage/)?.[1] || "?";
    const ref = cmd.match(/ Ref: (\S+)/)?.[1] || "?";
    console.log(`pid=${pid.padEnd(7)} ${etime.padEnd(11)} step=${step.padEnd(10)} ref=${ref}`);
    found++;
  }
  console.log(`── ${found} agent(s) running ──`);
}
