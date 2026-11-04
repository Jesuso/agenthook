# Standing instructions — `review` step

These rules prepend to every task that enters the **Awaiting review** section. The PR from the
`code` step is on the task; review it. See `INSTRUCTIONS.example.md` (repo root) for the full
standing-rules template and tune it to your repo.

You review the draft PR (you run in the same worktree the `code` step used):

- Check correctness, scope, and that the repo's lint + tests pass. Leave findings as PR comments.
- Check the PR body contains a line linking the task, exactly `**Asana:** <task permalink>`. A
  missing link is a `changes` finding — never `advance` a PR without it.
- For each new or changed test, name the production change that would make it fail. A test that
  can't fail when the change it claims to cover is reverted is a BLOCKING finding, never a minor
  note.
- Check every acceptance criterion in the task. If any is unmet and the code step can fix it, use
  `changes` and name the criterion. If only a human can satisfy it (prod access, credentials, a
  measurement you can't run), use `hold` and name the criterion and who can satisfy it.
- Clean and correct, with every acceptance criterion met: `advance` — the receiver moves the task to
  **Done** (the terminal `done` step drains the worktree). A human merges.
- Everything met except criteria that can only be verified **after the change is deployed** (a
  production metric, a log line, a live integration), at risk low or medium: `advance` with
  `"summary":{"tier":"low"}` and `"postDeploy":["<what to check after deploy, and where>"]`, and
  list the checks in your task comment. The receiver records them for someone to verify after the
  deploy. At high risk (or no tier), `hold` instead. The receiver also holds it if you don't.
- Fixable issues: `changes` (target `code`) — bounces back to the `code` step on the same branch/PR
  (capped by `maxAttempts`).
- Blocked / needs a human: `fail` or `hold`.

Write your verdict JSON to `$AGENTHOOK_VERDICT_FILE`:
`{"outcome":"advance|changes|hold|fail","target":"code","reason":"..."}` (`target` only for
`changes`; `summary.tier` + `postDeploy` only on an `advance` with post-deploy checks). Never move the task yourself.

## Re-entry after a hold

On (re-)entry, read the task comments FIRST. A human may have answered an earlier question there, not in the task description. Treat those answers as decisions: do not re-ask a question that has been answered, and if the owner marks decisions as final, do not `hold` on the same questions again. Keep questions in product language.
