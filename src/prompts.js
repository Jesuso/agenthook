// Provider-blind prompt builders. The platform-specific bits (what to call the
// item, how to comment back) come from the adapter's describe() meta, so one
// prompt shape serves Asana, GitHub, Jira, etc.
//
// task: { name, description, url, ref }
// meta: { platform, taskNoun, trigger, commentHowTo }

/**
 * @param {import('./types.js').Task} task
 * @param {import('./types.js').AdapterMeta} meta
 */
export function implementPrompt(task, meta) {
  const N = meta.taskNoun;
  return [
    `You have been assigned a ${meta.platform} ${N}. Work on it autonomously in this repository.`,
    ``,
    `${meta.platform} ${N}: ${task.name}`,
    `URL: ${task.url}`,
    `Ref: ${task.ref}`,
    ``,
    `Description:`,
    task.description?.trim() || "(no description provided)",
    ``,
    `Instructions:`,
    `- Follow the repository's CLAUDE.md workflow rules exactly.`,
    `- Branch off the latest default branch before making changes.`,
    `- Implement the ${N}, then run lint and the relevant tests.`,
    `- If the work is substantial and complete, open a draft PR.`,
    `- When done, post a brief status comment back on the ${N}: ${meta.commentHowTo}.`,
    `  Include the branch name and PR number. Do NOT start the comment with "${meta.trigger}".`,
    `- If the ${N} is ambiguous or unsafe to do unattended, do NOT guess: post a comment`,
    `  asking for clarification (do not start it with "${meta.trigger}") and stop.`,
  ].join("\n");
}

/**
 * @param {import('./types.js').Task} task
 * @param {string|undefined} changeText
 * @param {import('./types.js').AdapterMeta} meta
 */
export function changePrompt(task, changeText, meta) {
  const N = meta.taskNoun;
  return [
    `A CHANGE has been requested on a ${meta.platform} ${N} you previously worked on.`,
    ``,
    `${meta.platform} ${N}: ${task.name}`,
    `URL: ${task.url}`,
    `Ref: ${task.ref}`,
    ``,
    `Requested change (from a comment):`,
    changeText || "(empty — read the latest comments for context)",
    ``,
    `Instructions:`,
    `- You previously implemented this ${N} on a git branch and opened a PR, but this is a`,
    `  fresh process with no memory of it. Recover the context first: read the ${N}'s existing`,
    `  comments to find the branch name and PR number you created.`,
    `- git fetch, then check out that EXISTING branch (do NOT create a new branch), git pull.`,
    `- Apply the requested change. Follow CLAUDE.md rules.`,
    `- Run lint and the relevant tests.`,
    `- Push to update the EXISTING PR (do not open a new one).`,
    `- Post a brief comment summarizing what changed: ${meta.commentHowTo}.`,
    `  Do NOT start the comment with "${meta.trigger}".`,
    `- If the request is ambiguous or unsafe, post a comment asking for clarification`,
    `  (do not start it with "${meta.trigger}") and stop.`,
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

/**
 * Independent sign-off digest, run as a SEPARATE process after the author agent
 * finishes. The whole value is independence: this process has NO memory of how
 * the code was written, so it does not inherit the author's blind spots. It does
 * not edit code — it explains the PR for a human and surfaces concerns.
 *
 * Output is split across the two channels INSTRUCTIONS.md already defines:
 *   - tracker comment  = product-language sign-off card (no paths/jargon)
 *   - PR comment       = technical concerns with file:line + severity
 *
 * @param {import('./types.js').Task} task
 * @param {import('./types.js').AdapterMeta} meta
 * @param {import('./types.js').Config} cfg
 */
export function digestPrompt(task, meta, cfg) {
  const N = meta.taskNoun;
  const wt = `${cfg.worktreePrefix || "../agents"}/${task.ref}-*`;
  return [
    `You are an INDEPENDENT reviewer. Another agent just implemented a ${meta.platform} ${N}`,
    `and opened a draft PR. You did NOT write that code and have no memory of how it was built —`,
    `that independence is the point. Your job is to make a human's sign-off easy, and to surface`,
    `real concerns the author may have been blind to. Assume the PR is wrong until the diff proves`,
    `it right. You do NOT edit code, run fixers, or push — this is read-and-report only.`,
    ``,
    `${meta.platform} ${N}: ${task.name}`,
    `URL: ${task.url}`,
    `Ref: ${task.ref}`,
    ``,
    `Steps:`,
    `- Locate the author's worktree (glob "${wt}" from the repo root) and read its branch:`,
    `  \`git -C <worktree> branch --show-current\`. Find the PR: \`gh pr list --head <branch>`,
    `  --json number,url\`. If there is no worktree or no PR, the author did not ship — post a`,
    `  plain ${N} comment saying the work looks incomplete (no PR to review) and stop.`,
    `- Run the repository's \`pr-digest\` skill on that branch: \`/pr-digest <branch>\`. It produces`,
    `  the card (Problem / Change / Outcome / Risk tier + the one decision) and an adversarial`,
    `  Concerns pass (file:line + severity) checked against CLAUDE.md's hard rules. Read the diff`,
    `  yourself — do not trust the PR description alone.`,
    ``,
    `Report across the two channels (per INSTRUCTIONS.md — never duplicate technical detail into`,
    `the ${N}):`,
    `- ${meta.platform} ${N} comment (PRODUCT language, the sign-off card): the Problem / Change /`,
    `  Outcome / Risk tier and the single decision the reviewer must make — in plain words, NO file`,
    `  paths, branch names, or jargon. End with a one-line concern tally only, e.g. "⚠️ 1 blocker,`,
    `  2 nits — details in the PR" (or "✅ no concerns found"). ${meta.commentHowTo}.`,
    `  Do NOT start the comment with "${meta.trigger}".`,
    `- PR comment (TECHNICAL): the full Concerns list with file:line + severity tags`,
    `  (🔴 BLOCKER / 🟡 NIT / 🔵 FYI), under a heading like "🤖 Independent pre-review digest".`,
    `  Post with \`gh pr comment <number> --body ...\`. If zero concerns, say so explicitly.`,
    `- Do not change the ${N}'s section/assignee and do not mark it complete — you only comment.`,
  ].join("\n");
}
