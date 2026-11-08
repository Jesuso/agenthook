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
 * @returns {import('../types.js').AgentParser}
 */
export function createOpencodeParser() {
  let buf = "";
  const tally = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let cost = 0;
  let steps = 0;
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
 * @returns {import('../types.js').UsageRecord}
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

/** @type {import('../types.js').AgentAdapter} */
export const opencode = {
  describe: () => ({ name: "opencode", stdout: "stream-json" }),
  envPassthrough: ["OPENCODE_*"],
  buildArgs: buildOpencodeArgs,
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
  sandbox({ step, home }) {
    /** @type {{dst: string, content: string, mode?: number}[]} */
    const files = [];
    if (step.opencodeConfig) {
      const content = readOpencodeConfig(step.opencodeConfig);
      files.push({ dst: path.posix.join(home, ".config", "opencode", "opencode.json"), content, mode: 0o600 });
    }
    return {
      mounts: [],
      files,
      env: { OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" },
    };
  },
  defaults: { bin: "opencode" },
};
