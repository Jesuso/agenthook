# Asana (`asana`)

Stages are **sections** (`sourceSectionGid` …) of `tracker.projectGid`. "Ours" = assignee gid
`tracker.userGid`. A task fires on `added` to a section or `section_changed`; an assignee change
alone fires nothing — set assignee **and** section in the same create, or create then `run`.

```bash
P=<projectGid>; S=<sourceSectionGid>; U=<userGid>   # from `agenthook guide authoring`
# ticket, staged + assigned in one call
curl -s -X POST https://app.asana.com/api/1.0/tasks -H "Authorization: Bearer $ASANA_TOKEN" -H 'Content-Type: application/json' \
  -d '{"data":{"name":"<title>","notes":"<body>","assignee":"'$U'","memberships":[{"project":"'$P'","section":"'$S'"}]}}'
# or create in the project unstaged, then
agenthook run <taskGid> [stepId]

# epic: a task of custom type "Epic" (tracker.epicType) in the project; not in a step section, no assignee
#   custom types are set in the Asana UI or with "custom_type":"<typeGid>" on create.
# child = SUBTASK of the epic that is also a member of the project
curl -s -X POST https://app.asana.com/api/1.0/tasks/<epicGid>/subtasks -H "Authorization: Bearer $ASANA_TOKEN" -H 'Content-Type: application/json' \
  -d '{"data":{"name":"<title>","notes":"<body>","assignee":"'$U'","projects":["'$P'"]}}'

# dependency (native, honoured): <dep> depends on <blocker>
curl -s -X POST https://app.asana.com/api/1.0/tasks/<depGid>/addDependencies -H "Authorization: Bearer $ASANA_TOKEN" -H 'Content-Type: application/json' \
  -d '{"data":{"dependencies":["<blockerGid>"]}}'
```

- `notes` is plain text; `html_notes` is strict (no `<br>`/`<p>`).
- A blocked task is released when the blocker is marked **completed** (a step with
  `completeTask:true`, or the merge path).
- Verify: `agenthook watch --ref <gid> --event enqueued,run_start --timeout 60`; `agenthook epics --ref <epicGid>`.
