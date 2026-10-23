# Linear (`linear`)

Stages are **workflow state names** of `tracker.team` (`sourceStatus` …, case-insensitive).
"Ours" = the token's `viewer.id`. Fires on issue `create` or an `update` whose state changed.

```graphql
mutation {
  issueCreate(input: {
    teamId: "<teamId>", title: "<title>", description: "<body markdown>",
    assigneeId: "<viewerId>", stateId: "<source state id>"
  }) { success issue { id identifier } }
}
```

`query { viewer { id } team(id:"<teamId>") { states { nodes { id name } } } }` gives the ids.
Or create assigned and unstaged, then `agenthook run <identifier> [stepId]`.

- **No epic support** in agenthook for Linear today (`epics` → `supported:false`). Projects,
  cycles and parent issues are not read; group by title prefix and track tickets individually.
- Dependencies (`blockedBy` relations) are **not** honoured. Keep dependents out of source
  states and `run` them later.
- Verify: `agenthook watch --ref <identifier> --event enqueued,run_start --timeout 60`.
