#!/usr/bin/env node
// agenthook CLI — one entry point for every subcommand. See docs/agenthook-v2.md.
//
//   agenthook init                 scaffold agenthook.config.json in the current dir
//   agenthook start [--detach]     boot this profile (ingress up → register → serve)
//   agenthook stop [--keep-hooks]  stop the receiver (and delete its webhooks)
//   agenthook ls                   table of all profiles + status
//   agenthook status [name]        one profile in detail
//   agenthook follow [session-id]  tail a live agent transcript (read-only)
//   agenthook resume [ref]         print/run the claude --resume for a ref's agent
//   agenthook agents               list running `claude -p` processes
//   agenthook cleanup [--apply [--force]]   prune done agent worktrees
//   agenthook register <url>       manual webhook create (hosted/static URL)
//   agenthook unregister           delete this profile's webhooks
//   agenthook catchup <ref> [--force]   replay a missed item through the live server
//   agenthook reconcile            replay tasks resting in pipeline sections (explicit poll)
//   agenthook doctor               preflight checks for this profile
//   agenthook alias [--remove]     add/remove an `ah` short command (opt-in symlink)
//
// Global flag: --config <path> selects a config explicitly (default: discover
// agenthook.config.json from the current dir upward).
import { init } from "../src/commands/init.js";
import { start } from "../src/commands/start.js";
import { stop } from "../src/commands/stop.js";
import { ls } from "../src/commands/ls.js";
import { status } from "../src/commands/status.js";
import { follow } from "../src/commands/follow.js";
import { resume } from "../src/commands/resume.js";
import { agents } from "../src/commands/agents.js";
import { cleanup } from "../src/commands/cleanup.js";
import { register, unregister } from "../src/commands/webhook.js";
import { catchup } from "../src/commands/catchup.js";
import { reconcile } from "../src/commands/reconcile.js";
import { doctor } from "../src/commands/doctor.js";
import { alias } from "../src/commands/alias.js";

const VALUE_FLAGS = new Set(["config", "limit"]);

/** @param {string[]} argv */
function parse(argv) {
  /** @type {{_: string[], [k: string]: any}} */
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (VALUE_FLAGS.has(key)) args[key] = argv[++i];
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

/** @type {Record<string, (args: any) => Promise<void>>} */
const COMMANDS = { init, start, stop, ls, status, follow, resume, agents, cleanup, register, unregister, catchup, reconcile, doctor, alias };

const HELP = `agenthook — event-driven agentic development receiver

usage: agenthook <command> [args] [--config <path>]

  init                      scaffold agenthook.config.json (interactive)
  start [--detach]          boot this profile
  stop [--keep-hooks]       stop the receiver
  ls                        all profiles + status
  status [name]             one profile in detail
  follow [session-id]       tail a live agent (read-only)
  resume [ref [session]]    list a ref's sessions / print|--exec claude --resume for one
  agents                    running claude -p processes
  cleanup [--apply [--force]]   prune done worktrees
  register <url>            manual webhook create
  unregister                delete this profile's webhooks
  catchup <ref> [--force]   replay a missed item
  reconcile                 replay tasks resting in pipeline sections (explicit poll)
  doctor                    preflight checks
  alias [--remove]          add (or remove) an \`ah\` shortcut for \`agenthook\`
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`unknown command "${cmd}". Run \`agenthook help\`.`);
    process.exit(1);
  }
  await fn(parse(rest));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
