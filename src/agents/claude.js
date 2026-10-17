// The Claude Code agent adapter: how `claude -p` is invoked (argv), how its
// `--output-format stream-json` stdout becomes log text + a token tally + the final
// `result` event, how that result becomes a usage record, and where its session
// transcripts live (`~/.claude/projects/<mangle(cwd)>`, resumed with `claude -r <id>`).
// dispatch / follow / resume reach all of it through the AgentAdapter interface
// (src/types.js) — this is the reference adapter.
import { claudeProjectDir } from "../paths.js";

/** Reasoning-effort levels `claude -p --effort` accepts. An out-of-set value is
 * dropped (warn + omit the flag) so a typo falls back to the CLI default, never crashes. */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Build the `claude -p` argv (pure, exported so the flag wiring is unit-testable
 * without a real spawn). Order is stable: prompt, then --model, --effort, then
 * --dangerously-skip-permissions.
 * @param {{prompt: string, model?: string, effort?: string, fullAuto?: boolean}} o
 * @returns {string[]}
 */
export function buildClaudeArgs({ prompt, model, effort, fullAuto }) {
  // --output-format stream-json + --verbose: stdout becomes JSONL we parse for the
  // per-run log (assistant text) and the token/cost tally (the final `result` event).
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (model) args.push("--model", model);
  if (effort) {
    if (EFFORT_LEVELS.includes(effort)) args.push("--effort", effort);
    else console.warn(`[dispatch] ignoring invalid effort "${effort}" (expected ${EFFORT_LEVELS.join("|")})`);
  }
  if (fullAuto) args.push("--dangerously-skip-permissions");
  return args;
}

/**
 * Incremental parser for `claude -p --output-format stream-json --verbose` stdout:
 * one JSON object per line. Buffers partial lines across chunk boundaries, renders
 * assistant **text** content blocks to human-readable log text (non-text blocks and
 * non-JSON lines ignored — never throws), keeps a running token tally, and captures
 * the final `{type:"result"}` event. Pure (no I/O), stateful — feed chunks via push(),
 * flush() any tail at EOF, then read `.tally` / `.result`. Exported for unit tests.
 * @returns {{push:(chunk:string)=>string, flush:()=>string, tally:{input:number,output:number,cacheRead:number,cacheCreate:number}, result:any}}
 */
export function createStreamParser() {
  let buf = "";
  const tally = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  /** @type {any} */
  let result = null;

  /** @param {any} ev @returns {string} human-readable log text for this event */
  function handleEvent(ev) {
    if (!ev || typeof ev !== "object") return "";
    if (ev.type === "assistant" && ev.message && typeof ev.message === "object") {
      const u = ev.message.usage;
      if (u && typeof u === "object") {
        // Live estimate only (final record comes from the `result` event): sum output
        // across turns so the tally grows; track input/cache as the latest turn's values.
        if (typeof u.output_tokens === "number") tally.output += u.output_tokens;
        if (typeof u.input_tokens === "number") tally.input = u.input_tokens;
        if (typeof u.cache_read_input_tokens === "number") tally.cacheRead = u.cache_read_input_tokens;
        if (typeof u.cache_creation_input_tokens === "number") tally.cacheCreate = u.cache_creation_input_tokens;
      }
      const content = ev.message.content;
      let text = "";
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === "text" && typeof b.text === "string") text += b.text;
        }
      }
      return text ? text + "\n" : "";
    }
    if (ev.type === "result") {
      result = ev;
      const u = ev.usage;
      if (u && typeof u === "object") {
        if (typeof u.input_tokens === "number") tally.input = u.input_tokens;
        if (typeof u.output_tokens === "number") tally.output = u.output_tokens;
        if (typeof u.cache_read_input_tokens === "number") tally.cacheRead = u.cache_read_input_tokens;
        if (typeof u.cache_creation_input_tokens === "number") tally.cacheCreate = u.cache_creation_input_tokens;
      }
      return "";
    }
    return "";
  }

  /** @param {string} line */
  function handleLine(line) {
    const t = line.trim();
    if (!t) return "";
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      return ""; // non-JSON line (stray output) — skip, don't crash
    }
    return handleEvent(ev);
  }

  return {
    /** @param {string} chunk @returns {string} log text rendered from completed lines */
    push(chunk) {
      buf += chunk;
      let out = "";
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        out += handleLine(line);
      }
      return out;
    },
    /** Process any buffered tail (a final line with no trailing newline). */
    flush() {
      if (!buf) return "";
      const line = buf;
      buf = "";
      return handleLine(line);
    },
    get tally() {
      return tally;
    },
    get result() {
      return result;
    },
  };
}

/** First model key in a stream-json `modelUsage` map, or undefined. @param {any} mu */
function firstModel(mu) {
  if (!mu || typeof mu !== "object") return undefined;
  const keys = Object.keys(mu);
  return keys.length ? keys[0] : undefined;
}

/** `claude --model` aliases (case-insensitive, optional `[1m]` suffix) that name a Claude model. */
const CLAUDE_ALIAS_RE = /^(default|opus|sonnet|haiku|opusplan|best)(\[1m\])?$/i;

/**
 * Whether a run's `total_cost_usd` is meaningless because it did not run on Claude: the step
 * overrides the agent `bin` (e.g. `claude-local`), or the resolved model is not a Claude model
 * (e.g. `qwen3-coder` behind `ANTHROPIC_BASE_URL`). `claude` prices every run from its own
 * Claude price table, so an unpriced run keeps its tokens but its dollars are left out of every
 * spend sum. Claude = unset (CLI default), `claude-…`, a Bedrock/Vertex id holding
 * `anthropic.claude-`, or an alias. Pure; exported for tests.
 * @param {{model?: string, bin?: string, claudeBin?: string}} o
 * @returns {boolean}
 */
export function isUnpriced({ model, bin, claudeBin }) {
  if (bin && bin !== claudeBin) return true;
  if (!model) return false;
  const m = model.trim().toLowerCase();
  return !(m.startsWith("claude") || m.includes("anthropic.claude-") || CLAUDE_ALIAS_RE.test(m));
}

/**
 * Build a UsageRecord from a captured stream-json `result` event. Pure; exported for
 * tests. Totals come straight from `result.usage` + `total_cost_usd`; the model falls
 * back to the first `modelUsage` key when the step set no explicit `--model`. A run that
 * `isUnpriced` keeps its raw `costUsd` (audit) but is tagged `unpriced: true` (+ `bin` when
 * it overrides `claudeBin`) so readers leave it out of spend; priced records keep the old shape.
 * @param {{ref:string, stepId:string, model?:string, bin?:string, claudeBin?:string, startedAt:string, endedAt:string, result:any}} o
 * @returns {import('../types.js').UsageRecord}
 */
export function buildUsageRecord({ ref, stepId, model, bin, claudeBin, startedAt, endedAt, result }) {
  const u = (result && result.usage) || {};
  const resolved = model || firstModel(result && result.modelUsage);
  const unpriced = isUnpriced({ model: resolved, bin, claudeBin });
  return {
    ref,
    stepId,
    model: resolved,
    ...(bin && bin !== claudeBin ? { bin } : {}),
    startedAt,
    endedAt,
    durationMs: typeof result?.duration_ms === "number" ? result.duration_ms : undefined,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreate: u.cache_creation_input_tokens || 0,
    costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : undefined,
    sessionId: typeof result?.session_id === "string" ? result.session_id : undefined,
    ...(unpriced ? { unpriced: true } : {}),
  };
}

/** @type {import('../types.js').AgentAdapter} */
export const claude = {
  describe: () => ({ name: "claude", stdout: "stream-json" }),
  buildArgs: buildClaudeArgs,
  createParser() {
    const p = createStreamParser();
    return {
      push: p.push,
      flush: p.flush,
      get tally() {
        return p.tally;
      },
      get result() {
        return p.result;
      },
      get sessionId() {
        const id = p.result?.session_id;
        return typeof id === "string" ? id : undefined;
      },
    };
  },
  usageRecord: (result, ctx) => buildUsageRecord({ ...ctx, result }),
  sessions: {
    transcriptDir: claudeProjectDir,
    resumeCommand: (sessionId) => ["-r", sessionId],
  },
  defaults: {},
};
