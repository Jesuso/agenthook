// The OpenCode agent adapter: how `opencode run` is invoked (argv), how its `--format json`
// stdout (JSONL: `step_start`, `tool_use`, `text`, `step_finish`, each carrying `sessionID`)
// becomes log text + a live token tally + a result, and how that result becomes a usage
// record — priced only when OpenCode itself reports a non-zero cost. Sessions live in
// OpenCode's SQLite db (no transcript files), so `sessions` is null: `follow` is unsupported,
// and `resume` takes the session id from usage.jsonl and the top-level `resumeCommand`
// (`opencode -s <id>`: the interactive TUI — `opencode run -s <id>` refuses to start without a
// new message). The interface is documented by src/agents/claude.js.
import fs from "node:fs";
import path from "node:path";

/** `opencodeConfig` cap: large enough for a real provider config, small enough that a bad path
 * (a repo, a log) fails fast instead of reading gigabytes into memory. */
const MAX_OPENCODE_CONFIG_BYTES = 256 * 1024;

/** Max bytes for standing instructions written as a second `instructions` file in a sandboxed
 * opencode run. Beyond that, they stay only in the run prompt (no file, no instructions entry). */
export const STANDING_MAX_BYTES = 16 * 1024;

/**
 * Build the `opencode run` argv (pure; exported for tests). The prompt is positional, so it
 * goes last, behind `--`: yargs would otherwise read a prompt starting with `-` (a `- ` bullet,
 * YAML front-matter) as flags and exit 1 with its usage text. `--auto` (auto-approve permissions) only under `fullAuto`, matching claude's
 * `--dangerously-skip-permissions`. The model is `-m provider/model`, so a step `provider` is
 * dropped with a warning; `effort` maps verbatim to `--variant` (its levels are
 * provider-specific, so there is no set to check against). `maxMs` is ignored — the
 * receiver's timer is the only run bound.
 * @param {{prompt: string, model?: string, effort?: string, provider?: string, fullAuto?: boolean, maxMs?: number}} o
 * @returns {string[]}
 */
export function buildOpencodeArgs({ prompt, model, effort, provider, fullAuto }) {
  if (provider) console.warn(`[dispatch] ignoring provider "${provider}" — opencode takes the provider in the model ("-m provider/model")`);
  return ["run", "--format", "json", ...(fullAuto ? ["--auto"] : []), ...(model ? ["-m", model] : []), ...(effort ? ["--variant", effort] : []), "--", prompt];
}

/**
 * Build the `opencode run -s <id> -- <prompt>` argv for a verdict-repair turn (#677):
 * identical to buildOpencodeArgs, with `-s <sessionId>` (`opencode run --help`: `-s, --session
 * session id to continue`) inserted right before the `--` separator.
 * @param {Parameters<typeof buildOpencodeArgs>[0] & {sessionId: string}} o
 * @returns {string[]}
 */
export function resumeOpencodeArgs(o) {
  const args = buildOpencodeArgs(o);
  const idx = args.indexOf("--");
  return [...args.slice(0, idx), "-s", o.sessionId, ...args.slice(idx)];
}

/** A non-negative number, else 0. @param {any} n */
const num = (n) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Incremental parser for `opencode run --format json` stdout: one JSON object per line.
 * Same contract as cursor.js's parser — buffers partial lines across chunks, ignores unknown
 * event types and non-JSON lines, never throws. `text` events render their `part.text`;
 * `tool_use` a one-line `🔧 <tool>`; `error` (a failed model/provider call — OpenCode then exits
 * 1) a one-line `⚠ <name>: <message>`, so the run log says why. Each `step_finish` adds its output + reasoning tokens
 * to `tally.output`, sets input/cache to that step's (the latest context), and adds its
 * `part.cost`. The session id is the first `sessionID` any event carried. `result` is
 * non-null once a session id or a `step_finish` was seen, so dispatch records the usage
 * (and the id `ah resume` needs) even when the run is killed mid-way.
 *
 * Compaction (#657): the JSON stream emits no compaction event (OpenCode 1.19.5) — the
 * `compaction` part type and `session.compacted` bus event exist internally but never reach
 * `run --format json`. Heuristic instead: `prevCtx` is the last *nonzero* step's context; a
 * `step_finish` whose context drops ≥20% below it is counted as a compaction and rendered at
 * that step's own `step_finish` — i.e. after that step's tool calls, not at the compaction
 * itself. A zero-context step_finish (e.g. an errored step) neither counts nor updates
 * `prevCtx`. If a future OpenCode version streams a real compaction event, handle that too
 * (count once, don't double-count against this heuristic).
 * @returns {import('../types/agents.js').AgentParser}
 */
export function createOpencodeParser() {
  let buf = "";
  /** @type {{input: number, output: number, cacheRead: number, cacheCreate: number, turns?: number, firstContext?: number, peakContext?: number, lastContext?: number, compactions: number}} */
  const tally = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, compactions: 0 };
  let cost = 0;
  let steps = 0;
  // The last step_finish's nonzero context (#657) — the heuristic compaction detector compares
  // each new context against it, then only advances it on a nonzero context of its own.
  let prevCtx = 0;
  /** @type {string|undefined} */
  let sessionId;

  /** @param {any} ev @returns {string} human-readable log text for this event */
  function handleEvent(ev) {
    if (!ev || typeof ev !== "object") return "";
    if (sessionId === undefined && typeof ev.sessionID === "string") sessionId = ev.sessionID;
    const part = ev.part && typeof ev.part === "object" ? ev.part : {};
    if (ev.type === "text") return typeof part.text === "string" && part.text ? part.text + "\n" : "";
    if (ev.type === "tool_use") return typeof part.tool === "string" ? `🔧 ${part.tool}\n` : "";
    if (ev.type === "error") {
      const err = ev.error && typeof ev.error === "object" ? ev.error : {};
      const name = typeof err.name === "string" && err.name ? err.name : "error";
      const msg = err.data && typeof err.data === "object" && typeof err.data.message === "string" ? err.data.message : "";
      return `⚠ ${name}${msg ? `: ${msg}` : ""}\n`;
    }
    if (ev.type === "step_finish") {
      steps++;
      const t = part.tokens && typeof part.tokens === "object" ? part.tokens : {};
      const c = t.cache && typeof t.cache === "object" ? t.cache : {};
      tally.output += num(t.output) + num(t.reasoning);
      tally.input = num(t.input);
      tally.cacheRead = num(c.read);
      tally.cacheCreate = num(c.write);
      cost += num(part.cost);
      // Per-turn context size (#645): every step_finish is a turn.
      const ctx = num(t.input) + num(c.read) + num(c.write);
      tally.turns = (tally.turns ?? 0) + 1;
      if (tally.firstContext === undefined) tally.firstContext = ctx;
      tally.peakContext = tally.peakContext === undefined ? ctx : Math.max(tally.peakContext, ctx);
      tally.lastContext = ctx;
      // Compaction heuristic (#657): a ≥20% context drop from the last nonzero step_finish.
      let line = "";
      if (ctx > 0 && prevCtx > 0 && ctx < 0.8 * prevCtx) {
        tally.compactions++;
        line = `🗜 compaction (ctx ${prevCtx.toLocaleString("en-US")} → ${ctx.toLocaleString("en-US")})\n`;
      }
      if (ctx > 0) prevCtx = ctx;
      return line;
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
      return sessionId === undefined && !steps ? null : { session_id: sessionId, tokens: { ...tally }, cost };
    },
    get sessionId() {
      return sessionId;
    },
  };
}

/**
 * Build a UsageRecord from a captured OpenCode result (may be null → zero tokens). Pure;
 * exported for tests. Pricing rule: a summed `part.cost` > 0 is OpenCode's own figure for a
 * paid provider → `costUsd` = that sum, priced. Zero/absent (a local or free model) →
 * `unpriced: true` with no `costUsd`, so no invented dollars. `bin` is tagged only when the
 * step's `bin` overrides the `opencode` default.
 * @param {{ref:string, stepId:string, model?:string, bin?:string, startedAt:string, endedAt:string, result:any}} o
 * @returns {import('../types/state.js').UsageRecord}
 */
export function buildOpencodeUsageRecord({ ref, stepId, model, bin, startedAt, endedAt, result }) {
  const t = (result && result.tokens) || {};
  const cost = num(result?.cost);
  return {
    ref,
    stepId,
    model: model || "opencode",
    ...(bin && bin !== "opencode" ? { bin } : {}),
    startedAt,
    endedAt,
    input: num(t.input),
    output: num(t.output),
    cacheRead: num(t.cacheRead),
    cacheCreate: num(t.cacheCreate),
    costUsd: cost > 0 ? cost : undefined,
    sessionId: typeof result?.session_id === "string" ? result.session_id : undefined,
    ...(cost > 0 ? {} : { unpriced: /** @type {const} */ (true) }),
  };
}

/**
 * Read and validate a resolved `opencodeConfig` path (already absolute — loadConfig resolves
 * `~/` and relative paths). `lstat`, not `stat`: a symlink fails the `isFile()` check rather
 * than being followed. Throws `opencodeConfig <path>: …` on any problem; the caller's `sandbox`
 * hook throwing surfaces as dispatch's "sandbox setup failed" refusal.
 * @param {string} configPath @returns {string} the file's raw content
 */
export function readOpencodeConfig(configPath) {
  let st;
  try {
    st = fs.lstatSync(configPath);
  } catch (e) {
    throw new Error(`opencodeConfig ${configPath}: ${e.message}`);
  }
  if (!st.isFile()) throw new Error(`opencodeConfig ${configPath}: not a regular file`);
  if (st.size > MAX_OPENCODE_CONFIG_BYTES) throw new Error(`opencodeConfig ${configPath}: ${st.size} bytes exceeds the ${MAX_OPENCODE_CONFIG_BYTES}-byte cap`);
  const content = fs.readFileSync(configPath, "utf8");
  try {
    JSON.parse(content);
  } catch (e) {
    throw new Error(`opencodeConfig ${configPath}: invalid JSON (${e.message})`);
  }
  return content;
}

/**
 * The unattended contract written into a sandboxed run's OpenCode config `instructions` (#712).
 * OpenCode rebuilds its system prompt from config `instructions` on every step, so unlike the
 * one-shot prompt, this text survives a context compaction. Needed because OpenCode's own
 * post-compaction message is a hardcoded, unconfigurable string ("Continue if you have next
 * steps, or stop and ask for clarification if you are unsure how to proceed.") that a
 * small-window model reads as an invitation to stop and ask — so this file names that exact
 * message and tells the agent what it means here. Pure; exported for tests.
 * @param {string} verdictFile
 * @returns {string}
 */
export function opencodeContract(verdictFile) {
  return `# Unattended run

This run is unattended: no human reads your messages or answers questions while it works. Never
end on a question or ask for confirmation. Decide, act, and finish the task yourself.

## After a context compaction

OpenCode may compact the conversation and then add a message that says: "Continue if you have
next steps, or stop and ask for clarification if you are unsure how to proceed." In this run that
message always means **continue**: use the summary you were given, carry on with the task, and
never stop to ask.

## Verdict

Before exiting, write your verdict as JSON to this exact file: ${verdictFile} (also available as
the environment variable \$AGENTHOOK_VERDICT_FILE):

\`{"outcome": "...", "reason": "...", "summary": {"plain": "..."}}\`

\`outcome\` is one of the values the task's VERDICT section lists. If you are blocked on a human
decision, write \`"hold"\` with the question in \`reason\` instead of asking — that is the only way
to ask a question in this run.
`;
}

/**
 * The contract + standing-instructions files, and the `instructions` list that wires them in,
 * shared by the sandbox `files` write (into a per-run HOME) and the remote `files` write (into a
 * per-run worker dir, #739) — only the destination paths and the base config differ.
 * @param {{step: import('../types/pipeline.js').Step, verdictFile: string, standing?: string, contractDst: string, standingDst: string, rawConfig: string|null}} o
 */
function opencodeInstructionFiles({ step, verdictFile, standing, contractDst, standingDst, rawConfig }) {
  /** @type {{dst: string, content: string, mode?: number}[]} */
  const files = [];
  files.push({ dst: contractDst, content: opencodeContract(verdictFile), mode: 0o600 });
  const config = rawConfig ? JSON.parse(rawConfig) : {};
  const existing = Array.isArray(config.instructions) ? config.instructions : [];
  config.instructions = Array.from(new Set([...existing, contractDst]));

  // Standing instructions (#716): a second `instructions` file so the step's standing text
  // survives compaction. The ticket text is already in the one-shot prompt; only repo + step
  // instructions go here. When this file is written, dispatch drops the standing text from the
  // run prompt (#731) — `standingInInstructions` tells it that happened.
  let standingInInstructions = false;
  if (typeof standing === "string" && standing) {
    const standingBytes = Buffer.byteLength(standing, "utf8");
    if (standingBytes <= STANDING_MAX_BYTES) {
      files.push({ dst: standingDst, content: standing, mode: 0o600 });
      config.instructions = Array.from(new Set([...config.instructions, standingDst]));
      standingInInstructions = true;
    } else {
      console.warn(`[dispatch] step ${step.id}: standing instructions are ${standingBytes} bytes (> ${STANDING_MAX_BYTES}) — not written to opencode instructions; they stay in the run prompt only`);
    }
  }
  return { files, config, standingInInstructions };
}

/** @type {import('../types/agents.js').AgentAdapter} */
export const opencode = {
  // sandboxResume: false — a sandboxed run's session database lives in the per-run sandbox
  // HOME (sandbox() below writes no transcripts, has no mounts), which is deleted at teardown,
  // so a repair turn (#677) can never resume a sandboxed run's session. Unsandboxed, it can.
  describe: () => ({ name: "opencode", stdout: "stream-json", sandboxResume: false }),
  envPassthrough: ["OPENCODE_*"],
  buildArgs: buildOpencodeArgs,
  resumeArgs: resumeOpencodeArgs,
  createParser: createOpencodeParser,
  usageRecord: (result, ctx) => buildOpencodeUsageRecord({ ...ctx, result }),
  sessions: null,
  resumeCommand: (sessionId) => ["-s", sessionId],
  // Sandboxed: a `step.opencodeConfig` (the harness's, unless the step sets its own — resolved
  // by src/dispatch/harness.js before this runs) is copied into the per-run HOME, never
  // mounted — OpenCode configs can declare plugins/MCP commands, so a mount that persisted
  // across runs would let one run plant config that executes in the next (the per-run HOME
  // wrap() builds is deleted at teardown instead). No key → no files: OpenCode falls back to
  // its defaults (cloud providers reach it via env, through OPENCODE_* passthrough).
  // OPENCODE_DISABLE_AUTOUPDATE / OPENCODE_DISABLE_MODELS_FETCH skip OpenCode's own non-essential
  // network calls (the update check and the models.dev catalog fetch) — verified against the
  // installed CLI's env var names, not guessed.
  sandbox({ step, home, verdictFile, standing }) {
    /** @type {{dst: string, content: string, mode?: number}[]} */
    const files = [];
    const configDst = path.posix.join(home, ".config", "opencode", "opencode.json");
    const rawConfig = step.opencodeConfig ? readOpencodeConfig(step.opencodeConfig) : null;
    if (!verdictFile) {
      if (rawConfig) files.push({ dst: configDst, content: rawConfig, mode: 0o600 });
      return {
        mounts: [],
        files,
        env: { OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" },
      };
    }
    // The contract file (#712): survives compaction because OpenCode rebuilds its system
    // prompt from config `instructions` every step, unlike the one-shot run prompt.
    const contractDst = path.posix.join(home, ".config", "opencode", "agenthook-unattended.md");
    const standingDst = path.posix.join(home, ".config", "opencode", "agenthook-standing.md");
    const { files: instructionFiles, config, standingInInstructions } = opencodeInstructionFiles({ step, verdictFile, standing, contractDst, standingDst, rawConfig });
    files.push(...instructionFiles, { dst: configDst, content: JSON.stringify(config, null, 2), mode: 0o600 });
    return {
      mounts: [],
      files,
      env: { OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" },
      ...(standingInInstructions ? { standingInInstructions: true } : {}),
    };
  },
  // Remote (#689/#739): the worker keeps its OWN global config, auth and session db — unlike
  // the sandbox, nothing replaces HOME. `OPENCODE_CONFIG` points at a generated config in the
  // per-run `dir` instead, which OpenCode merges on top of its own global config, so the model
  // endpoint and credentials stay the worker's. `dir` is deleted by the executor after the run
  // (unlike the sandbox HOME, there's no container teardown to rely on). No `opencodeConfig` →
  // the generated config holds only `instructions`.
  remote({ step, dir, verdictFile, standing }) {
    const configDst = path.posix.join(dir, "opencode.json");
    const contractDst = path.posix.join(dir, "agenthook-unattended.md");
    const standingDst = path.posix.join(dir, "agenthook-standing.md");
    const rawConfig = step.opencodeConfig ? readOpencodeConfig(step.opencodeConfig) : null;
    const { files, config, standingInInstructions } = opencodeInstructionFiles({ step, verdictFile, standing, contractDst, standingDst, rawConfig });
    files.push({ dst: configDst, content: JSON.stringify(config, null, 2), mode: 0o600 });
    return {
      files,
      env: { OPENCODE_CONFIG: configDst, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" },
      ...(standingInInstructions ? { standingInInstructions: true } : {}),
    };
  },
  defaults: { bin: "opencode" },
};
