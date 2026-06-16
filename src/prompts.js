// Provider-blind prompt builders. The platform-specific bits (what to call the
// item, how to comment back) come from the adapter's describe() meta, so one
// prompt shape serves Asana, Jira, etc. There is one builder — stepPrompt — and it
// shapes itself per the step's `kind` (triage / implement / change / review).
//
// task: { name, description, url, ref }
// meta: { platform, taskNoun, trigger, commentHowTo }

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
 * @param {{ worktree?: string, branch?: string }} ctx
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
      `  ${meta.commentHowTo}. Do NOT start the comment with "${meta.trigger}".`,
      `- If it is ready, optionally add a short comment enriching scope/acceptance so the coding`,
      `  stage has what it needs.`,
      `- Do NOT move the ${N} yourself. The receiver advances it to the coding queue when you exit`,
      `  cleanly. (P1: a clean exit always advances — it cannot yet hold for an answer.)`,
    ].join("\n");
  }

  if (step.kind === "review") {
    return [
      `You are an INDEPENDENT reviewer for the "${step.id}" stage. Another agent worked this`,
      `${meta.platform} ${N} in the worktree below and opened a draft PR. You did NOT write that`,
      `code and have no memory of it — that independence is the point. Read the diff and report;`,
      `do NOT edit code, push, or move the ${N}. Assume the PR is wrong until the diff proves it right.`,
      ``,
      ...head,
      ``,
      `Find the PR for branch "${ctx.branch}" (\`gh pr list --head ${ctx.branch} --json number,url\`),`,
      `review the diff, and report your findings per the standing instructions above. The receiver`,
      `moves the ${N} to the next stage on a clean exit — do not move it yourself.`,
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
    `- Implement the ${N}, run lint and the relevant tests, and open/update a draft PR.`,
    `- Post a brief status comment back on the ${N}: ${meta.commentHowTo}.`,
    `  Include the branch name and PR number. Do NOT start the comment with "${meta.trigger}".`,
    `- The receiver advances the ${N} to the next stage when you exit cleanly — do not move it yourself.`,
    `- If the ${N} is ambiguous or unsafe to do unattended, do NOT guess: post a comment asking for`,
    `  clarification (do not start it with "${meta.trigger}") and stop.`,
  ].join("\n");
}

