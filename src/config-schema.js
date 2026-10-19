// The one definition of every user config key (epic #344): label, one-line help, section, and the
// hints a form needs (default, options, min/max). The config editor renders its fields from it and
// test/config-schema.test.js holds it to src/types.js — a typedef key with no entry here (and no
// NO_FORM reason) fails CI, so a new key can't silently fall out of the forms.
// Import-free on purpose: the browser bundles it (like src/identity.js and src/ui/contract.js). Its
// imports, src/agents/names.js and src/sandbox/names.js, are themselves import-free (the
// registries are Node-side).
import { AGENT_NAMES, DEFAULT_AGENT } from "./agents/names.js";
import { SANDBOX_NAMES, EGRESS_MODES } from "./sandbox/names.js";

/** Step prompt shapes (`Step.kind`). */
export const STEP_KINDS = /** @type {const} */ (["implement", "change", "review", "triage"]);
/** `claude -p --effort` levels (`Step.effort`, `lite.effort`, `escalate.*.effort`). */
export const STEP_EFFORTS = /** @type {const} */ (["low", "medium", "high", "xhigh", "max"]);

/** The tracker types whose steps bind stage keys of each family (src/types.js `Step`). */
const STATUS_TRACKERS = ["jira", "github-projects", "local", "linear"];

/**
 * One config key. `path` is absolute from the config root; `"*"` stands for any array index or
 * record key. `editor: "pending"` marks a key no form edits yet (Raw only, for now).
 * @typedef {object} SchemaEntry
 * @property {string[]} path
 * @property {'string'|'number'|'boolean'|'enum'|'string-list'|'record'|'object'|'array'} type
 * @property {string} label
 * @property {string} help        one line, ≤120 chars
 * @property {'basics'|'pipeline-step'|'tracker'|'forge'|'ingress'|'integrations'|'repos'} section
 * @property {boolean} [advanced]
 * @property {string[]} [scope]   tracker types it applies to (forge.* entries: forge types); omitted = all
 * @property {boolean} [sensitive]  mirrors src/ui/contract.js SENSITIVE_FIELDS (a test keeps them equal)
 * @property {string|number|boolean} [default]
 * @property {readonly string[]} [options]  enum values
 * @property {number} [min]       mirrors src/config.js validateRawConfig; the form never clamps
 * @property {number} [max]
 * @property {string} [placeholder]  shown when unset and there is no `default` to show
 * @property {'pending'} [editor]
 */

/**
 * @param {string} path  dotted, e.g. "tracker.pipeline.*.maxMinutes"
 * @param {SchemaEntry['type']} type
 * @param {string} label
 * @param {SchemaEntry['section']} section
 * @param {string} help
 * @param {Partial<SchemaEntry>} [extra]
 * @returns {SchemaEntry}
 */
const entry = (path, type, label, section, help, extra = {}) => ({ path: path.split("."), type, label, help, section, ...extra });

/** A pipeline-step key: `tracker.pipeline.*.<key>`. @param {string} key @param {SchemaEntry['type']} type @param {string} label @param {string} help @param {Partial<SchemaEntry>} [extra] */
const step = (key, type, label, help, extra = {}) => entry(`tracker.pipeline.*.${key}`, type, label, "pipeline-step", help, extra);

/** @type {SchemaEntry[]} */
export const CONFIG_SCHEMA = [
  // Basics
  entry("name", "string", "Profile name", "basics", "Display label in the UI and sinks; keys the state dir only when stateId is unset.", { sensitive: true }),
  entry("stateId", "string", "State id", "basics", "Stable state-dir key, so the name can change without moving ~/.agenthook/<stateId>/.", { advanced: true }),
  entry("trigger", "string", "Resume trigger", "basics", "Start your reply on a held task with this to re-run the held step with the reply as context.", { default: "@agent" }),
  entry("maxConcurrent", "number", "Max concurrent agents", "basics", "How many agents may run at once, across every step.", { default: 1, min: 1 }),
  entry("port", "number", "Local port", "basics", "Local port the receiver listens on; the ingress forwards webhooks to it.", { default: 4123 }),
  entry("fullAuto", "boolean", "Full auto (skip permissions)", "basics", "--dangerously-skip-permissions. Off: privileged calls are denied (headless) unless a step allow policy permits them.", { sensitive: true, default: false }),
  entry("agentEnvPassthrough", "string-list", "Agent env passthrough", "basics", "Receiver env vars agents also get (NAME or PREFIX*); everything else is stripped. \"*\" = inherit all (0.9).", { advanced: true, sensitive: true }),
  entry("githubRunToken", "boolean", "Per-run GitHub token", "basics", "Under GitHub App auth, give each agent run its own 1h token scoped to its repo instead of your token.", { advanced: true, sensitive: true, default: true }),
  entry("agent", "enum", "Agent", "basics", "The coding-agent CLI steps spawn unless a step names its own.", { advanced: true, options: AGENT_NAMES, default: DEFAULT_AGENT }),
  entry("agentProvider", "string", "Agent provider", "basics", "Default inference provider for steps (hermes --provider); a step's provider overrides it.", { advanced: true }),
  entry("claudeBin", "string", "Claude binary", "basics", "The claude CLI agents are spawned with: a name on PATH or an absolute path.", { advanced: true, sensitive: true, default: "claude" }),
  entry("instructionsFile", "string", "Default instructions file", "basics", "Standing instructions for steps that set none; relative to the config file.", { default: "./INSTRUCTIONS.md" }),
  entry("ui", "object", "Appearance", "basics", "The profile's colour and emoji in the web UI; unset values derive from the state key."),
  entry("ui.color", "string", "Colour", "basics", "A palette colour for the profile's Home card and app-bar chip; automatic when unset."),
  entry("ui.emoji", "string", "Emoji", "basics", "An emoji from the curated list for the profile; automatic when unset."),
  entry("sandbox", "object", "Sandbox", "basics", "Run each agent in its own container with only its worktree mounted (docker or podman).", { advanced: true, editor: "pending" }),
  entry("sandbox.type", "enum", "Sandbox backend", "basics", "Container runtime for per-run sandboxes.", { options: SANDBOX_NAMES, sensitive: true, advanced: true, editor: "pending" }),
  entry("sandbox.image", "string", "Sandbox image", "basics", "Agent image; must provide sh, git, gh and the agent CLI. Default agenthook-agent:<version>.", { sensitive: true, advanced: true, editor: "pending" }),
  entry("sandbox.memory", "string", "Sandbox memory", "basics", "Per-run container memory cap, e.g. 4g.", { advanced: true, editor: "pending" }),
  entry("sandbox.cpus", "number", "Sandbox CPUs", "basics", "Per-run container CPU cap.", { min: 0.1, advanced: true, editor: "pending" }),
  entry("sandbox.egress", "object", "Sandbox egress", "basics", "Network policy for sandboxed runs.", { advanced: true, editor: "pending" }),
  entry("sandbox.egress.mode", "enum", "Egress mode", "basics", "allowlist: only the model API, forge, tracker and allowed hosts; none: no network; open: unrestricted.", { options: EGRESS_MODES, default: "allowlist", sensitive: true, advanced: true, editor: "pending" }),
  entry("sandbox.egress.allow", "string-list", "Egress allow", "basics", "Extra hosts (host, *.domain, host:port) or presets (@npm @pypi @crates @go @rubygems @maven @yarn).", { advanced: true, editor: "pending" }),
  entry("sandbox.egress.deny", "string-list", "Egress deny", "basics", "Hosts to remove from the defaults (e.g. the tracker API).", { advanced: true, editor: "pending" }),

  // Repos
  entry("repoPath", "string", "Repo path", "repos", "The checkout agents work in (single-repo profiles); relative to the config file."),
  entry("worktreePrefix", "string", "Worktree prefix", "repos", "Where agent worktrees are created, resolved against the repo path.", { advanced: true, default: "../agenthook-worktrees" }),
  entry("repos", "array", "Repositories", "repos", "Several checkouts; a task's route keys pick the repo its agents work in."),
  entry("repos.*.id", "string", "Repo id", "repos", "Stable id (letters, digits, . _ -); names the worktree subdir."),
  entry("repos.*.path", "string", "Path", "repos", "This repo's checkout root; relative to the config file."),
  entry("repos.*.match", "string-list", "Route keys", "repos", "Route-key values that select this repo (compared case-insensitively)."),
  entry("repos.*.default", "boolean", "Default repo", "repos", "Tasks with no route key go here; at most one repo may set it."),
  entry("repos.*.instructionsFile", "string", "Repo instructions", "repos", "Repo context prepended to every step's standing instructions."),
  entry("repos.*.worktreePrefix", "string", "Worktree prefix", "repos", "Per-repo override of worktreePrefix, resolved against this repo's path.", { advanced: true }),

  // Tracker
  entry("tracker", "object", "Tracker", "tracker", "Where work comes from: the board whose stages drive the pipeline."),
  entry("tracker.type", "enum", "Tracker type", "tracker", "Which tracker adapter reads the board.", { options: ["asana", "jira", "github", "github-projects", "local", "linear"] }),
  entry("tracker.token", "string", "API token", "tracker", "Tracker API token; use a ${VAR} reference, not a literal.", { sensitive: true, scope: ["asana", "jira", "github", "github-projects", "linear"] }),
  entry("tracker.auth", "object", "GitHub App auth", "tracker", "Authenticate as a GitHub App instead of a token; needs assigneeLogin.", { scope: ["github", "github-projects"], advanced: true }),
  entry("tracker.auth.type", "enum", "Auth type", "tracker", "app: mint short-lived installation tokens from the App's private key.", { options: ["app"], scope: ["github", "github-projects"], advanced: true }),
  entry("tracker.auth.appId", "string", "App id", "tracker", "The GitHub App's id (App settings → General).", { scope: ["github", "github-projects"], advanced: true }),
  entry("tracker.auth.installationId", "string", "Installation id", "tracker", "The App's installation on the repo or org (the number in …/installations/<id>).", { scope: ["github", "github-projects"], advanced: true }),
  entry("tracker.auth.privateKey", "string", "Private key", "tracker", "The App's PEM private key; use a ${VAR} reference (literal \\n becomes a newline).", { sensitive: true, scope: ["github", "github-projects"], advanced: true }),
  entry("tracker.auth.privateKeyPath", "string", "Private key file", "tracker", "Or a PEM file holding the App's private key; relative to the config file.", { scope: ["github", "github-projects"], advanced: true }),
  entry("tracker.userGid", "string", "User gid", "tracker", "Your Asana user gid; only tasks assigned to it are acted on.", { sensitive: true, scope: ["asana"] }),
  entry("tracker.assigneeFilter", "boolean", "Only my tasks", "tracker", "Act only on items assigned to the bot identity; false opts into acting project-wide.", { sensitive: true, default: true }),
  entry("tracker.workspaceGid", "string", "Workspace gid", "tracker", "The Asana workspace holding the project.", { scope: ["asana"] }),
  entry("tracker.projectGid", "string", "Project gid", "tracker", "The Asana project whose sections drive the pipeline.", { scope: ["asana"] }),
  entry("tracker.displayIdField", "string", "Display id field", "tracker", "Custom field holding the task's human id (case-insensitive).", { scope: ["asana"], default: "ID", advanced: true }),
  entry("tracker.site", "string", "Site", "tracker", "Jira site shortname (<site>.atlassian.net); or set baseUrl instead.", { scope: ["jira"] }),
  entry("tracker.baseUrl", "string", "Base URL", "tracker", "Full Jira base URL; overrides site.", { scope: ["jira"] }),
  entry("tracker.email", "string", "Account email", "tracker", "Jira account email for Basic auth; typically a ${VAR} reference.", { sensitive: true, scope: ["jira"] }),
  entry("tracker.webhookSecret", "string", "Webhook secret", "tracker", "Signing secret; omit to let agenthook generate one, or set false to skip verification.", { sensitive: true, scope: ["jira", "github", "github-projects", "linear"], advanced: true }),
  entry("tracker.projectKey", "string", "Project key", "tracker", "The Jira project whose statuses drive the pipeline (e.g. CAHUI).", { scope: ["jira"] }),
  entry("tracker.assigneeAccountId", "string", "Assignee account id", "tracker", "The bot's Jira accountId; work is scoped to its issues.", { scope: ["jira"] }),
  entry("tracker.repository", "string", "Repository", "tracker", "owner/name of the GitHub repo whose issues drive the pipeline.", { scope: ["github", "github-projects"] }),
  entry("tracker.owner", "string", "Owner", "tracker", "GitHub repo owner (alternative to repository).", { scope: ["github"], advanced: true }),
  entry("tracker.repo", "string", "Repo", "tracker", "GitHub repo name (alternative to repository).", { scope: ["github"], advanced: true }),
  entry("tracker.assigneeLogin", "string", "Assignee login", "tracker", "The bot's GitHub login; work is scoped to its issues. Derived from the token when unset; required for an App.", { scope: ["github", "github-projects"] }),
  entry("tracker.project", "string", "Project board", "tracker", "Projects v2 board as owner/number or its URL; its Status field drives the pipeline.", { scope: ["github-projects"] }),
  entry("tracker.team", "string", "Team", "tracker", "Linear team key (e.g. ENG) or team URL; its workflow states drive the pipeline.", { scope: ["linear"] }),
  entry("tracker.routeField", "string", "Route field", "tracker", "Tracker field whose value(s) pick the repo a task runs in (multi-repo routing).", { advanced: true }),
  entry("tracker.epicType", "string", "Epic type", "tracker", 'Type name that marks an epic (default "Epic"; Jira: the level-1 issue type).', { scope: ["asana", "jira", "github", "github-projects"], advanced: true }),
  entry("tracker.epicLabel", "string", "Epic label", "tracker", "Label that marks an epic; either this or epicType marks one.", { scope: ["github", "github-projects"], default: "epic", advanced: true }),
  entry("tracker.pipeline", "array", "Pipeline", "pipeline-step", "The ordered steps; a task entering a step's source stage fires that step."),

  // Pipeline steps — the fields the step card edits today
  step("id", "string", "Step id", "Unique, stable id; keys this step's dedup and running state."),
  step("kind", "enum", "Kind", "The prompt shape the agent gets.", { options: STEP_KINDS, default: "implement" }),
  step("manual", "boolean", "Manual (no agent)", "No agent runs; entering the step only does system actions (e.g. removing the worktree)."),
  step("model", "string", "Model", "Per-step --model override for this step's agent; unset uses the agent's default."),
  step("effort", "enum", "Reasoning effort", "Per-step reasoning-effort override: claude --effort, hermes --reasoning, opencode --variant; cursor ignores it.", { options: STEP_EFFORTS }),
  step("agent", "enum", "Agent", "This step's coding-agent CLI; unset uses the profile's agent.", { advanced: true, options: AGENT_NAMES }),
  step("bin", "string", "Agent binary", "This step's agent CLI (a name on PATH or an absolute path); unset uses the agent's default (claude → claudeBin).", { advanced: true, sensitive: true, placeholder: "claudeBin" }),
  step("provider", "string", "Provider", "Inference provider for this step's agent (hermes --provider); other agents ignore it.", { advanced: true }),
  step("isolated", "boolean", "Isolated", "Hermes: own HERMES_HOME (only config.yaml copied), no user rules; local providers only. Others ignore it.", { advanced: true, default: true }),
  step("energy", "boolean", "Measure energy", "Record this step's runs' electricity (kWh + $) from the profile's energy source.", { advanced: true }),
  step("toolsets", "string-list", "Toolsets", "Hermes -t: the toolsets this step's agent may use; other agents ignore it.", { advanced: true, placeholder: "terminal, file" }),
  step("allow", "object", "Allow policy", "Commands and paths this step's agent may use; all else denied. claude only (other agents' runs are refused).", { advanced: true, sensitive: true }),
  step("allow.commands", "string-list", "Allowed commands", "Command prefixes the agent may run (e.g. git, npm test). Advisory unsandboxed: an allowed interpreter runs anything.", { advanced: true }),
  step("allow.paths", "string-list", "Writable paths", "cwd-relative globs the agent may edit (e.g. src/**); reads inside the worktree stay allowed.", { advanced: true }),
  step("deny", "object", "Deny policy", "Commands and paths this step's agent may never use; enforced even under fullAuto (claude only).", { advanced: true, sensitive: true }),
  step("deny.commands", "string-list", "Denied commands", "Command prefixes the agent may never run (e.g. curl).", { advanced: true }),
  step("deny.paths", "string-list", "Denied paths", "cwd-relative globs the agent may never read or edit (e.g. .github/workflows/**).", { advanced: true }),
  step("sandbox", "boolean", "Sandboxed", "false runs this step on the host even when the profile has a sandbox.", { sensitive: true, advanced: true }),
  step("egress", "object", "Egress", "This step's network policy for sandboxed runs; mode overrides the profile's, allow/deny add to it.", { advanced: true, editor: "pending" }),
  step("egress.mode", "enum", "Egress mode", "allowlist: only the model API, forge, tracker and allowed hosts; none: no network; open: unrestricted.", { options: EGRESS_MODES, sensitive: true, advanced: true, editor: "pending" }),
  step("egress.allow", "string-list", "Egress allow", "Extra hosts (host, *.domain, host:port) or presets (@npm @pypi @crates @go @rubygems @maven @yarn).", { advanced: true, editor: "pending" }),
  step("egress.deny", "string-list", "Egress deny", "Hosts to remove from the defaults (e.g. the tracker API).", { advanced: true, editor: "pending" }),
  step("env", "record", "Agent env", "Extra environment for this step's agent only; put secret values in ${VAR} refs.", { advanced: true, sensitive: true }),
  step("instructionsFile", "string", "Instructions file", "Standing instructions for this step; unset uses the profile's instructionsFile."),
  step("maxAttempts", "number", "Max attempts", "Runs allowed per task before a changes loop back into this step fails instead.", { default: 3, min: 1 }),
  step("maxMinutes", "number", "Wall-clock limit (min)", "Kill a run after this many minutes and fail it as a timeout; 0 = no cap.", { default: 120, min: 0, advanced: true }),
  step("idleMinutes", "number", "Idle timeout (min)", "Kill a run after this many minutes with no agent output (must be > 0); off when unset.", { placeholder: "off", advanced: true }),
  step("requireVerdict", "boolean", "Require verdict", "A clean exit without a valid verdict file holds the task instead of advancing it.", { advanced: true }),
  step("createsWorktree", "boolean", "Creates worktree", "Create the task's shared git worktree before the agent runs."),
  step("drainWorktree", "boolean", "Removes worktree", "Remove the task's worktree after this step."),
  step("sourceSectionGid", "string", "Source section", "Asana section whose tasks fire this step.", { scope: ["asana"] }),
  step("successSectionGid", "string", "Success section", "Asana section a clean finish (advance) moves the task to.", { scope: ["asana"] }),
  step("failureSectionGid", "string", "Failure section", "Asana section a failed or interrupted run moves the task to.", { scope: ["asana"] }),
  step("holdSectionGid", "string", "Hold section", "Asana section a hold verdict moves the task to; unset leaves it in place.", { scope: ["asana"], advanced: true }),
  step("queueSectionGid", "string", "Queue section", "Opt-in backlog section this step pulls from, in section order, when a slot frees.", { scope: ["asana"], advanced: true }),
  step("sourceStatus", "string", "Source status", "Status whose items fire this step.", { scope: STATUS_TRACKERS }),
  step("successStatus", "string", "Success status", "Status a clean finish (advance) moves the item to.", { scope: STATUS_TRACKERS }),
  step("failureStatus", "string", "Failure status", "Status a failed or interrupted run moves the item to.", { scope: STATUS_TRACKERS }),
  step("holdStatus", "string", "Hold status", "Status a hold verdict moves the item to; unset leaves it in place.", { scope: STATUS_TRACKERS, advanced: true }),
  step("queueStatus", "string", "Queue status", "Opt-in backlog status this step pulls from, in board order, when a slot frees.", { scope: STATUS_TRACKERS, advanced: true }),
  step("sourceLabel", "string", "Source label", "An issue carrying this label fires this step.", { scope: ["github"] }),
  step("successLabel", "string", "Success label", "Label a clean finish (advance) swaps the issue to.", { scope: ["github"] }),
  step("failureLabel", "string", "Failure label", "Label a failed or interrupted run swaps the issue to.", { scope: ["github"] }),
  step("holdLabel", "string", "Hold label", "Label a hold verdict swaps the issue to; unset leaves it in place.", { scope: ["github"], advanced: true }),
  step("queueLabel", "string", "Queue label", "Opt-in backlog label this step pulls from, oldest-created first, when a slot frees.", { scope: ["github"], advanced: true }),

  // Pipeline steps — common + advanced
  step("maxConcurrent", "number", "Max concurrent runs", "Runs of this step at once, counted inside the global limit; unset = only that limit.", { min: 1, advanced: true }),
  step("completeOnMerge", "boolean", "Complete on merge", "Manual steps only, at most one: a merged agent PR moves the task into this step.", { advanced: true }),
  step("closeIssue", "boolean", "Close issue", "Entering this (terminal) step closes the issue, releasing the issues it blocked.", { scope: ["github"], advanced: true }),
  step("completeTask", "boolean", "Complete task", "Entering this (terminal) step marks the task completed, releasing the tasks it blocked.", { scope: ["asana"], advanced: true }),
  step("lite", "object", "Lite mode", "A cheaper model/effort when the description starts a line with every listed heading.", { advanced: true }),
  step("lite.descriptionHeadings", "string-list", "Description headings", "Headings that must each start a line of the task description for lite to apply."),
  step("lite.model", "string", "Lite model", "The base model when lite applies."),
  step("lite.effort", "enum", "Lite effort", "The base effort when lite applies.", { options: STEP_EFFORTS }),
  step("escalate", "record", "Escalation", "Per-difficulty (easy/medium/hard) model and effort overrides; they win over lite.", { advanced: true }),
  step("escalate.*.model", "string", "Escalated model", "The model used when the task's stored difficulty matches this key."),
  step("escalate.*.effort", "enum", "Escalated effort", "The effort used when the task's stored difficulty matches this key.", { options: STEP_EFFORTS }),

  // Ingress
  entry("ingress", "object", "Ingress", "ingress", "How webhooks reach this receiver from the internet."),
  entry("ingress.type", "enum", "Ingress type", "ingress", "ngrok / cloudflared / tailscale (Funnel) are managed per start; manual / hosted use a static URL you provide.", { options: ["ngrok", "cloudflared", "tailscale", "manual", "hosted"] }),
  entry("ingress.url", "string", "Public URL", "ingress", "Static public HTTPS base URL (manual / hosted ingress)."),
  entry("ingress.authtoken", "string", "ngrok authtoken", "ingress", "ngrok authtoken; use a ${VAR} reference, not a literal.", { sensitive: true }),
  entry("ingress.domain", "string", "ngrok domain", "ingress", "A reserved ngrok domain; keeps the public URL stable across restarts."),
  entry("ingress.webAddr", "string", "ngrok web address", "ingress", "ngrok's local web-API address; give each profile its own when tunnels run in parallel.", { default: "127.0.0.1:4040", advanced: true }),
  entry("ingress.tunnel", "string", "cloudflared tunnel", "ingress", "cloudflared named tunnel name or UUID; blank = quick tunnel."),
  entry("ingress.hostname", "string", "cloudflared hostname", "ingress", "Public hostname routed to the named tunnel."),

  // Forge
  entry("forge", "object", "Forge", "forge", "Optional: where the code lives, so merged PRs and red CI move tasks."),
  entry("forge.type", "enum", "Forge type", "forge", "Which forge adapter watches the agent PRs.", { options: ["github", "gitlab"] }),
  entry("forge.token", "string", "API token", "forge", "Forge API token; use a ${VAR} reference, not a literal.", { sensitive: true }),
  entry("forge.auth", "object", "GitHub App auth", "forge", "Authenticate as a GitHub App instead of a token.", { scope: ["github"], advanced: true }),
  entry("forge.auth.type", "enum", "Auth type", "forge", "app: mint short-lived installation tokens from the App's private key.", { options: ["app"], scope: ["github"], advanced: true }),
  entry("forge.auth.appId", "string", "App id", "forge", "The GitHub App's id (App settings → General).", { scope: ["github"], advanced: true }),
  entry("forge.auth.installationId", "string", "Installation id", "forge", "The App's installation on the repo (the number in …/installations/<id>).", { scope: ["github"], advanced: true }),
  entry("forge.auth.privateKey", "string", "Private key", "forge", "The App's PEM private key; use a ${VAR} reference (literal \\n becomes a newline).", { sensitive: true, scope: ["github"], advanced: true }),
  entry("forge.auth.privateKeyPath", "string", "Private key file", "forge", "Or a PEM file holding the App's private key; relative to the config file.", { scope: ["github"], advanced: true }),
  entry("forge.repository", "string", "Repository", "forge", "owner/name of the repo whose agent PRs complete tasks.", { scope: ["github"] }),
  entry("forge.owner", "string", "Owner", "forge", "Repo owner (alternative to repository).", { advanced: true, scope: ["github"] }),
  entry("forge.repo", "string", "Repo", "forge", "Repo name (alternative to repository).", { advanced: true, scope: ["github"] }),
  entry("forge.project", "string", "Project", "forge", "GitLab: group/sub/project whose agent MRs complete tasks.", { scope: ["gitlab"] }),
  entry("forge.baseUrl", "string", "Base URL", "forge", "GitLab: instance base URL, for a self-managed GitLab.", { advanced: true, default: "https://gitlab.com", scope: ["gitlab"] }),
  entry("forge.webhookSecret", "string", "Webhook secret", "forge", "Signing secret; omit to let agenthook generate one. Always verified.", { sensitive: true, advanced: true }),
  entry("forge.redCi", "boolean", "React to red CI", "forge", "On red CI for an agent PR, re-run it once, then send the task back with changes.", { default: true }),
  entry("forge.greenCi", "boolean", "Report green CI", "forge", "Emit a ci_green event when an agent PR's checks all pass (moves nothing).", { default: true }),
  entry("forge.ciTarget", "string", "Red-CI target step", "forge", "Step a red-CI bounce returns to; unset = the step that creates the worktree.", { advanced: true }),

  // Integrations
  entry("overlapGuard", "boolean", "Overlap guard", "integrations", "Hold a worktree step while its predicted file paths overlap another in-flight task's.", { advanced: true, default: false }),
  entry("sinks", "array", "Sinks", "integrations", "Forward lifecycle events (blocked, failed, done, …) to a chat or a webhook."),
  entry("sinks.*.type", "enum", "Sink type", "integrations", "Where this sink sends events.", { options: ["slack", "telegram", "webhook"] }),
  entry("sinks.*.url", "string", "URL", "integrations", "Slack incoming-webhook or generic webhook URL; use a ${VAR} reference.", { sensitive: true }),
  entry("sinks.*.botToken", "string", "Bot token", "integrations", "Telegram bot token; use a ${VAR} reference, not a literal.", { sensitive: true }),
  entry("sinks.*.chatId", "string", "Chat id", "integrations", "Telegram chat id (a string or a number)."),
  entry("sinks.*.events", "string-list", "Events", "integrations", "Events to forward; unset = blocked, failed, move_refused, pipeline_done."),
  entry("digest", "object", "Digest", "integrations", "The on-demand Digest: a tool-less agent that summarises this profile's state."),
  entry("digest.soul", "string", "SOUL file", "integrations", "Markdown role file for the Digest agent; resolved beside the config file.", { default: "SOUL.md" }),
  entry("digest.access", "enum", "Access", "integrations", "What the Digest agent may read; only snapshot (the profile's state summary) today.", { options: ["snapshot"], default: "snapshot" }),
  entry("digest.model", "string", "Model", "integrations", "claude --model for the Digest run; unset uses the CLI default."),
  entry("digest.maxBudgetUsd", "number", "Max budget (USD)", "integrations", "Spending cap per Digest run (claude --max-budget-usd); must be > 0.", { advanced: true }),
  entry("pricing", "record", "Pricing", "integrations", "API-equivalent $/Mtok for a model or glob, e.g. map qwen3.8* to Sonnet rates; overrides the built-in table.", { advanced: true }),
  entry("pricing.*.input", "number", "Input $/Mtok", "integrations", "Estimated dollars per million uncached input tokens.", { advanced: true, min: 0 }),
  entry("pricing.*.output", "number", "Output $/Mtok", "integrations", "Estimated dollars per million output tokens.", { advanced: true, min: 0 }),
  entry("pricing.*.cacheRead", "number", "Cache read $/Mtok", "integrations", "Dollars per million cache-read tokens; unset = 0.1 × input.", { advanced: true, min: 0 }),
  entry("energy", "object", "Energy", "integrations", "Measure opted-in steps' electricity (kWh + $) beside the cost estimate; GPU-only with hwmon.", { advanced: true }),
  entry("energy.usdPerKwh", "number", "Price $/kWh", "integrations", "Your electricity price in dollars per kWh.", { advanced: true, min: 0 }),
  entry("energy.source", "object", "Power source", "integrations", "Where machine power is read: hwmon sysfs, a command printing watts, or a fixed draw.", { advanced: true }),
  entry("energy.source.type", "enum", "Source type", "integrations", "hwmon reads /sys/class/hwmon; command runs a shell command; watts is a fixed draw.", { advanced: true, options: ["hwmon", "command", "watts"] }),
  entry("energy.source.name", "string", "hwmon name", "integrations", "hwmon: the node name to read (every node with it is summed).", { advanced: true, default: "amdgpu" }),
  entry("energy.source.cmd", "string", "Command", "integrations", "command: run via /bin/sh -c each second; the first number on each line is summed as watts.", { advanced: true, sensitive: true }),
  entry("energy.source.watts", "number", "Fixed watts", "integrations", "watts: the constant draw assumed while a measured run is active (> 0).", { advanced: true }),
  entry("pricing.*.cacheWrite", "number", "Cache write $/Mtok", "integrations", "Dollars per million cache-write tokens; unset = 1.25 × input.", { advanced: true, min: 0 }),
  entry("quota", "object", "Quota pacing", "integrations", "Opt-in: pause new Claude runs when a subscription quota window gets high; resume at its reset.", { advanced: true }),
  entry("quota.pauseAboveSevenDay", "number", "Pause at weekly use", "integrations", "Pause new runs at/above this weekly (7-day) utilization, above 0 up to 1 (e.g. 0.9); unset = never.", { advanced: true, max: 1 }),
  entry("quota.pauseAboveFiveHour", "number", "Pause at 5-hour use", "integrations", "Pause new runs at/above this 5-hour utilization, above 0 up to 1 (e.g. 0.95); unset = never.", { advanced: true, max: 1 }),
];

const DERIVED = "derived at load, not user config";

/** Config keys deliberately left out of the forms, each with its reason (dotted path → reason). */
export const NO_FORM = /** @type {Record<string, string>} */ ({
  stateKey: `${DERIVED} (stateId ?? name)`,
  installDir: DERIVED,
  configPath: DERIVED,
  configDir: DERIVED,
  stateDir: DERIVED,
  provider: `${DERIVED} (= tracker.type)`,
  providerConfig: `${DERIVED} (alias of tracker)`,
  pipeline: `${DERIVED} (resolved tracker.pipeline)`,
  multiRepo: `${DERIVED} (true iff repos is declared)`,
  dataDir: DERIVED,
  logDir: DERIVED,
  publicUrlFile: DERIVED,
  pidFile: DERIVED,
  heartbeatFile: DERIVED,
  controlSock: DERIVED,
});

/**
 * The entry for a concrete path (numeric indices and record keys match `"*"`), or undefined.
 * @param {ReadonlyArray<string|number>} path @returns {SchemaEntry|undefined}
 */
export function schemaEntry(path) {
  return CONFIG_SCHEMA.find((e) => e.path.length === path.length && e.path.every((seg, i) => seg === "*" || seg === String(path[i])));
}

/** Shorthand for a pipeline-step key's entry (`tracker.pipeline.*.<key>`). @param {string} key */
export const stepEntry = (key) => schemaEntry(["tracker", "pipeline", "*", ...key.split(".")]);
