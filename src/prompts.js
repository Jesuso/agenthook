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
 * @param {string[]} [pathsLines]  overlapGuard only: how to fill the optional `paths` field
 */
function verdictFooter(verdictFile, outcomeLines, pathsLines = []) {
  if (!verdictFile) return "";
  return [
    ``,
    `=== VERDICT (required) ===`,
    `Before you exit, write your verdict as JSON to this exact file:`,
    `  ${verdictFile}`,
    `(also passed to you as the env var $AGENTHOOK_VERDICT_FILE). Schema:`,
    `  { "outcome": "<one of the below>", "target": "<stepId — only for changes>", "reason": "<one short line>", "findings": "<optional, changes only: full Markdown review findings>" }`,
    ...pathsLines,
    `Valid outcomes for THIS stage:`,
    ...outcomeLines,
    `If you exit cleanly without writing the file, the receiver assumes "advance". A`,
    `crash (non-zero exit) is always treated as a failure regardless of the file.`,
  ].join("\n");
}

/**
 * The owner's reply that resumed a held step (an `@agent …` comment on the item),
 * as a delimited block. Empty when this run wasn't a resume, so the prompt is unchanged.
 * @param {string|undefined} comment
 * @param {import('./types.js').AdapterMeta} meta
 * @returns {string[]}
 */
function resumeSection(comment, meta) {
  if (!comment) return [];
  return [
    ``,
    `=== HUMAN REPLY (resume) ===`,
    `An earlier run of this stage ended with "hold" and asked the owner a question. This is the`,
    `owner's answer (their "${meta.trigger}" comment on the ${meta.taskNoun}). Use it and carry on:`,
    ``,
    comment.trim(),
    `=== END HUMAN REPLY ===`,
  ];
}

/**
 * The overlapGuard `paths` field, documented only when the guard is on. A step with no
 * worktree (triage) PREDICTS the files; a worktree step reports the files it TOUCHED.
 * @param {boolean|undefined} overlapGuard @param {boolean} hasWorktree
 * @returns {string[]}
 */
function pathsLines(overlapGuard, hasWorktree) {
  if (!overlapGuard) return [];
  return [
    `Also add an optional "paths": ["<repo-relative file>", "<dir/>"] field (a trailing "/" marks a directory):`,
    hasWorktree
      ? `  list every file this change TOUCHED (e.g. \`git diff --name-only <base>...HEAD\`). The receiver holds sibling`
      : `  list the files you PREDICT the change will touch. The receiver holds sibling`,
    `  tasks whose files overlap until this one leaves the pipeline, so be specific and complete.`,
  ];
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
 * @param {{ worktree?: string, branch?: string, verdictFile?: string, findings?: { text: string, fromStep: string }, resumeComment?: string, overlapGuard?: boolean, repo?: { id: string, path: string } }} ctx
 *   `repo` is passed only for multi-repo profiles — it names the routed checkout so the agent can report a mis-route
 */
export function stepPrompt(task, meta, step, ctx) {
  const N = meta.taskNoun;
  // Trackers whose workflow doesn't revolve around a PR (the local/offline tracker):
  // the worktree DIFF is the deliverable, review reads it with `git diff`, no `gh pr`.
  const usesPR = meta.usesPR !== false;
  const head = [
    `${meta.platform} ${N}: ${task.name}`,
    `URL: ${task.url}`,
    `Ref: ${task.ref}`,
  ];
  if (ctx.repo) head.push(`Repo: ${ctx.repo.id} (${ctx.repo.path})`);
  if (ctx.worktree) head.push(`Worktree: ${ctx.worktree} (you are already in it; branch "${ctx.branch}")`);
  const resume = resumeSection(ctx.resumeComment, meta);
  const paths = pathsLines(ctx.overlapGuard, !!ctx.worktree);

  // Held tasks re-enter with only the body; the human's answer lives in the comments.
  const readCommentsLine = meta.readCommentsHowTo
    ? [
        `- This ${N} may have been held before. FIRST read its newest comments (${meta.readCommentsHowTo}) — a human's`,
        `  answer to an earlier question lives there, not in the description. Treat those answers as decisions;`,
        `  do not re-ask a question that has been answered, and do not hold again on it.`,
      ]
    : [];

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
      ...readCommentsLine,
      `- Assess whether the ${N} is clear, in-scope, and actionable by an unattended agent.`,
      `- If something is missing or ambiguous, post a comment with the specific questions:`,
      `  ${meta.commentHowTo}. Do NOT start the comment with "${meta.trigger}". Then set outcome "hold".`,
      `- If it is ready, optionally add a short comment enriching scope/acceptance so the coding`,
      `  stage has what it needs, then set outcome "advance".`,
      `- Do NOT move the ${N} between sections yourself — the receiver moves it per your verdict below.`,
      ...resume,
      verdictFooter(ctx.verdictFile, [
        `- "advance": clear, in-scope, actionable — hand it to the coding queue.`,
        `- "hold": you posted a question and need a human answer before coding can start (the ${N}`,
        `  parks in a holding lane; the owner's "${meta.trigger} …" reply comment resumes this stage`,
        `  with that reply in your prompt).`,
        `- "fail": not a code task, out of scope, or unspecifiable — route it out for a human.`,
      ], paths),
    ].join("\n");
  }

  if (step.kind === "review") {
    const artifact = usesPR ? "opened a draft PR" : "left the work as uncommitted/committed changes in the worktree";
    const findDiff = usesPR
      ? `Find the PR for branch "${ctx.branch}" (\`gh pr list --head ${ctx.branch} --json number,url\`),\nreview the diff, and report your findings per the standing instructions above.`
      : `Review the change with \`git -C ${ctx.worktree || "<worktree>"} diff\` (and \`git diff --stat\`) and run the\nrelevant tests, then report your findings per the standing instructions above. There is NO PR — do\nnot run any \`gh\` command.`;
    const changesLine = usesPR
      ? `- "changes": the diff needs rework — put the FULL findings (Markdown) in the verdict \`findings\` field — the receiver hands\n  them verbatim to the coding stage — and also post them on the PR (\`gh pr comment\`), then bounce it back. The worktree and PR are kept; the coding\n  stage re-fires on the SAME branch. (Default target is the previous stage; set "target" to override.)`
      : `- "changes": the diff needs rework — put the FULL findings (Markdown) in the verdict \`findings\` field (the receiver hands\n  them verbatim to the coding stage), then bounce it back.\n  The worktree is kept; the coding stage re-fires on the SAME branch. (Default target is the previous\n  stage; set "target" to override.)`;
    const failLine = usesPR
      ? `- "fail": fundamentally broken/unsafe, or you cannot review (no PR, gh auth failed) — route it out for a human.`
      : `- "fail": fundamentally broken/unsafe, or you cannot review the diff — route it out for a human.`;
    return [
      `You are an INDEPENDENT reviewer for the "${step.id}" stage. Another agent worked this`,
      `${meta.platform} ${N} in the worktree below and ${artifact}. You did NOT write that`,
      `code and have no memory of it — that independence is the point. Read the diff and report;`,
      `do NOT edit code or push, and do NOT move the ${N} between sections. Assume the change is wrong`,
      `until the diff proves it right.`,
      ``,
      ...head,
      ``,
      findDiff,
      ...resume,
      verdictFooter(ctx.verdictFile, [
        `- "advance": the diff is correct and safe — move it on for approval.`,
        changesLine,
        failLine,
      ], paths),
    ].join("\n");
  }

  // implement / change share one shape: do the work in the handed-over worktree.
  const reworkLine = usesPR
    ? `- If a draft PR already exists for this branch, this is a REWORK pass: read the review feedback\n  first (findings passed in this ticket come first; else \`gh pr view <branch> --json reviews,comments\`\n  and \`gh api repos/{owner}/{repo}/pulls/<pr>/comments\` for inline comments) and address it, rather than starting over.`
    : `- If this branch already has commits from an earlier pass, this is a REWORK pass: read the review\n  findings (passed in this ticket / prior verdict) and address them, rather than starting over.`;
  const deliverLine = usesPR
    ? `- Implement the ${N}, run lint and the relevant tests, and open/update a draft PR.`
    : `- Implement the ${N} and run lint and the relevant tests. The worktree branch (its DIFF) IS the\n  deliverable — do NOT open a PR, push, or run any \`gh\` command; commit your work on the branch.`;
  const commentLine = usesPR
    ? `- Post a brief status comment back on the ${N}: ${meta.commentHowTo}.\n  Include the branch name and PR number. Do NOT start the comment with "${meta.trigger}".`
    : `- Do NOT post comments anywhere — put any status note in the verdict \`reason\`.`;
  const advanceLine = usesPR
    ? `- "advance": the work is done and the draft PR is open and green — hand it to review.`
    : `- "advance": the work is done, committed on the branch, and the relevant tests pass — hand it to review.`;
  return [
    `You are working the "${step.id}" stage of a ${meta.platform} ${N}. Do the work autonomously`,
    `in the worktree below, following the standing instructions above and the repo's CLAUDE.md.`,
    ``,
    ...head,
    ``,
    `Description:`,
    task.description?.trim() || "(no description provided)",
    ...(ctx.findings
      ? [``, `Review findings from the "${ctx.findings.fromStep}" stage (address every point):`, ctx.findings.text]
      : []),
    ``,
    `Instructions:`,
    ...readCommentsLine,
    `- Work in the existing worktree/branch you were given — do NOT create a new worktree or branch.`,
    reworkLine,
    deliverLine,
    commentLine,
    `- Do NOT move the ${N} between sections yourself — the receiver moves it per your verdict below.`,
    ...resume,
    verdictFooter(ctx.verdictFile, [
      advanceLine,
      `- "hold": you are blocked on a human answer (the ${N} is ambiguous or unsafe to do unattended).`,
      `- "fail": you could not complete the work and it needs a human to step in.`,
    ], paths),
  ].join("\n");
}
