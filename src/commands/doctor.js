// `agenthook doctor` — preflight a profile before you trust it. Loads the config,
// then checks the things that silently break a run: missing token, repoPath not a
// git repo, claude/ngrok binaries absent, port already taken, ingress misconfigured.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config.js";

/** Is a TCP port already bound on 127.0.0.1? @param {number} port */
function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

/** @param {string} bin */
function onPath(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0;
}

/** Pipeline step bindings (the source-, success-, failure-, hold-prefixed keys)
 * left empty or still an `init` `TODO_*` placeholder. These pass every other
 * check yet match no incoming event, so the receiver silently does nothing — the
 * common first-run trap. Returns `step.id.key` per offender (absent optional
 * bindings are fine).
 * @param {import('../types.js').Step[]|null} pipeline */
export function unfilledBindings(pipeline) {
  /** @type {string[]} */
  const out = [];
  for (const step of pipeline || []) {
    for (const [k, v] of Object.entries(step)) {
      if (/^(source|success|failure|hold)/.test(k) && typeof v === "string" && (v.trim() === "" || v.startsWith("TODO_"))) {
        out.push(`${step.id}.${k}`);
      }
    }
  }
  return out;
}

/** @param {any} args */
export async function doctor(args) {
  /** @type {{ok:boolean, label:string, note?:string}[]} */
  const checks = [];
  /** @param {boolean} ok @param {string} label @param {string} [note] */
  const add = (ok, label, note) => checks.push({ ok, label, note });

  const cfg = loadConfig({ configPath: args.config }); // throws (and surfaces unset ${VARs}) if broken
  add(true, `config loaded: ${cfg.configPath}`);
  add(true, `profile "${cfg.name}" — state ${cfg.stateDir}`);

  add(!!cfg.providerConfig.token, `tracker token resolved (${cfg.provider})`, cfg.providerConfig.token ? "" : "empty — check the ${ENV} ref");

  const isGit = fs.existsSync(path.join(cfg.repoPath, ".git"));
  add(isGit, `repoPath is a git repo: ${cfg.repoPath}`, isGit ? "" : "no .git found");

  add(onPath(cfg.claudeBin), `claude binary on PATH: ${cfg.claudeBin}`);

  if (cfg.ingress.type === "ngrok") {
    add(onPath(process.env.NGROK || "ngrok"), "ngrok binary on PATH");
  } else {
    add(!!cfg.ingress.url, `ingress.url set (${cfg.ingress.type})`, cfg.ingress.url || "missing");
  }

  const busy = await portInUse(cfg.port);
  add(!busy, `port ${cfg.port} is free`, busy ? "something is already listening" : "");

  const unfilled = unfilledBindings(cfg.pipeline);
  add(!unfilled.length, "pipeline bindings filled", unfilled.length ? `unfilled/placeholder: ${unfilled.join(", ")}` : "");

  let bad = 0;
  for (const c of checks) {
    console.log(`${c.ok ? "✓" : "✗"} ${c.label}${c.note ? `  — ${c.note}` : ""}`);
    if (!c.ok) bad++;
  }
  console.log(bad ? `\n${bad} problem(s) found.` : `\nall good.`);
  if (bad) process.exitCode = 1;
}
