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
