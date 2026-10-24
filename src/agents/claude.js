// The Claude Code agent adapter: how `claude -p` is invoked (argv), how its
// `--output-format stream-json` stdout becomes log text + a token tally + the final
// `result` event, how that result becomes a usage record, and where its session
// transcripts live (`~/.claude/projects/<mangle(cwd)>`, resumed with `claude -r <id>`).
// dispatch / follow / resume reach all of it through the AgentAdapter interface
// (src/types.js) — this is the reference adapter.
import fs from "node:fs";
import path from "node:path";
import { claudeProjectDir, mangle, sandboxClaudeProjectDir } from "../paths.js";
import { quotaFromRateLimitEvent } from "../quota.js";
import { urlRule } from "../sandbox/egress.js";

/** Reasoning-effort levels `claude -p --effort` accepts. An out-of-set value is
 * dropped (warn + omit the flag) so a typo falls back to the CLI default, never crashes. */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** A cwd-relative glob made absolute for a permission rule (`//<cwd>/<glob>`). @param {string} cwd @param {string} p */
const absRule = (cwd, p) => "/" + path.posix.join(cwd, p);
/** Both command forms of each prefix (`Bash(git)`, `Bash(git *)`). @param {string[]} [cmds] */
const bashRules = (cmds = []) => cmds.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]);

/**
 * The argv tail that enforces a step's `allow`/`deny` policy (pure). `allow` pins
 * `--permission-mode dontAsk` and lists what may run: reads under cwd, each command prefix, writes
 * to each `allow.paths` glob and to the verdict file. `deny` lists `--disallowedTools`, which hold
 * in every mode, bypass included. Paths are cwd-relative globs made absolute (`//<cwd>/<glob>`).
 * Neither set → []. The flags are variadic, so nothing positional may follow this tail.
 * @param {{allow?: import('../types.js').StepPolicy, deny?: import('../types.js').StepPolicy, cwd?: string, verdictFile?: string}} o
 * @returns {string[]}
 */
export function claudePolicyArgs({ allow, deny, cwd = "", verdictFile }) {
  const out = [];
  if (allow) {
    out.push("--permission-mode", "dontAsk", "--allowedTools", `Read(${absRule(cwd, "**")})`, ...bashRules(allow.commands));
    for (const p of allow.paths ?? []) out.push(`Edit(${absRule(cwd, p)})`);
    if (verdictFile) out.push(`Edit(/${verdictFile})`);
  }
  if (deny) {
    out.push("--disallowedTools", ...bashRules(deny.commands));
    for (const p of deny.paths ?? []) out.push(`Read(${absRule(cwd, p)})`, `Edit(${absRule(cwd, p)})`);
  }
  return out;
}

/**
 * What every pinned (`dontAsk`) claude run adds so one run can't widen the next (pure): load only
 * user + project settings (`.claude/settings.local.json` is never read; the repo CLAUDE.md still
 * is) and deny editor writes to the worktree's `.claude/settings.json` / `.claude/settings.local.json`.
 * No `cwd` → no settings-file rules.
 * @param {{cwd?: string}} o
 * @returns {{sources: string[], disallow: string[]}}
 */
export function claudeSettingsGuardArgs({ cwd }) {
  return {
    sources: ["--setting-sources", "user,project"],
    disallow: cwd ? [".claude/settings.json", ".claude/settings.local.json"].map((f) => `Edit(${absRule(cwd, f)})`) : [],
  };
}

/**
 * The permission argv tail of a claude run (pure). `fullAuto` without `allow` = bypass:
 * `--dangerously-skip-permissions` plus the step's deny group, nothing else. Every other run is
 * pinned, so the user's `defaultMode` never decides: `--setting-sources user,project
 * --permission-mode dontAsk`, the `allow` policy's rules (or just the verdict file), then one
 * `--disallowedTools` group with the deny rules and the settings-file guard. A flag whose list is
 * empty is omitted. The flags are variadic, so nothing positional may follow this tail.
 * @param {{fullAuto?: boolean, allow?: import('../types.js').StepPolicy, deny?: import('../types.js').StepPolicy, cwd?: string, verdictFile?: string}} o
 * @returns {string[]}
 */
export function claudePermissionArgs({ fullAuto, allow, deny, cwd, verdictFile }) {
  if (fullAuto && !allow) return ["--dangerously-skip-permissions", ...claudePolicyArgs({ deny, cwd })];
  const guard = claudeSettingsGuardArgs({ cwd });
  const allowed = allow ? claudePolicyArgs({ allow, cwd, verdictFile }).slice(3) : verdictFile ? [`Edit(/${verdictFile})`] : [];
  const disallowed = [...(deny ? claudePolicyArgs({ deny, cwd }).slice(1) : []), ...guard.disallow];
  const out = [...guard.sources, "--permission-mode", "dontAsk"];
  if (allowed.length) out.push("--allowedTools", ...allowed);
  if (disallowed.length) out.push("--disallowedTools", ...disallowed);
  return out;
}

/**
 * Build the `claude -p` argv (pure, exported so the flag wiring is unit-testable
 * without a real spawn). Order is stable: prompt, then --model, --effort, then the permission
 * tail (claudePermissionArgs) last.
 * @param {{prompt: string, model?: string, effort?: string, provider?: string, fullAuto?: boolean, maxMs?: number, allow?: import('../types.js').StepPolicy, deny?: import('../types.js').StepPolicy, cwd?: string, verdictFile?: string}} o
 * @returns {string[]}
 */
export function buildClaudeArgs({ prompt, model, effort, provider, fullAuto, allow, deny, cwd, verdictFile }) {
  // --output-format stream-json + --verbose: stdout becomes JSONL we parse for the
  // per-run log (assistant text) and the token/cost tally (the final `result` event).
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (model) args.push("--model", model);
  if (effort) {
    if (EFFORT_LEVELS.includes(effort)) args.push("--effort", effort);
    else console.warn(`[dispatch] ignoring invalid effort "${effort}" (expected ${EFFORT_LEVELS.join("|")})`);
  }
  if (provider) console.warn(`[dispatch] ignoring provider "${provider}" — claude has no provider flag`);
  args.push(...claudePermissionArgs({ fullAuto, allow, deny, cwd, verdictFile }));
  return args;
}

/**
 * Incremental parser for `claude -p --output-format stream-json --verbose` stdout:
 * one JSON object per line. Buffers partial lines across chunk boundaries, renders
 * assistant **text** content blocks to human-readable log text (non-text blocks and
 * non-JSON lines ignored — never throws), keeps a running token tally, and captures
 * the final `{type:"result"}` event, plus the latest subscription-quota reading from a
 * `rate_limit_event` (src/quota.js; a malformed one leaves it unchanged). Pure (no I/O),
 * stateful — feed chunks via push(), flush() any tail at EOF, then read `.tally` / `.result` /
 * `.quota`. Exported for unit tests.
 * @returns {{push:(chunk:string)=>string, flush:()=>string, tally:{input:number,output:number,cacheRead:number,cacheCreate:number}, result:any, quota:import('../quota.js').QuotaReading|null}}
 */
export function createStreamParser() {
  let buf = "";
  const tally = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  /** @type {any} */
  let result = null;
  /** @type {import('../quota.js').QuotaReading|null} */
  let quota = null;

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
      // A background-capable run emits one `result` per turn; keep the latest event's
      // fields (session_id, total_cost_usd — already cumulative, modelUsage, is_error, …)
      // but sum usage/duration across turns so a multi-turn run's totals aren't just its
      // last turn. A single-result stream is unchanged (prior === null short-circuits the sum).
      const prior = result;
      result = ev;
      const u = ev.usage;
      if (u && typeof u === "object") {
        const pu = (prior && prior.usage) || {};
        if (typeof u.input_tokens === "number") tally.input = u.input_tokens + (pu.input_tokens || 0);
        if (typeof u.output_tokens === "number") tally.output = u.output_tokens + (pu.output_tokens || 0);
        if (typeof u.cache_read_input_tokens === "number") tally.cacheRead = u.cache_read_input_tokens + (pu.cache_read_input_tokens || 0);
        if (typeof u.cache_creation_input_tokens === "number") tally.cacheCreate = u.cache_creation_input_tokens + (pu.cache_creation_input_tokens || 0);
        result.usage = { ...u, input_tokens: tally.input, output_tokens: tally.output, cache_read_input_tokens: tally.cacheRead, cache_creation_input_tokens: tally.cacheCreate };
      }
      if (typeof ev.duration_ms === "number") result.duration_ms = ev.duration_ms + (prior && typeof prior.duration_ms === "number" ? prior.duration_ms : 0);
      return "";
    }
    if (ev.type === "rate_limit_event") {
      quota = quotaFromRateLimitEvent(ev) ?? quota;
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
    get quota() {
      return quota;
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

/** Entry names in a dir ([] if unreadable). @param {string} dir */
const entries = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** `.jsonl` names in a dir ([] if unreadable). @param {string} dir */
const jsonls = (dir) => entries(dir).filter((f) => f.endsWith(".jsonl"));

/** The env vars a sandboxed claude can authenticate with (the host login can't be shared: it
 * lives in the macOS Keychain, and a shared ~/.claude/.credentials.json races the host's refresh). */
export const SANDBOX_CREDENTIAL_VARS = /** @type {const} */ (["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]);

/** Why a sandboxed claude run can't authenticate with `env` (the spawn env), else undefined. Pure.
 * @param {Record<string, string|undefined>|undefined} env */
export function sandboxCredentialProblem(env) {
  if (SANDBOX_CREDENTIAL_VARS.some((k) => env?.[k])) return undefined;
  return "sandboxed claude has no credentials — run `claude setup-token` and put CLAUDE_CODE_OAUTH_TOKEN in the profile's .env (or set ANTHROPIC_API_KEY)";
}

/** @param {string|undefined} v */
const truthy = (v) => !!v && !/^(0|false|no|off)$/i.test(v.trim());

/**
 * The model-API egress rules of a claude run with spawn env `env`: api.anthropic.com, the host
 * of ANTHROPIC_BASE_URL (another model behind a compatible endpoint), and the Bedrock or
 * Vertex endpoints when those are switched on. Telemetry needs nothing: a sandboxed claude
 * sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC. Pure.
 * @param {Record<string, string|undefined>} env @returns {string[]}
 */
export function claudeEgressHosts(env) {
  const out = ["api.anthropic.com"];
  /** @param {string|undefined} url */
  const add = (url) => {
    const rule = urlRule(url);
    if (rule) out.push(rule);
  };
  add(env.ANTHROPIC_BASE_URL);
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK)) {
    const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
    if (region) out.push(`bedrock-runtime.${region}.amazonaws.com`);
    add(env.ANTHROPIC_BEDROCK_BASE_URL);
  }
  if (truthy(env.CLAUDE_CODE_USE_VERTEX)) {
    const region = env.CLOUD_ML_REGION;
    out.push(region && region !== "global" ? `${region}-aiplatform.googleapis.com` : "aiplatform.googleapis.com", "oauth2.googleapis.com");
    add(env.ANTHROPIC_VERTEX_BASE_URL);
  }
  return out;
}

/** @type {import('../types.js').AgentAdapter} */
export const claude = {
  describe: () => ({ name: "claude", stdout: "stream-json", policy: { allow: true, deny: true } }),
  envPassthrough: ["ANTHROPIC_*", "CLAUDE_*"],
  // No step benefits from a background subagent getting killed at the headless print-mode
  // ceiling (10 min of no output) — maxMinutes/idleMinutes already bound the run. A step's
  // own `env` still wins (buildAgentEnv layers it last).
  env: () => ({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" }),
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
      get quota() {
        return p.quota;
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
    files: (dir) => jsonls(dir).map((f) => ({ id: f.replace(/\.jsonl$/, ""), file: path.join(dir, f) })),
    // Every `~/.claude/projects` sibling named after the base's mangle + "-" = the
    // transcript dirs of the cwds under it (`<base>/<ref>`).
    cwdDirs(baseCwd) {
      const base = claudeProjectDir(baseCwd);
      const projects = path.dirname(base);
      const prefix = path.basename(base) + "-";
      return { dirs: entries(projects).filter((e) => e.startsWith(prefix)).map((e) => path.join(projects, e)), searched: path.join(projects, `${prefix}*`) };
    },
    sandboxTranscriptDir: sandboxClaudeProjectDir,
  },
  preflight: ({ sandboxed, env }) => (sandboxed ? sandboxCredentialProblem(env) : undefined),
  egressHosts: claudeEgressHosts,
  // Sandboxed: only this run's transcript dir is shared (at the container HOME's
  // `.claude/projects/<mangle(cwd)>`, where claude writes it), so follow/resume read it on the
  // host. Never ~/.claude or ~/.claude.json — other projects' transcripts and the OAuth
  // credentials stay on the host. A cwd the run doesn't own (no-worktree: the main checkout)
  // gets a receiver-owned dir instead: the host's dir for that cwd holds the operator's own
  // sessions and auto-memory, which a hostile ticket must neither read nor plant into.
  sandbox({ cfg, cwd, ownsCwd, home }) {
    const dir = ownsCwd ? claudeProjectDir(cwd) : sandboxClaudeProjectDir(cfg.stateDir, cwd);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return {
      mounts: [{ path: dir, dst: path.posix.join(home, ".claude", "projects", mangle(cwd)) }],
      env: {
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        // A worktree bind-mounted at its host path under /tmp/claude-<uid>/... makes the
        // runtime create that parent as root inside the container; claude then refuses its
        // default temp dir (uid-owned-by-root check). Point it under the uid-owned HOME instead.
        CLAUDE_CODE_TMPDIR: path.posix.join(home, ".tmp"),
      },
    };
  },
  defaults: {},
};
