// The agent guide (docs/agent-guide.md) split by `## topic`, plus the one DYNAMIC topic,
// `authoring`: how to create a ticket / epic / dependency on THIS profile's tracker so the
// receiver picks it up. Rendered from the loaded config (steps, stage keys, epic type/label,
// scoping identity) — no network, no adapter instance — so it works with the receiver down and
// from a shell (`agenthook guide authoring`) as well as the MCP `guide` tool. The portable
// skill in `skills/agenthook/` tells agents to read this topic first instead of hardcoding
// provider facts.
import fs from "node:fs";

const GUIDE_FILE = new URL("../docs/agent-guide.md", import.meta.url);

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

/** Topic names the guide serves: the static `##` sections plus `authoring`. */
export function guideTopics(file = GUIDE_FILE) {
  return [...loadGuide(file).topics.keys(), AUTHORING];
}

export const AUTHORING = "authoring";

/**
 * Per-provider facts the renderer needs that live in the adapters (describe().stageKeys) or in
 * their behaviour (epic rule, blocker support). Kept as data here so the topic renders without
 * constructing an adapter (which needs tokens). Keep in sync with src/trackers/<kind>.js.
 * @type {Record<string, {
 *   platform: string, keys: {source: string, success: string, failure: string, hold: string, queue: string},
 *   stage: string, scope: (t: any) => string, identity: (t: any) => string,
 *   epics: null | ((t: any) => {rule: string, children: string}),
 *   blockers: null | {declare: string, release: string},
 *   createHint: string, assignHint: string,
 * }>} */
export const PROVIDERS = {
  asana: {
    platform: "Asana",
    keys: { source: "sourceSectionGid", success: "successSectionGid", failure: "failureSectionGid", hold: "holdSectionGid", queue: "queueSectionGid" },
    stage: "section (gid)",
    scope: (t) => `project ${t.projectGid ?? "?"} (workspace ${t.workspaceGid ?? "?"})`,
    identity: (t) => (t.userGid ? `assignee gid ${t.userGid}` : "assignee gid tracker.userGid (UNSET — nothing fires until set)"),
    epics: (t) => ({
      rule: `a task whose custom type is "${t.epicType ?? "Epic"}" (tracker.epicType; the type must exist on the project)`,
      children: "its direct subtasks that are also members of the project",
    }),
    blockers: { declare: "native task dependencies (POST /tasks/{gid}/addDependencies)", release: "when the blocker task is marked completed (a step with completeTask:true, or a forge merge)" },
    createHint: "POST /tasks with assignee + memberships:[{project, section}] in ONE call (an assignee change alone fires nothing)",
    assignHint: "assignee = our user gid",
  },
  github: {
    platform: "GitHub Issues",
    keys: { source: "sourceLabel", success: "successLabel", failure: "failureLabel", hold: "holdLabel", queue: "queueLabel" },
    stage: "label",
    scope: (t) => `repo ${t.repository ?? (t.owner && t.repo ? `${t.owner}/${t.repo}` : "?")}`,
    identity: (t) => (t.assigneeLogin ? `assignee @${t.assigneeLogin}` : "assignee = the token's own account (`gh api user -q .login`)"),
    epics: (t) => ({
      rule: `an issue typed "${t.epicType ?? "Epic"}" (issue type) OR labelled "${t.epicLabel ?? "epic"}" (tracker.epicType / tracker.epicLabel)`,
      children: "its native sub-issues (NOT task-list checkboxes, NOT 'part of #N' text)",
    }),
    blockers: { declare: "native issue dependencies (blocked by), not body text", release: "when the blocker issue is CLOSED (a step with closeIssue:true, or `Closes #N` in the merged PR) — a merge alone does not close it" },
    createHint: "gh issue create --assignee <login> --label <sourceLabel> (labels are auto-created on boot)",
    assignHint: "any assignee equal to our login counts",
  },
  "github-projects": {
    platform: "GitHub Projects v2",
    keys: { source: "sourceStatus", success: "successStatus", failure: "failureStatus", hold: "holdStatus", queue: "queueStatus" },
    stage: "Status option",
    scope: (t) => `project ${t.project ?? "?"}`,
    identity: (t) => (t.assigneeLogin ? `assignee @${t.assigneeLogin}` : "assignee = the token's own account (GraphQL viewer)"),
    epics: (t) => ({
      rule: `an Issue card on the board typed "${t.epicType ?? "Epic"}" OR labelled "${t.epicLabel ?? "epic"}"`,
      children: "its native sub-issues, each staged by its OWN card's Status (off-board = untracked)",
    }),
    blockers: null,
    createHint: "create the issue assigned to us FIRST, then add it to the board and set Status (an `assigned` event is not handled here)",
    assignHint: "assignee = our login, set before the card exists",
  },
  jira: {
    platform: "Jira",
    keys: { source: "sourceStatus", success: "successStatus", failure: "failureStatus", hold: "holdStatus", queue: "queueStatus" },
    stage: "status",
    scope: (t) => `project ${t.projectKey ?? "?"} on ${t.site ?? t.baseUrl ?? "?"}`,
    identity: (t) => (t.assigneeAccountId ? `assignee accountId ${t.assigneeAccountId}` : "assignee = the token's own account (/rest/api/3/myself)"),
    epics: (t) => ({
      rule: t.epicType ? `an issue of type "${t.epicType}" (tracker.epicType)` : "an issue whose type sits at hierarchyLevel 1 (Epic in company-managed projects)",
      children: "issues whose `parent` is the epic (sub-tasks are ignored)",
    }),
    blockers: null,
    createHint: "create assigned to us; if the create status is not the source status, transition it there afterwards (an assignee change alone fires nothing)",
    assignHint: "assignee = our accountId",
  },
  linear: {
    platform: "Linear",
    keys: { source: "sourceStatus", success: "successStatus", failure: "failureStatus", hold: "holdStatus", queue: "queueStatus" },
    stage: "workflow state",
    scope: (t) => `team ${t.team ?? "?"}`,
    identity: () => "assignee = the token's own account (GraphQL viewer)",
    epics: null,
    blockers: null,
    createHint: "issueCreate with teamId, assigneeId = viewer, stateId = the source state",
    assignHint: "assigneeId = viewer.id",
  },
  local: {
    platform: "local board",
    keys: { source: "sourceStatus", success: "successStatus", failure: "failureStatus", hold: "holdStatus", queue: "queueStatus" },
    stage: "status",
    scope: () => "the local board file",
    identity: () => "no assignee check (everything is ours)",
    epics: null,
    blockers: null,
    createHint: 'agenthook ticket add "<title>" [--body <text>] [--step <id>]',
    assignHint: "none",
  },
};

/**
 * Render the `authoring` topic for one loaded config. Pure.
 * @param {import('./types.js').Config} cfg
 */
export function renderAuthoring(cfg) {
  const p = PROVIDERS[cfg.provider];
  if (!p) return `## authoring\n\nUnknown tracker "${cfg.provider}" — no authoring facts.`;
  const t = /** @type {any} */ (cfg.tracker ?? {});
  const steps = cfg.pipeline ?? [];
  const first = steps.find((s) => !s.manual) ?? steps[0];
  const val = (/** @type {any} */ s, /** @type {string} */ k) => (s?.[k] == null || s[k] === "" ? "—" : String(s[k]));
  const rows = steps.map((s) => `| ${s.id}${s.manual ? " (manual)" : ""} | ${val(s, p.keys.source)} | ${val(s, p.keys.success)} | ${val(s, p.keys.hold)} | ${val(s, p.keys.failure)} | ${val(s, p.keys.queue)} |`);
  const closers = steps.filter((s) => /** @type {any} */ (s).closeIssue || /** @type {any} */ (s).completeTask || s.completeOnMerge).map((s) => s.id);
  const repos = (cfg.repos ?? []).length > 1 ? cfg.repos.map((r) => `${r.id}: ${r.path}${r.default ? " (default)" : ""}`).join("; ") : cfg.repoPath;
  const lines = [
    `## authoring`,
    ``,
    `Profile **${cfg.name}** — tracker **${p.platform}** (\`${cfg.provider}\`), ${p.scope(t)}. Code repo: ${repos}.`,
    `Stages are ${p.stage}s. Trigger word for resuming a held agent: \`${cfg.trigger ?? "@agent"}\`.`,
    ``,
    `### A ticket fires a step only when ALL hold`,
    ``,
    `1. It is **ours**: ${p.identity(t)} (${p.assignHint}). Fail-closed — anything else is ignored.`,
    `2. It sits in the step's **source ${p.stage}** (table below). Create: ${p.createHint}.`,
    `3. It is open${p.blockers ? " and has no open blocker" : ""}.`,
    ``,
    `Easiest: create the item on the board, then \`agenthook run <ref> [stepId]\` (MCP \`run\`) — it assigns us and enters the step's source stage in one move. Verify with \`agenthook watch --ref <ref> --event enqueued,run_start --timeout 60\` (MCP \`events {ref, waitS: 60}\`).`,
    ``,
    `### Steps (\`${p.keys.source}\` …)`,
    ``,
    `| step | source | success → | hold | failure | queue |`,
    `|---|---|---|---|---|---|`,
    ...rows,
    ``,
    `First step for new work: **${first?.id ?? "?"}** (source ${p.stage}: ${val(first, p.keys.source)}).`,
    closers.length ? `Terminal/closing steps: ${closers.join(", ")}.` : `No step closes/completes the item — a person does.`,
    ``,
    `### Epics`,
    ``,
  ];
  if (p.epics) {
    const e = p.epics(t);
    lines.push(`An epic is ${e.rule}. Its tickets are ${e.children}.`, `The epic itself must **NOT** sit in a step's source ${p.stage} and needs no assignee — it is a container, never worked (an epic in a stage only emits \`epic_skipped\`). Only its children carry stages and assignees.`, `Read progress with \`agenthook epics --ref <epic>\` (MCP \`epics {ref}\`); \`readyToClose:true\` means a person should close it.`);
  } else {
    lines.push(`This tracker has **no epic support** in agenthook (\`epics\` returns \`supported:false\`). Group work by naming instead; track each ticket on its own.`);
  }
  lines.push(``, `### Dependencies`, ``);
  if (p.blockers) {
    lines.push(`Declare with ${p.blockers.declare}. A blocked ticket resting in a source ${p.stage} does not fire until every blocker is done; it is released ${p.blockers.release}.`, `Chains: create all tickets, declare blockers, then \`run\` only the unblocked ones.`);
  } else {
    lines.push(`Dependency links are ignored by agenthook on this tracker. Sequence work by hand: keep a dependent ticket OUT of any source ${p.stage} until its blocker is done, then \`run\` it.`);
  }
  return lines.join("\n");
}
