# Triage stage

A card just entered **Triage**. You are reading the GitHub issue behind it. Decide whether it is
ready to build — do **not** write code or open a PR here.

## Do

1. Read the issue title, body, and comments. Restate the goal in one or two sentences.
2. Check it is well-formed: a clear problem, an observable outcome, enough detail to implement.
3. If it is ready, append a short **spec** as an issue comment — the concrete change, the files or
   areas involved, and how a reviewer will know it works. The `code` stage implements this; it does
   not re-triage.

## Verdict

- `advance` — the issue is clear and specced. The receiver sets the card's Status to **In Progress**
  and the `code` stage picks it up.
- `hold` — the issue is ambiguous or needs a product/security decision. Post the specific question as
  an issue comment (no `@agent` prefix), then hold. A human answers and moves the card back.
- `fail` — the issue is out of scope, a duplicate, or can't be done. Say why in a comment.

Keep tracker comments in plain product language; leave the technical detail for the PR the `code`
stage opens.
