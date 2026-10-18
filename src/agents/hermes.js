// The Hermes agent adapter: how Nous Research's `hermes chat` is invoked (argv, via a
// prompt file since it has no inline-prompt flag), how its plain-text stdout becomes log
// text (no token usage to parse), how its stderr `session_id: <id>` line becomes the
// session id, and why its usage is always unpriced. The interface is documented by
// src/agents/claude.js. An `isolated` step (the default) runs in its own HERMES_HOME with
// minimal toolsets and no user rules — see src/agents/hermes-home.js.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { hermesHomeDir, hermesSourceHome, hermesPreflight } from "./hermes-home.js";

// High enough that maxMinutes/idleMinutes are the real bound on a run, not this.
export const HERMES_MAX_TURNS = 200;

/** Reasoning-effort levels `hermes chat --reasoning` accepts. An out-of-set value is
 * dropped (warn + omit the flag), like claude's `EFFORT_LEVELS`. */
export const HERMES_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Toolsets of an isolated step that sets none: enough to code (shell + files), without
 * memory/skills/session_search/cron/delegation — and about a third of the prompt tokens. */
export const HERMES_DEFAULT_TOOLSETS = ["terminal", "file"];

/** A hermes step runs isolated unless it sets `isolated: false`.
 * @param {import('../types.js').Step|undefined} step */
const isIsolated = (step) => step?.isolated !== false;

/**
 * Build the `hermes chat` argv (pure; exported for tests). The prompt reaches hermes only
 * through `--query-file` (dispatch writes it there) — hermes has no inline-prompt flag.
 * `-Q` keeps stdout quiet of prompts; `--yolo` only under `fullAuto`, matching claude's
 * `--dangerously-skip-permissions` and cursor's `--force`. `provider` selects the inference
 * provider (`--provider`, from `config.yaml`'s `providers:`); `effort` maps to `--reasoning`;
 * `maxMs` (the receiver's run timeout) maps to `--run-budget` in whole seconds (floored to at
 * least 1) so hermes can wrap up on its own before the receiver's SIGTERM — the receiver's
 * timer stays authoritative regardless. `isolated` (default true) adds `--ignore-rules`
 * (no AGENTS.md/SOUL.md/memory/preloaded skills), `--source tool` (kept out of the user's
 * session lists) and `-t <toolsets>` (default `terminal,file`); `isolated: false` is the
 * pre-isolation argv, plus `-t` only when `toolsets` is given.
 * @param {{prompt: string, promptFile?: string, model?: string, effort?: string, provider?: string, fullAuto?: boolean, maxMs?: number, toolsets?: string[], isolated?: boolean}} o
 * @returns {string[]}
 */
export function buildHermesArgs({ promptFile, model, effort, provider, fullAuto, maxMs, toolsets, isolated = true }) {
  if (!promptFile) throw new Error("hermes adapter requires promptFile (dispatch bug: describe().promptFile is true)");
  const args = ["chat", "-Q", ...(fullAuto ? ["--yolo"] : []), "--max-turns", String(HERMES_MAX_TURNS), "--query-file", promptFile, ...(model ? ["-m", model] : [])];
  if (provider) args.push("--provider", provider);
  if (effort) {
    if (HERMES_REASONING_LEVELS.includes(effort)) args.push("--reasoning", effort);
    else console.warn(`[dispatch] ignoring invalid effort "${effort}" (expected ${HERMES_REASONING_LEVELS.join("|")})`);
  }
  if (maxMs) args.push("--run-budget", String(Math.max(1, Math.floor(maxMs / 1000))));
  if (isolated) args.push("--ignore-rules", "--source", "tool");
  const tools = toolsets ?? (isolated ? HERMES_DEFAULT_TOOLSETS : undefined);
  if (tools) args.push("-t", tools.join(","));
  return args;
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

/**
 * The first non-empty JSONL line of a `hermes sessions export --format jsonl` file, mapped
 * to a usage tally (pure; exported for tests). `null` on bad JSON or a row with no numeric
 * token field. `reasoning_tokens`, `api_call_count` and `estimated_cost_usd` are ignored —
 * dollars come from the #394 rate table, not Hermes.
 * @param {string} text
 * @returns {{input?: number, output?: number, cacheRead?: number, cacheCreate?: number, model?: string}|null}
 */
export function parseHermesExport(text) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .find((l) => l.trim());
  if (!line) return null;
  /** @type {any} */
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object") return null;
  const fields = { input: row.input_tokens, output: row.output_tokens, cacheRead: row.cache_read_tokens, cacheCreate: row.cache_write_tokens };
  const hasTokens = Object.values(fields).some((v) => typeof v === "number" && Number.isFinite(v));
  if (!hasTokens) return null;
  /** @type {any} */
  const out = {};
  for (const [k, v] of Object.entries(fields)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  if (typeof row.model === "string" && row.model) out.model = row.model;
  return out;
}

/**
 * dispatch's post-exit `agent.finalize` (#395): run `hermes sessions export` for the
 * session the run produced, in the same env (so an isolated step's HERMES_HOME finds its
 * session), and parse the row. The export file lives only in the scratch `dir` dispatch
 * gives us and is removed before returning, success or not.
 * @param {{sessionId: string, bin: string, env: Record<string,string>, dir: string, timeoutMs: number}} o
 * @returns {Promise<{input?: number, output?: number, cacheRead?: number, cacheCreate?: number, model?: string}|null>}
 */
export function hermesFinalize({ sessionId, bin, env, dir, timeoutMs }) {
  const file = path.join(dir, "export.jsonl");
  return new Promise((resolve, reject) => {
    execFile(bin, ["sessions", "export", "--session-id", sessionId, "--format", "jsonl", file], { env, cwd: dir, timeout: timeoutMs, killSignal: "SIGKILL" }, (err) => {
      if (err) return reject(err);
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (e) {
        return reject(e);
      } finally {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* best effort */
        }
      }
      resolve(parseHermesExport(text));
    });
  });
}

/** @type {import('../types.js').AgentAdapter} */
export const hermes = {
  describe: () => ({ name: "hermes", stdout: "text", promptFile: true }),
  envPassthrough: ["HERMES_HOME"],
  buildArgs: buildHermesArgs,
  createParser: createHermesParser,
  usageRecord: (result, ctx) => buildHermesUsageRecord({ ...ctx, result }),
  sessions: null,
  resumeCommand: (sessionId) => ["chat", "--resume", sessionId],
  env: ({ cfg, step }) => (isIsolated(step) ? { HERMES_HOME: hermesHomeDir(cfg.stateDir ?? cfg.dataDir) } : undefined),
  // A step that sets its own HERMES_HOME manages that home itself: nothing to prepare.
  preflight: ({ cfg, step, provider }) =>
    isIsolated(step) && !step?.env?.HERMES_HOME ? hermesPreflight({ stateDir: cfg.stateDir ?? cfg.dataDir, sourceHome: hermesSourceHome(), provider }) : undefined,
  finalize: hermesFinalize,
  defaults: { bin: "hermes", requireVerdict: true },
};
