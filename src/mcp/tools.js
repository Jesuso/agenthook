// The agenthook MCP tool set (docs/mcp.md). Reads come from the state dir (src/agent-api.js) and
// work with the receiver down; `board`/`prs` and every write go to the live receiver over its
// control socket (src/ops.js), which audits writes. `readOnly` omits the write tools entirely —
// they are neither listed nor callable.
import { registryDir } from "../config.js";
import {
  pickProfile,
  readStatus,
  readProfiles,
  readTick,
  readRuns,
  readRunLogTail,
  readEventsSince,
  waitForEvents,
  eventsCursor,
  compactEvent,
  etagOf,
  live,
} from "../agent-api.js";
import { readEventsTail } from "../ui/rows.js";
import { validateArgs } from "./schema.js";
import { listProfiles } from "../heartbeat.js";
import path from "node:path";
import fs from "node:fs";

const MAX_WAIT_S = 120;

/** The agent guide (docs/agent-guide.md) split by `## topic`, so an agent can pull one section. */
const GUIDE_FILE = new URL("../../docs/agent-guide.md", import.meta.url);
/** @returns {{intro: string, topics: Map<string, string>}} */
export function loadGuide(file = GUIDE_FILE) {
  const text = fs.readFileSync(file, "utf8");
  const parts = text.split(/^## /m);
  const topics = new Map();
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    topics.set(part.slice(0, nl).trim(), `## ${part}`.trimEnd());
  }
  return { intro: parts[0].trimEnd(), topics };
}

const PROFILE = { type: "string", description: "Profile state key or label. Omit to use the project's own profile (or the only running one)." };
const REF = { type: "string", description: "Task ref (tracker-native id; see `ref` in status/board output)." };

/** @param {string} description @param {Record<string, any>} properties @param {string[]} [required] */
const schema = (description, properties, required = []) => ({
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
});

/** @type {Record<string, {def: any, write?: boolean, destructive?: boolean}>} */
const TOOLS = {
  profiles: {
    def: schema("List every agenthook profile on this machine: up/down, slots in use, queued. Start here when unsure which profile.", {}),
  },
  guide: {
    def: schema(
      "How to use these tools well: pipeline model, response shapes, supervisor recipes (held / failed / stuck / red PR), event names, write-tool refusals, error meanings, gotchas. No topic = the topic list; topic \"all\" = everything. Read it once per session before acting.",
      { topic: { type: "string", description: "model | quickstart | shapes | recipes | events | writes | errors | gotchas | all" } },
    ),
  },
  status: {
    def: schema(
      "Live picture of one profile: slots {max,active,queued,free}, running agents (ref, step, ageS, model), queued jobs, held tasks (why), pause/restart flags. `free` is how many more tasks can start now. Pass `ifNoneMatch` with the last `etag` to get `{unchanged:true}` (near-zero tokens) when nothing changed. profile:\"*\" = all profiles.",
      { profile: PROFILE, ifNoneMatch: { type: "string", description: "etag from a previous status call" } },
    ),
  },
  tick: {
    def: schema(
      "One-call supervisor cycle: status + board (tickets resting per pipeline step) + open agent PRs (CI, conflicts) + events since `cursor`. Pass back the returned `cursor` next time. Board/PRs need a live receiver; each degrades to an *Error field alone. Use `ifNoneMatch` like status.",
      {
        profile: PROFILE,
        cursor: { type: "integer", description: "events.jsonl byte offset from a previous call; omit on the first call (events then start from now)" },
        board: { type: "boolean", description: "include board (default true)" },
        prs: { type: "boolean", description: "include agent PRs (default true)" },
        ifNoneMatch: { type: "string", description: "etag from a previous tick" },
      },
    ),
  },
  events: {
    def: schema(
      "Pipeline events after `cursor` (enqueued, run_start, run_end{outcome,costUsd}, failed, blocked, merged, ci_red, ci_green, pulled, pipeline_done, …). With `waitS` it blocks until a matching event arrives or the timeout — event-driven (no polling), so prefer one waiting call over a loop of status calls. First call: omit cursor (returns the current cursor, or the last N events with `last`).",
      {
        profile: PROFILE,
        cursor: { type: "integer", description: "byte offset returned by a previous call" },
        last: { type: "integer", description: "no cursor: return the last N events instead of none", minimum: 1, maximum: 200 },
        types: { type: "array", items: { type: "string" }, description: "only these event names, e.g. [\"run_end\",\"failed\",\"blocked\"]" },
        ref: REF,
        limit: { type: "integer", minimum: 1, maximum: 200, description: "max events (default 50)" },
        waitS: { type: "integer", minimum: 1, maximum: MAX_WAIT_S, description: "block up to this many seconds for a new matching event" },
      },
    ),
  },
  runs: {
    def: schema(
      "Run history of a task (newest first: step, outcome, cost, running?). Add `tail` to also get the last N lines of the newest run's transcript log (or of `step`/`run`) to see what an agent is doing or why it failed.",
      {
        profile: PROFILE,
        ref: REF,
        tail: { type: "integer", minimum: 1, maximum: 400, description: "also return the last N log lines" },
        step: { type: "string", description: "log of the newest run of this step" },
        run: { type: "string", description: "a specific run name from the list" },
      },
      ["ref"],
    ),
  },
  board: {
    def: schema(
      "Tickets resting in each pipeline step's source stage, plus the opt-in backlog lane, straight from the tracker (cached ~30s; `fresh` bypasses). Needs a live receiver.",
      { profile: PROFILE, fresh: { type: "boolean" } },
    ),
  },
  prs: {
    def: schema(
      "Open PRs on agent/<ref> branches with CI state (success|failure|pending|none|unknown — only `success` is green; cancelled/action-required count as failure, `unknown` = the CI lookup failed), mergeable/conflict state, draft. Needs a live receiver with a `forge` block (cached ~30s).",
      { profile: PROFILE, fresh: { type: "boolean" } },
    ),
  },
  pause: {
    write: true,
    def: schema("Stop STARTING new agents and pulling backlog (running ones finish; new events still queue). `status.slots.free` reads 0 while paused. Reverse with `resume`.", { profile: PROFILE }),
  },
  resume: {
    write: true,
    def: schema("Undo `pause`: start queued work and pull the backlog into free slots. No effect while a restart/shutdown owns the queue.", { profile: PROFILE }),
  },
  set_concurrency: {
    write: true,
    def: schema("Change the concurrent-agent cap at runtime (1..64). Not persisted: a restart returns to the config value.", { profile: PROFILE, max: { type: "integer", minimum: 1, maximum: 64 } }, ["max"]),
  },
  run: {
    write: true,
    def: schema(
      "Start work on a task: assign it to the token's account and move it into a step's source stage (default: the first step); the tracker webhook then fires the step. Refuses a task already in the pipeline unless `force`. Same as `agenthook run`.",
      {
        profile: PROFILE,
        ref: REF,
        step: { type: "string", description: "step id (default first step)" },
        assign: { type: "boolean", description: "assign to the token's account (default true)" },
        force: { type: "boolean", description: "skip the already-in-pipeline guard (risks two agents on one worktree)" },
      },
      ["ref"],
    ),
  },
  cancel: {
    write: true,
    destructive: true,
    def: schema(
      "Abandon a task: stop its live agent (SIGTERM→SIGKILL; resolves as fail → failure lane, worktree kept), and/or drop its waiting queue entries, and/or drop its HELD record. A waiting or held task is moved to the failure lane too, so reconcile/restart will not re-fire it (`moved:false` + `moveError` if the tracker call failed). Errors if the ref is not running, queued or held.",
      { profile: PROFILE, ref: REF },
      ["ref"],
    ),
  },
  release: {
    write: true,
    def: schema(
      "Resume a HELD task (an agent asked for input) with your answer as `comment` — same as an owner's `@agent` reply. Errors if the task is not held or its step hit maxAttempts.",
      { profile: PROFILE, ref: REF, comment: { type: "string", description: "the answer/instruction appended to the resumed step's prompt" } },
      ["ref", "comment"],
    ),
  },
  dismiss: {
    write: true,
    def: schema(
      "Acknowledge a FAILED or CANCELLED task so the dashboard stops counting it as needing attention (writes a `dismissed` event; the ticket and board are untouched). Errors if the task is running, queued or held. A later run of the ref shows up normally.",
      { profile: PROFILE, ref: REF },
      ["ref"],
    ),
  },
  reconcile: {
    write: true,
    def: schema("Replay tasks resting in pipeline source stages (explicit one-shot board read). For items missed during downtime.", { profile: PROFILE }),
  },
  pull: {
    write: true,
    def: schema("Fill free slots from the opt-in backlog (queue stage) now, instead of waiting for the next run to finish.", { profile: PROFILE }),
  },
  restart: {
    write: true,
    destructive: true,
    def: schema("Restart the receiver once idle: pauses new runs, restarts when active agents reach 0, queue preserved. Use after pulling new agenthook code.", { profile: PROFILE }),
  },
};

/**
 * @param {{readOnly?: boolean, defaultProfile?: string|null, registry?: string, actor?: string}} [o]
 * @returns {import('./server.js').ToolHandlers}
 */
export function createTools({ readOnly = false, defaultProfile = null, registry = registryDir, actor = "mcp" } = {}) {
  const enabled = Object.entries(TOOLS).filter(([, t]) => !(readOnly && t.write));

  /** @param {any} args */
  const target = (args) => {
    const r = pickProfile(args?.profile, defaultProfile, registry);
    if ("error" in r) throw new Error(r.error);
    return r.entry;
  };

  /** @type {Record<string, (args: any, ctx: {signal: AbortSignal}) => Promise<any>>} */
  const impl = {
    async profiles() {
      return readProfiles(registry);
    },
    async guide(args) {
      const { topics } = loadGuide();
      if (!args.topic) return { topics: [...topics.keys()], hint: "call guide {topic} for one section, or {topic:\"all\"}" };
      if (args.topic === "all") return [...topics.values()].join("\n\n");
      const t = topics.get(String(args.topic).toLowerCase());
      if (!t) throw new Error(`guide: unknown topic "${args.topic}". Topics: ${[...topics.keys()].join(", ")}`);
      return t;
    },
    async status(args) {
      if (args.profile === "*") return listProfiles(registry).filter((p) => !p.ghost && p.up).map((p) => readStatus(p));
      const s = readStatus(target(args));
      return args.ifNoneMatch && args.ifNoneMatch === s.etag ? { unchanged: true, etag: s.etag } : s;
    },
    async tick(args) {
      const entry = target(args);
      const t = await readTick(entry, { cursor: args.cursor, board: args.board !== false, prs: args.prs !== false, registry });
      return args.ifNoneMatch && args.ifNoneMatch === t.etag ? { unchanged: true, etag: t.etag, cursor: t.cursor } : t;
    },
    async events(args, { signal }) {
      const entry = target(args);
      const types = Array.isArray(args.types) && args.types.length ? new Set(args.types.map(String)) : null;
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
      if (!Number.isInteger(args.cursor)) {
        const cursor = eventsCursor(entry.dir);
        if (!args.last) return { events: [], cursor };
        const all = readEventsTail(path.join(entry.dir, "events.jsonl")).filter((e) => (!types || types.has(e.event)) && (!args.ref || e.ref === args.ref));
        return { events: all.slice(-args.last).map(compactEvent), cursor };
      }
      const waitS = Math.min(Number(args.waitS) || 0, MAX_WAIT_S);
      const r = waitS
        ? await waitForEvents(entry.dir, args.cursor, { types, ref: args.ref, limit, timeoutMs: waitS * 1000, signal })
        : { ...readEventsSince(entry.dir, args.cursor, { types, ref: args.ref, limit }), timedOut: false };
      return { events: r.events.map(compactEvent), cursor: r.cursor, ...(r.truncated ? { more: true } : {}), ...(r.timedOut ? { timedOut: true } : {}) };
    },
    async runs(args) {
      const entry = target(args);
      const runs = readRuns(entry.stateKey, args.ref, entry.dir, registry).slice(0, 10);
      if (!args.tail) return { runs };
      return { runs, log: readRunLogTail(entry.stateKey, args.ref, entry.dir, { lines: args.tail, step: args.step, run: args.run }, registry) };
    },
    async board(args) {
      const entry = target(args);
      return live(entry.stateKey, "board", { fresh: args.fresh === true }, { registry });
    },
    async prs(args) {
      const entry = target(args);
      const r = await live(entry.stateKey, "prs", { fresh: args.fresh === true }, { registry });
      return { at: r.at, prs: r.prs };
    },
  };

  // Writes: forward to the receiver, tagging the audit line with the actor.
  for (const [name, t] of Object.entries(TOOLS)) {
    if (!t.write) continue;
    impl[name] = async (args) => {
      const entry = target(args);
      const { profile: _p, ...rest } = args;
      const cmd = name === "restart" ? "restart" : name;
      const payload = name === "restart" ? { when: "idle" } : { ...rest, actor };
      return live(entry.stateKey, cmd, payload, { registry });
    };
  }

  return {
    list: () =>
      enabled.map(([name, t]) => ({
        name,
        ...t.def,
        annotations: {
          readOnlyHint: !t.write,
          ...(t.write ? { destructiveHint: !!t.destructive } : {}),
          openWorldHint: false,
        },
      })),
    async call(name, args, ctx) {
      if (!enabled.some(([n]) => n === name)) {
        throw Object.assign(new Error(TOOLS[name] ? `tool "${name}" is disabled (read-only mode)` : `unknown tool "${name}"`), { code: "unknown_tool" });
      }
      const bad = validateArgs(TOOLS[name].def.inputSchema, args ?? {});
      if (bad) throw new Error(`${name}: ${bad}`);
      return impl[name](args ?? {}, ctx);
    },
  };
}

export { etagOf };
