# Jira (`jira`)

Stages are **statuses** (`sourceStatus` …) in `tracker.projectKey`. "Ours" = the token's
accountId (`/myself`) or `tracker.assigneeAccountId`. An `issue_updated` fires only on a
**status change**; an assignee change alone fires nothing.

```bash
SITE=https://<site>.atlassian.net; AUTH="$JIRA_EMAIL:$JIRA_TOKEN"
# ticket (lands in the project's create status; move it after if that is not the source status)
curl -s -u "$AUTH" -X POST $SITE/rest/api/3/issue -H 'Content-Type: application/json' -d '{"fields":{
  "project":{"key":"<KEY>"},"issuetype":{"name":"Task"},"summary":"<title>",
  "assignee":{"accountId":"<ourAccountId>"},
  "description":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"<body>"}]}]}}}'
# simplest: let agenthook assign + transition
agenthook run <KEY-123> [stepId]
# manual transition: list ids, then move
curl -s -u "$AUTH" $SITE/rest/api/3/issue/<KEY-123>/transitions
curl -s -u "$AUTH" -X POST $SITE/rest/api/3/issue/<KEY-123>/transitions -H 'Content-Type: application/json' -d '{"transition":{"id":"<id>"}}'

# epic: issue type at hierarchy level 1 ("Epic"; or tracker.epicType by name). Not in a source status, no assignee.
# child: any issue with parent = the epic (sub-tasks are ignored)
... "fields":{"parent":{"key":"<EPIC-KEY>"}, ...}
```

- Issue links ("blocks") are **not** honoured by agenthook. Keep dependents out of source
  statuses and `run` them when the blocker lands.
- Verify: `agenthook watch --ref <KEY-123> --event enqueued,run_start --timeout 60`; `agenthook epics --ref <EPIC-KEY>`.
