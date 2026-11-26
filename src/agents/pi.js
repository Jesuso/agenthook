// The pi agent adapter: how `pi -p --mode json` is invoked (argv), how its JSONL stdout
// (`session`, `message_end`, `tool_execution_start`, `compaction_end`, …) becomes log text + a
// live token tally + a result, and how that result becomes a usage record — unpriced unless pi
// itself reports a non-zero cost. pi's session state lives under `$HOME/.pi/agent` (the per-run
// HOME when sandboxed, deleted at teardown), so `sessions` is null and `sandboxResume` is false:
// a sandboxed run can never be resumed. pi takes its system-prompt files as `--append-system-prompt`
// argv flags (which survive compaction — verified), so the `sandbox` hook returns those paths in
// `args` for dispatch to splice in before the `--` separator. The interface is documented by
// src/agents/claude.js and src/agents/opencode.js.
import fs from "node:fs";
import path from "node:path";
import { STANDING_MAX_BYTES } from "./opencode.js";

/** The `host:port` a URL names (port 80/443 defaulted from the scheme when absent); undefined
 * for an unparseable URL. Always names the port — the sandbox allowlist rule needs one.
 * @param {string|undefined} url @returns {string|undefined} */
function hostPortRule(url) {
  if (!url) return undefined;
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return undefined;
  }
  if (!u.hostname) return undefined;
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return `${host}:${port}`;
}

/** `piConfigDir` file cap: large enough for a real models.json, small enough that a bad path
 * (a repo, a log) fails fast instead of reading gigabytes into memory. Same cap as opencode's. */
const MAX_PI_CONFIG_BYTES = 256 * 1024;

/** pi's `--thinking` levels (the model's `reasoning_effort`); anything else is dropped with a
 * warning rather than passed to a CLI that would reject it. */
const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** A non-negative finite number, else 0. @param {any} n */
const num = (n) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);

/**
 * Build the `pi -p` argv (pure; exported for tests). The prompt is positional, so it goes last,
 * behind `--`: a prompt starting with `-` (a `- ` bullet, YAML front-matter) would otherwise be
 * read as a flag. `--offline` keeps pi from phoning home for a model catalog. The model is
 * `--model provider/id`, so a step `provider` is dropped with a warning (pi folds it into the
 * model name); `effort` maps to `--thinking` but only for a level pi accepts. `fullAuto` adds
 * nothing — pi has no permission prompt in print mode, so a pi step must run sandboxed to be
 * safe. `maxMs` is ignored — the receiver's timer is the only run bound.
 * @param {{prompt: string, model?: string, effort?: string, provider?: string, fullAuto?: boolean, maxMs?: number}} o
 * @returns {string[]}
 */
export function buildPiArgs({ prompt, model, effort, provider }) {
  if (provider) console.warn(`[dispatch] ignoring provider "${provider}" — pi takes the provider in the model ("--model provider/id")`);
  let thinking = effort;
  if (effort && !PI_THINKING_LEVELS.has(effort)) {
    console.warn(`[dispatch] ignoring effort "${effort}" — pi --thinking takes one of off|minimal|low|medium|high|xhigh|max`);
    thinking = undefined;
  }
  return ["-p", "--mode", "json", "--offline", ...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : []), "--", prompt];
}

/**
 * Build the `pi -p --session <id> -- <prompt>` argv for a verdict-repair turn (#677): identical
 * to buildPiArgs, with `--session <sessionId>` inserted right before the `--` separator.
 * @param {Parameters<typeof buildPiArgs>[0] & {sessionId: string}} o
 * @returns {string[]}
 */
export function resumePiArgs(o) {
  const args = buildPiArgs(o);
  const idx = args.indexOf("--");
  return [...args.slice(0, idx), "--session", o.sessionId, ...args.slice(idx)];
}

/** The one-line detail for a `tool_execution_start`, from its `args`. @param {string} name @param {any} args */
function toolDetail(name, args) {
  const a = args && typeof args === "object" ? args : {};
  switch (name) {
    case "read": {
      const base = typeof a.path === "string" ? a.path : "";
      const off = typeof a.offset === "number" ? `:${a.offset}` : "";
      const lim = typeof a.limit === "number" ? `+${a.limit}` : "";
      return base + (off || lim ? off + lim : "");
    }
    case "bash":
      return typeof a.command === "string" ? a.command : "";
    case "edit":
    case "write":
      return typeof a.path === "string" ? a.path : "";
    default:
      return JSON.stringify(a);
  }
}

/** Clip a rendered detail to ~200 chars so one tool call can't flood the run log. @param {string} s */
const clip = (s) => (s.length > 200 ? s.slice(0, 197) + "…" : s);

/**
 * Incremental parser for `pi -p --mode json` stdout: one JSON object per line. Same contract as
 * opencode's parser — buffers partial lines, ignores unknown events and non-JSON lines, never
 * throws. A `session` event carries the session id (`ev.id`). An assistant `message_end` with an
 * object `usage` is one turn: its `usage.input/output/cacheRead/cacheWrite` are SUMMED (pi's
 * usage is per turn, not a running total like opencode's), and its turn context
 * (`input + cacheRead + cacheWrite`) sets firstContext/peakContext/lastContext. Its `content[]`
 * items render only their `text` (thinking and toolCall items render nothing — tool calls come
 * from `tool_execution_start`). `turn_end` repeats the assistant message and its usage, so it is
 * ignored to avoid double-counting. `message_update`/`message_start`/`tool_execution_end` render
 * nothing. `tool_execution_start` renders a one-line `🔧 <tool> <detail>`. `compaction_end`
 * bumps `compactions`, renders `🗜 compaction (ctx before → after)`, and adds the summarisation
 * call's `usage.input/output` to the totals (real spend, but not a turn and not context).
 * `result` is null until a session id or a turn is seen.
 * @returns {import('../types.js').AgentParser}
 */
export function createPiParser() {
  let buf = "";
  /** @type {{input: number, output: number, cacheRead: number, cacheCreate: number, turns?: number, firstContext?: number, peakContext?: number, lastContext?: number, compactions: number}} */
  const tally = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, compactions: 0 };
  let cost = 0;
  /** @type {string|undefined} */
  let sessionId;

  /** @param {any} ev @returns {string} human-readable log text for this event */
  function handleEvent(ev) {
    if (!ev || typeof ev !== "object") return "";
    if (sessionId === undefined && typeof ev.id === "string" && ev.type === "session") sessionId = ev.id;

    if (ev.type === "message_end") {
      const msg = ev.message && typeof ev.message === "object" ? ev.message : null;
      if (!msg || msg.role !== "assistant") return "";
      const usage = msg.usage && typeof msg.usage === "object" ? msg.usage : null;
      if (!usage) return "";
      const u = /** @type {any} */ (usage);
      tally.input += num(u.input);
      tally.output += num(u.output);
      tally.cacheRead += num(u.cacheRead);
      tally.cacheCreate += num(u.cacheWrite);
      const c = u.cost && typeof u.cost === "object" ? u.cost : null;
      cost += num(/** @type {any} */ (c)?.total);
      // Per-turn context (#645): an assistant message_end is a turn.
      const ctx = num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
      tally.turns = (tally.turns ?? 0) + 1;
      if (tally.firstContext === undefined) tally.firstContext = ctx;
      tally.peakContext = tally.peakContext === undefined ? ctx : Math.max(tally.peakContext, ctx);
      tally.lastContext = ctx;
      // Render the assistant's text (thinking and toolCall items render nothing).
      let out = "";
      if (Array.isArray(msg.content)) {
        for (const item of /** @type {any[]} */ (msg.content)) {
          if (item && item.type === "text" && typeof item.text === "string" && item.text) out += item.text + "\n";
        }
      }
      if (msg.stopReason === "length") out += `⚠ turn ended: stopReason length (context window full)\n`;
      return out;
    }

    if (ev.type === "tool_execution_start") {
      const name = typeof ev.toolName === "string" ? ev.toolName : "tool";
      const detail = clip(toolDetail(name, ev.args));
      return `🔧 ${name}${detail ? ` ${detail}` : ""}\n`;
    }

    if (ev.type === "compaction_end") {
      tally.compactions++;
      // The summarisation call's tokens are real spend — add them, but they are not a turn and
      // not part of any context figure.
      const res = ev.result && typeof ev.result === "object" ? /** @type {any} */ (ev.result) : null;
      const ru = res?.usage && typeof res.usage === "object" ? res.usage : null;
      if (ru) {
        tally.input += num(ru.input);
        tally.output += num(ru.output);
        const c = ru.cost && typeof ru.cost === "object" ? ru.cost : null;
        cost += num(/** @type {any} */ (c)?.total);
      }
      // The before/after context figures sit on the result (the owner-verified 1.5.2 shape), not
      // at the event's top level.
      const before = num(res?.tokensBefore);
      const after = num(res?.estimatedTokensAfter);
      return `🗜 compaction (ctx ${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")})\n`;
    }

    // session (id already captured above), agent_start, turn_start/turn_end, message_start,
    // message_update, tool_execution_end, agent_end, agent_settled: no log text.
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
      return sessionId === undefined && !tally.turns ? null : { session_id: sessionId, tokens: { ...tally }, cost };
    },
    get sessionId() {
      return sessionId;
    },
  };
}

/**
 * Build a UsageRecord from a captured pi result (may be null → zero tokens). Pure; exported for
 * tests. Pricing rule: a summed `usage.cost.total` > 0 is pi's own figure for a paid provider →
 * `costUsd` = that sum, priced. Zero/absent (a local or free model) → `unpriced: true` with no
 * `costUsd`, so no invented dollars. `bin` is tagged only when the step's `bin` overrides the
 * `pi` default.
 * @param {{ref:string, stepId:string, model?:string, bin?:string, startedAt:string, endedAt:string, result:any}} o
 * @returns {import('../types.js').UsageRecord}
 */
export function buildPiUsageRecord({ ref, stepId, model, bin, startedAt, endedAt, result }) {
  const t = (result && result.tokens) || {};
  const cost = num(result?.cost);
  return {
    ref,
    stepId,
    model: model || "pi",
    ...(bin && bin !== "pi" ? { bin } : {}),
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
 * The unattended contract + standing-instructions files and their `--append-system-prompt` args,
 * shared by the `sandbox` hook (written into a per-run HOME's `.pi/agent`) and the `remote` hook
 * (written into a per-run worker dir, #827) — only the destination base differs. Appends to the
 * given `files` list; returns the `args` and whether the standing text went into a file.
 * @param {{step: import('../types.js').Step, verdictFile: string, standing?: string, base: string, files: {dst: string, content: string, mode?: number}[]}} o
 */
function piPromptFiles({ step, verdictFile, standing, base, files }) {
  const contractDst = path.posix.join(base, "agenthook-unattended.md");
  const standingDst = path.posix.join(base, "agenthook-standing.md");
  files.push({ dst: contractDst, content: piContract(verdictFile), mode: 0o600 });
  const args = ["--append-system-prompt", contractDst];
  let standingInInstructions = false;
  if (typeof standing === "string" && standing) {
    const bytes = Buffer.byteLength(standing, "utf8");
    if (bytes <= STANDING_MAX_BYTES) {
      files.push({ dst: standingDst, content: standing, mode: 0o600 });
      args.push("--append-system-prompt", standingDst);
      standingInInstructions = true;
    } else {
      console.warn(`[dispatch] step ${step.id}: standing instructions are ${bytes} bytes (> ${STANDING_MAX_BYTES}) — not written to a pi system-prompt file; they stay in the run prompt only`);
    }
  }
  return { args, standingInInstructions };
}

/**
 * Read and validate a file inside a resolved `piConfigDir` (already absolute). The dir itself is
 * checked once (lstat, must be a directory) and each present file with the same rules as
 * opencode's config (lstat regular file, ≤ 256 KB, valid JSON). A present file that fails a check
 * throws `piConfigDir <path>: …`; an absent file is skipped. The dir being missing or not a
 * directory throws too. The caller's `sandbox` hook throwing surfaces as dispatch's "sandbox
 * setup failed" refusal, so nothing spawns.
 * @param {string} dir @returns {{name: string, content: string}[]} the present, validated files
 */
export function readPiConfigDir(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    throw new Error(`piConfigDir ${dir}: ${e.message}`);
  }
  if (!st.isDirectory()) throw new Error(`piConfigDir ${dir}: not a directory`);
  /** @type {{name: string, content: string}[]} */
  const out = [];
  for (const name of /** @type {const} */ (["models.json", "settings.json"])) {
    const p = path.join(dir, name);
    let lst;
    try {
      lst = fs.lstatSync(p);
    } catch {
      continue; // absent — fine
    }
    if (!lst.isFile()) throw new Error(`piConfigDir ${p}: not a regular file`);
    if (lst.size > MAX_PI_CONFIG_BYTES) throw new Error(`piConfigDir ${p}: ${lst.size} bytes exceeds the ${MAX_PI_CONFIG_BYTES}-byte cap`);
    const content = fs.readFileSync(p, "utf8");
    try {
      JSON.parse(content);
    } catch (e) {
      throw new Error(`piConfigDir ${p}: invalid JSON (${e.message})`);
    }
    out.push({ name, content });
  }
  return out;
}

/**
 * The unattended contract written into a sandboxed pi run's `agenthook-unattended.md` and passed
 * with `--append-system-prompt` (#752). It is the opencode contract with the "After a context
 * compaction" OpenCode-message paragraph removed — pi has no hardcoded post-compaction message of
 * its own, so that guidance doesn't apply. The `--append-system-prompt` file survives compaction
 * (verified on pi 1.5.2 through a logging proxy across four compactions). Pure; exported for tests.
 * @param {string} verdictFile
 * @returns {string}
 */
export function piContract(verdictFile) {
  return `# Unattended run

This run is unattended: no human reads your messages or answers questions while it works. Never
end on a question or ask for confirmation. Decide, act, and finish the task yourself.

## Verdict

Before exiting, write your verdict as JSON to this exact file: ${verdictFile} (also available as
the environment variable \$AGENTHOOK_VERDICT_FILE):

\`{"outcome": "...", "reason": "...", "summary": {"plain": "..."}}\`

\`outcome\` is one of the values the task's VERDICT section lists. If you are blocked on a human
decision, write \`"hold"\` with the question in \`reason\` instead of asking — that is the only way
to ask a question in this run.
`;
}

/** The model-API egress hosts of a pi run: the `host:port` of each `providers.*.baseUrl` in the
 * step's `piConfigDir/models.json`, when one is set. Unparsable URLs are skipped and nothing
 * throws. No `piConfigDir` → []. (The env arg is kept for the shared `egressHosts(env, {step})`
 * signature; pi needs no env-derived hosts.) @param {Record<string,string|undefined>} _env
 * @param {{step?: import('../types.js').Step}} [ctx] @returns {string[]} */
export function piEgressHosts(_env, { step } = {}) {
  const dir = step?.piConfigDir;
  if (!dir) return [];
  const p = path.join(dir, "models.json");
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  let models;
  try {
    models = JSON.parse(raw);
  } catch {
    return [];
  }
  const providers = models && typeof models === "object" ? /** @type {any} */ (models).providers : undefined;
  if (!providers || typeof providers !== "object") return [];
  /** @type {string[]} */
  const out = [];
  for (const provider of Object.values(providers)) {
    const base = /** @type {any} */ (provider)?.baseUrl;
    if (typeof base !== "string") continue;
    const rule = hostPortRule(base);
    if (rule) out.push(rule);
  }
  return out;
}

/** @type {import('../types.js').AgentAdapter} */
export const pi = {
  // policy: {allow: false, deny: false} — pi's print mode takes no allow/deny policy, so a step
  // setting one is refused before spawn (dispatch's agentPreflight), never run unrestricted.
  // sandboxResume: false — a sandboxed run's session state lives in the per-run sandbox HOME
  // (`<home>/.pi/agent`), deleted at teardown, so a repair turn can never resume it.
  describe: () => ({ name: "pi", stdout: "stream-json", policy: { allow: false, deny: false }, sandboxResume: false }),
  envPassthrough: ["PI_*"],
  buildArgs: buildPiArgs,
  resumeArgs: resumePiArgs,
  createParser: createPiParser,
  usageRecord: (result, ctx) => buildPiUsageRecord({ ...ctx, result }),
  sessions: null,
  resumeCommand: (sessionId) => ["--session", sessionId],
  egressHosts: piEgressHosts,
  // Sandboxed: a `step.piConfigDir` (the harness's, unless the step sets its own — resolved by
  // src/dispatch/harness.js before this runs) is copied into the per-run HOME's `.pi/agent`
  // (models.json, settings.json), never mounted — models.json can name providers with
  // credentials, so a mount persisting across runs would let one run plant config the next run
  // uses. Each file is optional. With a `verdictFile`, the unattended contract (and, when
  // provided, the standing instructions ≤ 16 KB) are written there too and wired in as
  // `--append-system-prompt` flags, which survive compaction; `standingInInstructions: true`
  // then tells dispatch to drop the standing text from the run prompt.
  sandbox({ step, home, verdictFile, standing }) {
    /** @type {{dst: string, content: string, mode?: number}[]} */
    const files = [];
    const base = path.posix.join(home, ".pi", "agent");
    if (step.piConfigDir) {
      for (const { name, content } of readPiConfigDir(step.piConfigDir)) {
        files.push({ dst: path.posix.join(base, name), content, mode: 0o600 });
      }
    }
    if (!verdictFile) {
      return { mounts: [], files, env: {} };
    }
    const { args, standingInInstructions } = piPromptFiles({ step, verdictFile, standing, base, files });
    return {
      mounts: [],
      files,
      env: {},
      args,
      ...(standingInInstructions ? { standingInInstructions: /** @type {const} */ (true) } : {}),
    };
  },
  // Remote (#827): the worker keeps its OWN pi config, model endpoint and credentials — the
  // worker user's own `~/.pi/agent` (models.json, settings.json, auth) is used, so a step's
  // `piConfigDir` NEVER crosses (it is ignored with a warning, never read, never copied). The
  // contract (and, when provided, the standing instructions ≤ 16 KB) are written into the per-run
  // `dir` the ssh executor creates and removes, and wired in as `--append-system-prompt` flags —
  // returned in `args`, which dispatch splices before the argv's `--` (survives compaction, like
  // the sandbox's). `PI_OFFLINE: "1"` is belt-and-braces with the `--offline` flag. The prompt
  // itself goes over the launcher's stdin (pi reads piped stdin as its initial message in -p
  // mode), so no prompt file is written.
  remote({ step, dir, verdictFile, standing }) {
    if (step.piConfigDir) {
      console.warn(`[dispatch] step ${step.id}: piConfigDir ${step.piConfigDir} is ignored on a remote worker — the worker's own ~/.pi/agent (models, settings, auth) is used`);
    }
    /** @type {{dst: string, content: string, mode?: number}[]} */
    const files = [];
    const { args, standingInInstructions } = piPromptFiles({ step, verdictFile, standing, base: dir, files });
    return {
      files,
      env: { PI_OFFLINE: "1" },
      args,
      ...(standingInInstructions ? { standingInInstructions: /** @type {const} */ (true) } : {}),
    };
  },
  defaults: { bin: "pi" },
};
