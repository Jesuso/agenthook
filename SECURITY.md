# Security Policy

## Reporting a vulnerability

Email **the maintainers (private GitHub reporting)** with details and a proof of concept if you have one. Please do
**not** open a public issue for anything exploitable. Expect an acknowledgement within a few days;
once a fix ships, we're happy to credit you unless you'd rather stay anonymous.

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
- **Not multi-tenant.** One profile = one trusted operator on one trusted host. agenthook does not
  isolate users from each other and is not designed to be exposed as a shared service.

### Hardening checklist

- Keep `fullAuto: false` unless you specifically need it, and never on a shared host.
- When you do enable `fullAuto`, run the agent in a container/VM with **only the repo mounted**.
- Scope the tracker API token to a single project; rotate it if it may have leaked.
- Pair a stable ingress with a reserved domain over an ephemeral public tunnel; stop the tunnel
  when idle.
- Keep the signing secret in `~/.agenthook/<name>/secrets.json` (0600) — never commit it.

Full posture and the request-flow trust boundaries are in
[docs/architecture.md#security-posture](docs/architecture.md#security-posture).
