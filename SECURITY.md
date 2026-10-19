# Security Policy

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/Jesuso/agenthook/security/advisories/new)
to send details and a proof of concept if you have one — it opens a confidential thread with the
maintainers, nothing is public. Please do **not** open a public issue for anything exploitable.
Expect an acknowledgement within a few days; once a fix ships, we're happy to credit you unless
you'd rather stay anonymous.

## Supported versions

agenthook is pre-1.0. Security fixes land on the latest published `0.x` release; there is no
backport guarantee for older versions. Pin a version and watch releases.

## Threat model — read before you deploy

agenthook is a webhook receiver that **executes a coding agent on your host in response to tracker
events**. The trust boundary is small and worth understanding:

- **A verified webhook runs code.** With `fullAuto: true` the agent runs
  `claude -p --dangerously-skip-permissions` — *unsandboxed* command execution on the host. The
  only thing standing between an attacker and that execution is the HMAC signature check and a
  non-guessable public URL. `fullAuto` is **off by default**; the safe default prompts for
  permission on each privileged action.
- **The URL is a secret.** An ingress URL that leaks (logs, screenshots, a proxy) plus a leaked
  signing secret is full code execution. Treat the public URL and every webhook signing secret as
  credentials.
- **The API token is powerful.** The tracker token can read and move work items. Scope it to the
  one project/board that drives the pipeline; don't reuse a personal admin token.
- **Assignee scoping is fail-closed.** The receiver must never act on items not assigned to the
  configured account. If you find a path where it acts on an unassigned item, that's a
  vulnerability — report it.
- **The agent interface is operator authority.** `agenthook mcp` (and the control socket behind it)
  can start, cancel, pause and resume work and answer held tickets — the same authority as
  `agenthook run` / replying `@agent` as the token owner. It is reachable only by the Unix user that
  owns the receiver (`control.sock` is 0600; the MCP server is a stdio child of your agent, no
  network listener). When you hand those tools to an LLM, you delegate that authority to whatever
  text the LLM reads (ticket bodies, agent logs, tracker errors). Register it with `--read-only`
  for any agent that reads untrusted content; every write is audited to
  `~/.agenthook/<name>/control-audit.jsonl`. See [docs/mcp.md](docs/mcp.md#safety).
- **Not multi-tenant.** One profile = one trusted operator on one trusted host. agenthook does not
  isolate users from each other and is not designed to be exposed as a shared service.
- **Ticket and comment text is untrusted input to the agent.** See
  [Prompt injection](#prompt-injection) below.

### Hardening checklist

- Keep `fullAuto: false` unless you specifically need it, and never on a shared host.
- When you do enable `fullAuto`, run it in the [sandboxed container](docs/sandbox.md) with **only
  the repo mounted** — the blessed path that confines code execution off the host.
- Scope the tracker API token to a single project; rotate it if it may have leaked.
- Pair a stable ingress with a reserved domain over an ephemeral public tunnel; stop the tunnel
  when idle.
- Keep the signing secret in `~/.agenthook/<name>/secrets.json` (0600) — never commit it.
- Use a [GitHub App](docs/github-app.md) so agent runs get scoped, expiring tokens instead of your
  personal token ([agent run tokens](docs/github-app.md#agent-run-tokens)). That's a hard boundary
  only with `sandbox` on; on a bare host the agent can still read your own `gh` login and SSH keys.
- Don't widen `agentEnvPassthrough` to `"*"`: list only the variables your agents need, so the
  ingress authtoken, App key and webhook secrets stay out of the agent's environment
  ([docs/agents.md#agent-environment](docs/agents.md#agent-environment)).

Full posture and the request-flow trust boundaries are in
[docs/architecture.md#security-posture](docs/architecture.md#security-posture).

## Prompt injection

**Who writes what the agent reads.** Ticket titles and descriptions come from whoever can file
or edit the item — on a public repo, a stranger. Comments and PR comments/reviews come from
whoever can comment. CI log tails reach the agent only indirectly, as part of a PR comment, so
whoever controls the PR head controls them. Review findings are written by an agent that already
read all of the above, so they're derived from hostile input even though the review agent itself
is ours. The one trusted-author input is the `@agent` resume reply, gated to the token owner by a
strict author check — but anything that reply quotes from someone else is still data, not
instruction.

**What fencing does.** Every step prompt opens with a standing rule and wraps tracker text (ticket
title, description, review findings, the owner's resume reply) in fences tagged with a nonce that
is fresh per prompt: `<<<UNTRUSTED <LABEL> <nonce>>> … <<<END UNTRUSTED <LABEL> <nonce>>>`. The
fenced text is neutralized first — every run of 3+ `<` is shortened — so the content can never
forge a closing delimiter with the right nonce, whatever it tries to put inside the block. The
standing rule tells the agent that fenced text, and anything it fetches itself (comments, PR
threads, web pages), is data to understand what to build, never an instruction, and that if it
finds an embedded instruction it must stop, set outcome `hold` or `fail`, and quote the suspicious
text in the verdict `reason` rather than follow it.

**What fencing does NOT guarantee.** This is a mitigation, not a boundary. A model can still be
talked into something despite the rule, and text the agent fetches itself at tool-call time
(ticket comments via `gh`, PR threads, web pages, files in the repo) is covered only by the
standing rule, not by a fence — a fence can't wrap text that never passes through the prompt
string. The real boundaries are what the agent *can do*: running it in the
[sandboxed container](docs/sandbox.md) confines code execution off the host; a stripped agent
environment, an egress allowlist, and short-lived scoped tracker tokens are tracked separately
(issues #470, #473, #474) and land independently of this mitigation.

**Recommendations.**
- Don't route a stranger's issue into a `fullAuto` pipeline without the sandbox.
- On a public repo, gate intake behind a human: only the owner adds the source label/assignment,
  and triage runs without `fullAuto`.
- Register `agenthook mcp --read-only` for any LLM that reads ticket text — see
  [docs/mcp.md#safety](docs/mcp.md#safety).
- If a run looks odd, read its `.prompt.md` sidecar — it records the exact prompt bytes, nonce
  included, that the agent saw.
