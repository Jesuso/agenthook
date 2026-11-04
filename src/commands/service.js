// `agenthook service install|uninstall|status [name] [--dry-run] [--no-enable] [--stop]` — run a
// profile's receiver as a systemd --user service, so it comes back after a reboot or a crash
// (src/service.js). Linux only. Never runs sudo: starting at boot without a login needs the
// user's lingering on, which this prints for the user to run.
//
// install:   write ~/.config/systemd/user/agenthook-<key>.service, daemon-reload, enable it (not
//            start: a receiver already up from `start --detach` keeps running; `--no-enable` only
//            writes the file, `--dry-run` only prints it).
// uninstall: disable it (`--stop` also stops a running service), remove the file, daemon-reload.
// status:    whether the unit file exists, is enabled / active, and whether lingering is on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { peekConfig, installDir as defaultInstallDir, registryDir } from "../config.js";
import { resolveProfile } from "../heartbeat.js";
import { unitName, userUnitDir, renderUnit, defaultRunner, lingerEnabled, unsupportedReason } from "../service.js";

const USAGE = "usage: agenthook service install|uninstall|status [name] [--dry-run] [--no-enable] [--stop]";

/**
 * @typedef {{
 *   platform?: string, env?: NodeJS.ProcessEnv, home?: string, user?: string,
 *   run?: import('../service.js').Runner, execPath?: string, installDir?: string,
 * }} ServiceDeps  injectable for tests; defaults are the real process/system
 */

/**
 * Which config the command targets: a named profile's (from its state dir), else --config / the
 * one discovered from cwd.
 * @param {any} args
 */
function target(args) {
  const name = args._[1];
  let configPath = args.config;
  if (name) {
    const p = resolveProfile(String(name));
    if (!p) throw new Error(`unknown profile "${name}"`);
    if (!p.configPath) throw new Error(`profile "${name}" has no recorded config path; run this from its directory instead`);
    configPath = p.configPath;
  }
  return peekConfig({ configPath });
}

/** @param {any} args @param {ServiceDeps} [deps] */
export async function service(args, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRunner;
  const user = deps.user ?? os.userInfo().username;
  const sub = args._[0];
  if (!["install", "uninstall", "status"].includes(sub)) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const why = unsupportedReason(platform);
  if (why) {
    console.error(why);
    process.exitCode = 1;
    return;
  }
  const cfg = target(args);
  const unit = unitName(cfg.stateKey);
  const file = path.join(userUnitDir({ env, home: deps.home }), unit);
  /** @param {string[]} a */
  const systemctl = (a) => run("systemctl", ["--user", ...a]);
  /** @param {string[]} a */
  const must = (a) => {
    const r = systemctl(a);
    if (r.status !== 0) throw new Error(`systemctl --user ${a.join(" ")} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
    return r;
  };
  const linger = () => {
    const on = lingerEnabled(run, user);
    if (on === true) return "lingering: on (starts at boot, no login needed)";
    const hint = `run once: loginctl enable-linger ${user}   (some systems need sudo; agenthook never runs it)`;
    return on === false ? `lingering: off — the service starts only once you log in. To start it at boot, ${hint}` : `lingering: unknown — to start the service at boot without a login, ${hint}`;
  };

  if (sub === "install") {
    const text = renderUnit({
      name: cfg.name,
      stateKey: cfg.stateKey,
      configPath: cfg.configPath,
      execPath: deps.execPath ?? process.execPath,
      installDir: deps.installDir ?? defaultInstallDir,
      pathEnv: env.PATH,
      home: env.AGENTHOOK_HOME ? registryDir : undefined,
    });
    if (args["dry-run"]) {
      console.log(`# ${file}`);
      process.stdout.write(text);
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`wrote ${file}`);
    if (args["no-enable"]) {
      console.log(`not enabled (--no-enable). Enable with: systemctl --user daemon-reload && systemctl --user enable ${unit}`);
      return;
    }
    must(["daemon-reload"]);
    must(["enable", unit]);
    console.log(`enabled ${unit}: systemd starts "${cfg.name}" at login and restarts it if it dies`);
    console.log(
      `not started now (a receiver already running keeps running). To hand it over: agenthook stop --keep-hooks --config ${cfg.configPath} && systemctl --user start ${unit}`,
    );
    console.log(linger());
    return;
  }

  if (sub === "uninstall") {
    const exists = fs.existsSync(file);
    if (!exists) console.log(`no unit file at ${file}`);
    const r = systemctl(["disable", ...(args.stop ? ["--now"] : []), unit]);
    if (r.status === 0) console.log(`disabled ${unit}${args.stop ? " and stopped it" : ""}`);
    else if (exists) console.error(`systemctl --user disable ${unit}: ${(r.stderr || r.stdout).trim()}`);
    if (exists) {
      fs.rmSync(file, { force: true });
      console.log(`removed ${file}`);
    }
    systemctl(["daemon-reload"]);
    if (!args.stop) console.log(`a receiver the service started keeps running; stop it with: agenthook stop --config ${cfg.configPath}`);
    return;
  }

  // status
  const exists = fs.existsSync(file);
  const enabled = systemctl(["is-enabled", unit]).stdout.trim() || "unknown";
  const active = systemctl(["is-active", unit]).stdout.trim() || "unknown";
  console.log(`${unit}`);
  console.log(`  unit file: ${exists ? file : "not installed"}`);
  console.log(`  enabled:   ${enabled}`);
  console.log(`  active:    ${active}`);
  console.log(`  ${linger()}`);
  if (!exists) console.log(`  install with: agenthook service install ${cfg.stateKey}`);
}
