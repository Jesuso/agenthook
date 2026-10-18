// The Cursor agent adapter: how Cursor's headless `agent -p` is invoked (argv), how its
// `--output-format stream-json` stdout becomes log text + a token tally + the final
// `result` event, how that result becomes an (always unpriced) usage record, and where its
// session transcripts live (`~/.cursor/projects/<cursorMangle(cwd)>/agent-transcripts/<id>/<id>.jsonl`,
// resumed with `agent --resume <id>`). The interface is documented by src/agents/claude.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cursorMangle } from "../paths.js";

/**
 * Build the `agent -p` argv (pure; exported for tests). The prompt is positional, so it
 * goes last. `--trust` skips the workspace-trust prompt a fresh worktree would otherwise
 * block on; `--model` defaults to Cursor's `auto`. Cursor has no reasoning-effort flag, so
 * a step `effort` is dropped with a warning.
 * @param {{prompt: string, model?: string, effort?: string, provider?: string, fullAuto?: boolean, maxMs?: number}} o
 * @returns {string[]}
 */
export function buildCursorArgs({ prompt, model, effort, provider, fullAuto }) {
  if (effort) console.warn(`[dispatch] ignoring effort "${effort}" — cursor's agent CLI has no effort flag`);
  if (provider) console.warn(`[dispatch] ignoring provider "${provider}" — cursor's agent CLI has no provider flag`);
  return ["-p", "--output-format", "stream-json", "--trust", "--model", model || "auto", ...(fullAuto ? ["--force"] : []), prompt];
}

/** Copy Cursor's camelCase `usage` onto a tally (absent keys left as they are). @param {any} u @param {any} tally */
function readUsage(u, tally) {
  if (!u || typeof u !== "object") return;
  if (typeof u.inputTokens === "number") tally.input = u.inputTokens;
  if (typeof u.outputTokens === "number") tally.output = u.outputTokens;
  if (typeof u.cacheReadTokens === "number") tally.cacheRead = u.cacheReadTokens;
  if (typeof u.cacheWriteTokens === "number") tally.cacheCreate = u.cacheWriteTokens;
}

/**
 * Incremental parser for `agent -p --output-format stream-json` stdout: one JSON object
 * per line. Same contract as claude.js's parser — buffers partial lines across chunks,
 * renders `assistant` text blocks to log text, ignores every other event type
 * (`system`, `user`, `thinking`, `tool_call`, …) and non-JSON lines, never throws.
 * Cursor's assistant events carry no usage, so the tally fills in at the `result` event.
 * The session id is the result's, else the first `session_id` any event carried.
 * @returns {{push:(chunk:string)=>string, flush:()=>string, tally:{input:number,output:number,cacheRead:number,cacheCreate:number}, result:any, sessionId:string|undefined}}
 */
export function createCursorStreamParser() {
  let buf = "";
  const tally = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  /** @type {any} */
  let result = null;
  /** @type {string|undefined} */
  let firstSessionId;

  /** @param {any} ev @returns {string} human-readable log text for this event */
  function handleEvent(ev) {
    if (!ev || typeof ev !== "object") return "";
    if (firstSessionId === undefined && typeof ev.session_id === "string") firstSessionId = ev.session_id;
    if (ev.type === "assistant" && ev.message && typeof ev.message === "object") {
      readUsage(ev.message.usage, tally); // none today; harmless if Cursor starts sending it
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
      readUsage(ev.usage, tally);
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
    get sessionId() {
      const id = result?.session_id;
      return typeof id === "string" ? id : firstSessionId;
    },
  };
}

/**
 * Build a UsageRecord from a captured Cursor `result` event (may be null → zero tokens).
 * Pure; exported for tests. Always `unpriced: true` with no `costUsd` — Cursor reports no
 * cost and agenthook has no Cursor price table. `bin` is tagged only when the step's `bin`
 * overrides the `agent` default.
 * @param {{ref:string, stepId:string, model?:string, bin?:string, startedAt:string, endedAt:string, result:any}} o
 * @returns {import('../types.js').UsageRecord}
 */
export function buildCursorUsageRecord({ ref, stepId, model, bin, startedAt, endedAt, result }) {
  const u = (result && result.usage) || {};
  return {
    ref,
    stepId,
    model: model || (typeof result?.model === "string" ? result.model : undefined) || "auto",
    ...(bin && bin !== "agent" ? { bin } : {}),
    startedAt,
    endedAt,
    durationMs: typeof result?.duration_ms === "number" ? result.duration_ms : undefined,
    input: u.inputTokens || 0,
    output: u.outputTokens || 0,
    cacheRead: u.cacheReadTokens || 0,
    cacheCreate: u.cacheWriteTokens || 0,
    costUsd: undefined,
    sessionId: typeof result?.session_id === "string" ? result.session_id : undefined,
    unpriced: true,
  };
}

/** Cursor's projects root. */
const cursorProjects = () => path.join(os.homedir(), ".cursor", "projects");

/** Cursor's transcript dir for an agent launched in `cwd`. @param {string} cwd */
export const cursorProjectDir = (cwd) => path.join(cursorProjects(), cursorMangle(cwd), "agent-transcripts");

/** Entry names in a dir ([] if unreadable). @param {string} dir */
const entries = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** Session transcripts in a Cursor transcript dir: `<dir>/<id>/<id>.jsonl` per session.
 * `at` = the file's creation time (Cursor lines carry no timestamp).
 * @param {string} dir @returns {{id: string, file: string, at?: number}[]} */
export function cursorSessionFiles(dir) {
  /** @type {{id: string, file: string, at?: number}[]} */
  const out = [];
  for (const id of entries(dir)) {
    const file = path.join(dir, id, `${id}.jsonl`);
    try {
      const st = fs.statSync(file);
      out.push({ id, file, at: st.birthtimeMs || st.mtimeMs });
    } catch {
      // not a session dir
    }
  }
  return out;
}

/** @type {import('../types.js').AgentAdapter} */
export const cursor = {
  describe: () => ({ name: "cursor", stdout: "stream-json" }),
  buildArgs: buildCursorArgs,
  createParser: createCursorStreamParser,
  usageRecord: (result, ctx) => buildCursorUsageRecord({ ...ctx, result }),
  sessions: {
    transcriptDir: cursorProjectDir,
    resumeCommand: (sessionId) => ["--resume", sessionId],
    files: cursorSessionFiles,
    cwdDirs(baseCwd) {
      const projects = cursorProjects();
      const prefix = cursorMangle(baseCwd) + "-";
      const dirs = entries(projects)
        .filter((e) => e.startsWith(prefix))
        .map((e) => path.join(projects, e, "agent-transcripts"))
        .filter((d) => fs.existsSync(d));
      return { dirs, searched: path.join(projects, `${prefix}*`, "agent-transcripts") };
    },
  },
  defaults: { bin: "agent" },
};
