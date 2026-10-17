// The Hermes agent adapter: how Nous Research's `hermes chat` is invoked (argv, via a
// prompt file since it has no inline-prompt flag), how its plain-text stdout becomes log
// text (no token usage to parse), how its stderr `session_id: <id>` line becomes the
// session id, and why its usage is always unpriced. The interface is documented by
// src/agents/claude.js.

// High enough that maxMinutes/idleMinutes are the real bound on a run, not this.
export const HERMES_MAX_TURNS = 200;

/**
 * Build the `hermes chat` argv (pure; exported for tests). The prompt reaches hermes only
 * through `--query-file` (dispatch writes it there) — hermes has no inline-prompt flag.
 * `-Q` keeps stdout quiet of prompts; `--yolo` only under `fullAuto`, matching claude's
 * `--dangerously-skip-permissions` and cursor's `--force`. Hermes has no reasoning-effort
 * flag, so a step `effort` is dropped with a warning.
 * @param {{prompt: string, promptFile?: string, model?: string, effort?: string, fullAuto?: boolean}} o
 * @returns {string[]}
 */
export function buildHermesArgs({ promptFile, model, effort, fullAuto }) {
  if (!promptFile) throw new Error("hermes adapter requires promptFile (dispatch bug: describe().promptFile is true)");
  if (effort) console.warn(`[dispatch] ignoring effort "${effort}" — hermes' chat CLI has no effort flag`);
  return ["chat", "-Q", ...(fullAuto ? ["--yolo"] : []), "--max-turns", String(HERMES_MAX_TURNS), "--query-file", promptFile, ...(model ? ["-m", model] : [])];
}

const SESSION_ID_RE = /session_id:\s*(\S+)/;

/**
 * Incremental parser for `hermes chat -Q`: plain-text stdout passes straight through to
 * the log (no structure to parse, so no token usage either — `tally` stays all zeros).
 * The session id comes from stderr's `session_id: <id>` line, captured once, split-chunk
 * safe via a line buffer. Never throws.
 * @returns {import('../types.js').AgentParser}
 */
export function createHermesParser() {
  const tally = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  /** @type {string|undefined} */
  let sessionId;
  let errBuf = "";

  /** @param {string} chunk */
  function pushStderr(chunk) {
    errBuf += chunk;
    let nl;
    // Only complete lines are matched — a partial trailing token (e.g. "session_id: ab"
    // cut mid-id across chunks) must never be read as the whole id.
    while ((nl = errBuf.indexOf("\n")) !== -1) {
      const line = errBuf.slice(0, nl);
      errBuf = errBuf.slice(nl + 1);
      if (sessionId === undefined) {
        const m = SESSION_ID_RE.exec(line);
        if (m) sessionId = m[1];
      }
    }
  }

  return {
    push(chunk) {
      return chunk;
    },
    flush() {
      return "";
    },
    pushStderr,
    get tally() {
      return tally;
    },
    get result() {
      return sessionId === undefined ? null : { session_id: sessionId };
    },
    get sessionId() {
      return sessionId;
    },
  };
}

/**
 * Build a UsageRecord from a captured Hermes result (may be null → no session id).
 * Pure; exported for tests. Always `unpriced: true` with zero tokens and no `costUsd` —
 * hermes reports no usage and agenthook has no Hermes price table. `bin` is tagged only
 * when the step's `bin` overrides the `agent` default.
 * @param {{ref:string, stepId:string, model?:string, bin?:string, startedAt:string, endedAt:string, result:any}} o
 * @returns {import('../types.js').UsageRecord}
 */
export function buildHermesUsageRecord({ ref, stepId, model, bin, startedAt, endedAt, result }) {
  return {
    ref,
    stepId,
    model: model || "hermes",
    ...(bin && bin !== "hermes" ? { bin } : {}),
    startedAt,
    endedAt,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    costUsd: undefined,
    sessionId: typeof result?.session_id === "string" ? result.session_id : undefined,
    unpriced: true,
  };
}

/** @type {import('../types.js').AgentAdapter} */
export const hermes = {
  describe: () => ({ name: "hermes", stdout: "text", promptFile: true }),
  buildArgs: buildHermesArgs,
  createParser: createHermesParser,
  usageRecord: (result, ctx) => buildHermesUsageRecord({ ...ctx, result }),
  sessions: null,
  defaults: { bin: "hermes", requireVerdict: true },
};
