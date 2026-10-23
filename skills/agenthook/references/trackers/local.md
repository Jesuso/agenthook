# Local board (`local`)

No tracker account, no webhooks: `agenthook init --local` keeps a board file in the profile's
state dir and the receiver fires steps in-process.

```bash
agenthook ticket add "<title>" --body "<text>"        # first non-manual step; fires at once if the receiver is up
agenthook ticket add "<title>" --file body.md --step code
agenthook ticket ls [--json]
```

Receiver down → the ticket rests until `agenthook reconcile`. No epics, no dependencies, no
assignee check (everything is ours).
