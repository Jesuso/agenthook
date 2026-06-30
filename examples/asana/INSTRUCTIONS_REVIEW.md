# Standing instructions — `review` step

These rules prepend to every task that enters the **Awaiting review** section. The PR from the
`code` step is on the task; review it. See `INSTRUCTIONS.example.md` (repo root) for the full
standing-rules template and tune it to your repo.

You review the draft PR (you run in the same worktree the `code` step used):

- Check correctness, scope, and that the repo's lint + tests pass. Leave findings as PR comments.
- Clean and correct: `advance` — the receiver moves the task to **Done** (the terminal `done` step
  drains the worktree). A human merges.
- Fixable issues: `changes` (target `code`) — bounces back to the `code` step on the same branch/PR
  (capped by `maxAttempts`).
- Blocked / needs a human: `fail` or `hold`.

Write your verdict JSON to `$AGENTHOOK_VERDICT_FILE`:
`{"outcome":"advance|changes|hold|fail","target":"code","reason":"..."}` (`target` only for
`changes`). Never move the task yourself.
