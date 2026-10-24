#!/usr/bin/env node
// agenthook CLI — one entry point for every subcommand. See docs/agenthook-v2.md.
//
//   agenthook init                 scaffold agenthook.config.json in the current dir
//   agenthook init --local [--yes] [--full-auto] [--name <n>] [--port <n>]  zero-setup local-board profile (no token, no tunnel)
//   agenthook start [--detach]     boot this profile (ingress up → register → serve)
//   agenthook stop [--keep-hooks]  stop the receiver (and delete its webhooks)
//   agenthook rename <newName> [--move]  relabel this profile (--move: state dir follows)
//   agenthook restart              restart the running receiver once idle
//   agenthook remove <name|key> [--purge] [--yes] [--keep-hooks]  retire a profile: archive ~/.agenthook/<key>/ to ~/.agenthook-archive/ (running: decommission at idle; --purge = delete permanently, stopped only)
//   agenthook ls                   table of all profiles + status
//   agenthook status [name]        one profile in detail
//   agenthook follow [session-id] [--repo <id>]  tail a live agent transcript (read-only)
//   agenthook resume [ref]         print/run the claude --resume for a ref's agent
//   agenthook agents [name] [--all] [--verbose] [--json]  list running `claude -p` processes (this profile, or <name>; --all = every profile)
//   agenthook cleanup [--apply [--force]]   prune done agent worktrees
//   agenthook register <url>       manual webhook create (hosted/static URL)
//   agenthook unregister           delete this profile's webhooks
//   agenthook catchup <ref> [--force]   replay a missed item through the live server
//   agenthook run <ref> [stepId]   start work on an item: assign + enter the step's source stage
//   agenthook reconcile            replay tasks resting in pipeline sections (explicit poll)
//   agenthook ticket add "<title>" [--body <text>|--file <path>] [--step <id>]  add a ticket (local profiles)
//   agenthook ticket ls [--json]   the local board
//   agenthook doctor [--fix [--dry-run]]  preflight checks for this profile (--fix: apply safe local fixes)
//   agenthook alias [--remove]     add/remove an `ah` short command (opt-in symlink)
//   agenthook ui [--port <n>] [--no-open]  local web dashboard + editors (127.0.0.1 only)
//   agenthook mcp [--read-only]    MCP server (stdio) for external agents — docs/mcp.md
//   agenthook tick [name] [--json] one-call status+board+PRs+events digest for agents
//   agenthook epics [name] [--ref <epic>] [--fresh] [--json]  epics list / one epic's tickets
//   agenthook digest [name] [--json] write + print a profile's Digest (no receiver needed)
//   agenthook watch [name] [--event a,b] [--ref r] [--timeout s] [--follow]  block until the next event (--follow: stream JSON lines)
//
// Global flag: --config <path> selects a config explicitly (default: discover
// agenthook.config.json from the current dir upward).
import { init } from "../src/commands/init.js";
import { start } from "../src/commands/start.js";
import { stop } from "../src/commands/stop.js";
import { rename } from "../src/commands/rename.js";
import { restart } from "../src/commands/restart.js";
import { remove } from "../src/commands/remove.js";
import { ls } from "../src/commands/ls.js";
import { status } from "../src/commands/status.js";
import { follow } from "../src/commands/follow.js";
import { resume } from "../src/commands/resume.js";
import { agents } from "../src/commands/agents.js";
import { cleanup } from "../src/commands/cleanup.js";
import { register, unregister } from "../src/commands/webhook.js";
import { catchup } from "../src/commands/catchup.js";
import { run } from "../src/commands/run.js";
import { reconcile } from "../src/commands/reconcile.js";
import { doctor } from "../src/commands/doctor.js";
import { alias } from "../src/commands/alias.js";
import { usage } from "../src/commands/usage.js";
import { events } from "../src/commands/events.js";
import { ui } from "../src/commands/ui.js";
import { mcp } from "../src/commands/mcp.js";
import { tick } from "../src/commands/tick.js";
import { epics } from "../src/commands/epics.js";
import { digest } from "../src/commands/digest.js";
import { watch } from "../src/commands/watch.js";
import { ticket } from "../src/commands/ticket.js";
import { guide } from "../src/commands/guide.js";
import { skill } from "../src/commands/skill.js";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const VALUE_FLAGS = new Set(["config", "limit", "ref", "event", "repo", "port", "cursor", "timeout", "heartbeat", "body", "file", "step", "name", "agent"]);

/** @param {string[]} argv */
export function parse(argv) {
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

/**
 * True if a `--help`/`-h` flag sits anywhere in the post-command args, so the
 * router shows usage instead of running the command. Pure so it's unit-testable
 * (`main()` runs on direct invocation only).
 * @param {string[]} rest
 */
export function wantsHelp(rest) {
  return rest.some((a) => a === "--help" || a === "-h");
}

/** @type {Record<string, (args: any) => Promise<void>>} */
const COMMANDS = { init, start, stop, ls, status, follow, resume, agents, cleanup, register, unregister, catchup, run, kick: run, "start-step": run, reconcile, ticket, doctor, alias, usage, events, ui, rename, restart, remove, mcp, tick, epics, digest, watch, guide, skill };

export const HELP = `agenthook — event-driven agentic development receiver

usage: agenthook <command> [args] [--config <path>]

  init                      scaffold agenthook.config.json (interactive)
  init --local [--yes] [--full-auto] [--name <n>] [--port <n>] [--force]
                            zero-setup profile on a local board in this git repo: no token, no tunnel
                            (fullAuto stays off unless --full-auto or an explicit yes)
                            port auto-picks from 4123, skipping ports listening or claimed by
                            another registered profile; --port <n> picks one explicitly
  start [--detach]          boot this profile
  stop [--keep-hooks]       stop the receiver
  rename <newName> [--move] relabel this profile (state key kept; inserts stateId);
                            --move also moves ~/.agenthook/<key>/ to <newName> (at idle if running)
  restart                   restart the running receiver once idle
  remove <name|key> [--purge] [--yes] [--keep-hooks]  retire a profile: archive ~/.agenthook/<key>/ to ~/.agenthook-archive/ (running: decommission at idle; --purge = delete permanently, stopped only)
  ls                        all profiles + status
  status [name]             one profile in detail
  follow [session-id] [--repo <id>]  tail a live agent (read-only; --repo = one repo only)
  resume [ref [session]]    list a ref's sessions / print|--exec claude --resume for one
  agents [name] [--all] [--verbose] [--json]  running claude -p processes (--all = every profile; --verbose = +pid/ref)
  cleanup [--apply [--force]]   prune done worktrees
  register <url>            manual webhook create
  unregister                delete this profile's webhooks
  catchup <ref> [--force]   replay a missed item
  run <ref> [stepId] [--force]  start work: assign + enter the step's source stage (alias: kick)
  reconcile                 replay tasks resting in pipeline sections (explicit poll)
  ticket add "<title>" [--body <text> | --file <path>] [--step <id>]
                            add a ticket to a local profile's board (the receiver fires it at once)
  ticket ls [--json]        a local profile's board: ref, stage, title
  doctor [--fix [--dry-run]]  preflight checks; --fix applies the safe local fixes, then re-checks
  alias [--remove]          add (or remove) an \`ah\` shortcut for \`agenthook\`
  usage [--ref <n>] [--day|--week] [--limit <n>]  token/cost records
  events [--follow] [--event <types>] [--ref <r|ID|#pr>] [--json]  read/tail the event bus
  ui [--port <n>] [--no-open]  local web dashboard + editors, all profiles (127.0.0.1; default port 4180)
  mcp [--read-only]         MCP server over stdio: read+manage the pipeline from an agent (all profiles)
  tick [name…|--all] [--json] [--cursor <n|json>] [--no-board] [--no-prs] [--epics]  status+board+PRs+new events in one call
                            (--all / ≥2 names: one per profile; --cursor '{"<key>":<n>}')
  epics [name] [--ref <epic>] [--fresh] [--json]  every epic's progress, or one epic's tickets
  digest [name] [--json]    write + print a profile's Digest (no receiver needed)
  watch [name…|--all] [--event a,b] [--ref r] [--cursor <n|json>] [--timeout <s>] [--json] [--follow|--stream [--heartbeat <s>]]  block until the next event (exit 2 on timeout); --follow stays attached, one JSON line per event with its resume cursor, then a final watch_end line
                            (--all / ≥2 names: first event from any profile, tagged; --cursor '{"<key>":<n>}')
  guide [topic]             the agent guide from a shell (same text as the MCP guide tool); \`authoring\` = how to create
                            tickets/epics/dependencies that THIS profile's receiver will pick up (rendered from the config)
  skill install [--agent a,b|all] [--repo [path]] [--dry-run]
                            install the portable agent skill (skills/agenthook) for the coding agents on this machine,
                            or into a project with --repo so the agents the receiver spawns there load it
  skill ls                  where the skill is installed and at which version
  --version, -v             print the installed version
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(pkg.version);
    return;
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`unknown command "${cmd}". Run \`agenthook help\`.`);
    process.exit(1);
  }
  if (wantsHelp(rest)) {
    console.log(HELP);
    return;
  }
  await fn(parse(rest));
}

// Run only when invoked directly (not when a test imports `wantsHelp`).
// realpath both sides so the npx/`ah` symlink resolves to this file.
if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
