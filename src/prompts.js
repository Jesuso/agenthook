// Provider-blind prompt builders. The platform-specific bits (what to call the
// item, how to comment back) come from the adapter's describe() meta, so one
// prompt shape serves Asana, Jira, etc. There is one builder — stepPrompt — and it
// shapes itself per the step's `kind` (triage / implement / change / review).
//
// task: { name, description, url, ref }
// meta: { platform, taskNoun, trigger, commentHowTo }

/**
 * The verdict contract footer, appended to every agent prompt. The agent reports how
 * the step resolved by writing JSON to a file the receiver reads after exit; that
 * decides the section move (advance / hold / changes / fail). A crash (non-zero exit)
 * is always a failure regardless of the file; a clean exit with no file means advance.
 * @param {string|undefined} verdictFile
 * @param {string[]} outcomeLines  per-kind "<outcome>: when to use it" bullets
 */
function verdictFooter(verdictFile, outcomeLines) {
  if (!verdictFile) return "";
  return [
    ``,
    `=== VERDICT (required) ===`,
    `Before you exit, write your verdict as JSON to this exact file:`,
    `  ${verdictFile}`,
    `(also passed to you as the env var $AGENTHOOK_VERDICT_FILE). Schema:`,
    `  { "outcome": "<one of the below>", "target": "<stepId — only for changes>", "reason": "<one short line>" }`,
    `Valid outcomes for THIS stage:`,
    ...outcomeLines,
    `If you exit cleanly without writing the file, the receiver assumes "advance". A`,
    `crash (non-zero exit) is always treated as a failure regardless of the file.`,
  ].join("\n");
}

/**
 * Base prompt for a pipeline step. The receiver has already created the shared
 * worktree (for createsWorktree steps) and launches the agent with cwd = that
 * worktree, so the agent never runs `git worktree add` itself — it works in the
 * branch the system handed it. The step's own instructionsFile is prepended by the
 * dispatcher (standing instructions), so this only states the per-run specifics.
 *
 * @param {import('./types.js').Task} task
 * @param {import('./types.js').AdapterMeta} meta
 * @param {import('./types.js').Step} step
 * @param {{ worktree?: string, branch?: string, verdictFile?: string }} ctx
 */
export function stepPrompt(task, meta, step, ctx) {
  const N = meta.taskNoun;
  const head = [
    `${meta.platform} ${N}: ${task.name}`,
    `URL: ${task.url}`,
    `Ref: ${task.ref}`,
  ];
  if (ctx.worktree) head.push(`Worktree: ${ctx.worktree} (you are already in it; branch "${ctx.branch}")`);

  if (step.kind === "triage") {
    return [
      `You are triaging the "${step.id}" stage of a ${meta.platform} ${N} before any code is written.`,
      `No worktree, no branch, no PR — this is read-and-groom only. Follow the standing instructions`,
      `above (the org's triage rules).`,
      ``,
      ...head,
      ``,
      `Description:`,
      task.description?.trim() || "(no description provided)",
      ``,
      `Do:`,
      `- Assess whether the ${N} is clear, in-scope, and actionable by an unattended agent.`,
      `- If something is missing or ambiguous, post a comment with the specific questions:`,
      `  ${meta.commentHowTo}. Do NOT start the comment with "${meta.trigger}". Then set outcome "hold".`,
      `- If it is ready, optionally add a short comment enriching scope/acceptance so the coding`,
      `  stage has what it needs, then set outcome "advance".`,
      `- Do NOT move the ${N} between sections yourself — the receiver moves it per your verdict below.`,
      verdictFooter(ctx.verdictFile, [
        `- "advance": clear, in-scope, actionable — hand it to the coding queue.`,
        `- "hold": you posted a question and need a human answer before coding can start (the ${N}`,
        `  parks in a holding lane until a human replies and re-files it).`,
        `- "fail": not a code task, out of scope, or unspecifiable — route it out for a human.`,
      ]),
    ].join("\n");
  }

  if (step.kind === "review") {
    return [
      `You are an INDEPENDENT reviewer for the "${step.id}" stage. Another agent worked this`,
      `${meta.platform} ${N} in the worktree below and opened a draft PR. You did NOT write that`,
      `code and have no memory of it — that independence is the point. Read the diff and report;`,
      `do NOT edit code or push, and do NOT move the ${N} between sections. Assume the PR is wrong`,
      `until the diff proves it right.`,
      ``,
      ...head,
      ``,
      `Find the PR for branch "${ctx.branch}" (\`gh pr list --head ${ctx.branch} --json number,url\`),`,
      `review the diff, and report your findings per the standing instructions above.`,
      verdictFooter(ctx.verdictFile, [
        `- "advance": the diff is correct and safe — move it on for approval.`,
        `- "changes": the diff needs rework — leave your findings ON THE PR (\`gh pr review\`/\`gh pr comment\`)`,
        `  so the coding stage sees them, then bounce it back. The worktree and PR are kept; the coding`,
        `  stage re-fires on the SAME branch. (Default target is the previous stage; set "target" to`,
        `  override.)`,
        `- "fail": fundamentally broken/unsafe, or you cannot review (no PR, gh auth failed) — route`,
        `  it out for a human.`,
      ]),
    ].join("\n");
  }

  // implement / change share one shape: do the work in the handed-over worktree.
  return [
    `You are working the "${step.id}" stage of a ${meta.platform} ${N}. Do the work autonomously`,
    `in the worktree below, following the standing instructions above and the repo's CLAUDE.md.`,
    ``,
    ...head,
    ``,
    `Description:`,
    task.description?.trim() || "(no description provided)",
    ``,
    `Instructions:`,
    `- Work in the existing worktree/branch you were given — do NOT create a new worktree or branch.`,
    `- If a draft PR already exists for this branch, this is a REWORK pass: read the review feedback`,
    `  on the PR first (\`gh pr view --comments\`, \`gh pr review list\`) and address it, rather than`,
    `  starting over.`,
    `- Implement the ${N}, run lint and the relevant tests, and open/update a draft PR.`,
    `- Post a brief status comment back on the ${N}: ${meta.commentHowTo}.`,
    `  Include the branch name and PR number. Do NOT start the comment with "${meta.trigger}".`,
    `- Do NOT move the ${N} between sections yourself — the receiver moves it per your verdict below.`,
    verdictFooter(ctx.verdictFile, [
      `- "advance": the work is done and the draft PR is open and green — hand it to review.`,
      `- "hold": you are blocked on a human answer (the ${N} is ambiguous or unsafe to do unattended).`,
      `  Post the question as a comment (no "${meta.trigger}" prefix) first; the ${N} parks until a human replies.`,
      `- "fail": you could not complete the work and it needs a human to step in.`,
    ]),
  ].join("\n");
}
