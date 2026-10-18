# GitHub App auth

By default the `github` and `github-projects` trackers and the `github` forge authenticate with one
personal token (`tracker.token` / `forge.token`). That token is broad (`repo`, `admin:repo_hook`,
`admin:org_hook`) and belongs to one person. A **GitHub App** is the alternative:

- Its permissions are narrow and per-repo (or per-org), and you pick them.
- agenthook mints **installation tokens** from the App's private key. Each one expires after an
  hour, and agenthook refreshes it 5 minutes before that. No long-lived token sits in `.env`, only
  the App's key.

A token-only config keeps working exactly as before. `auth` is opt-in, per block.

> **A GitHub App does not give user-owned Projects v2 boards a webhook.** GitHub sends
> `projects_v2_item` (and `projects_v2`) only for **organization-level** projects, so a
> user-owned board has no hook path with a token *or* an App. Move the board under an
> organization. See [GitHub Projects setup](github-projects-setup.md#3-the-webhook-org-auto-create-with-a-manual-fallback).

## 1. Create the App

Go to **Settings → Developer settings → GitHub Apps → New GitHub App**. Use your user settings for
a personal repo, or the org's settings for an org.

- **Name / Homepage URL:** anything.
- **Webhook:** **uncheck "Active".** agenthook does not use the App's own webhook (see
  [why](#why-the-apps-own-webhook-stays-inactive)).
- **Permissions:** the minimal set for what you run, below.
- **Where can this GitHub App be installed?** "Only on this account" is enough.

### Minimal permissions

**`github` tracker** (labels drive the pipeline), under *Repository permissions*:

| Permission | Access | Used for |
|---|---|---|
| Metadata | Read | required by GitHub |
| Issues | Read & write | labels, assignees, sub-issues / parent, dependencies, comments |
| Webhooks | Read & write | creating the repo hook agenthook listens on |

**`github-projects` tracker** (a Projects v2 board's Status drives the pipeline). It works for
**org-owned projects only**.

| Permission | Access | Used for |
|---|---|---|
| Organization → Projects | Read & write | reading the board, setting Status, adding cards |
| Organization → Webhooks | Read & write | creating the org hook agenthook listens on |
| Repository → Metadata | Read | required by GitHub |
| Repository → Issues | Read & write | assigning, reading the issue, comments |

**`github` forge** (merged PRs and red/green CI), under *Repository permissions*:

| Permission | Access | Used for |
|---|---|---|
| Metadata | Read | required by GitHub |
| Pull requests | Read | PR heads, state, the `prs` roll-up |
| Checks | Read | the CI roll-up |
| Actions | Read & write | run / job logs, and `rerun-failed-jobs` |
| Issues | Write | PR comments (posted via `/issues/{n}/comments`) |
| Webhooks | Read & write | creating the repo hook agenthook listens on |

**Agent runs** ([agent run tokens](#agent-run-tokens), on by default under App auth), under
*Repository permissions*:

| Permission | Access | Used for |
|---|---|---|
| Metadata | Read | required by GitHub |
| Contents | Read & write | the agent's `git push` |
| Pull requests | Read & write | `gh pr create`, `gh pr view`, review comments |
| Issues | Read & write | `gh issue comment`, `gh issue view` |
| Checks | Read | the agent reading its PR's CI |
| Commit statuses | Read | the same |
| Actions | Read | CI run logs |

A run token can only hold permissions the installation already has (GitHub answers 422
otherwise), so the installation must grant at least these. Do **not** grant *Workflows*: without it
no agent can push a change to `.github/workflows/`.

If the tracker and the forge use the same App, grant the union of the lists.

## 2. Generate a private key and install the App

1. On the App's page, **Private keys → Generate a private key**. GitHub downloads a `.pem` file.
2. Note the **App ID** at the top of the same page.
3. **Install App**, then pick the repo (or the org, for `github-projects`).
4. After installing, the browser lands on `…/settings/installations/<id>`. That number is the
   **installation id**. You can find it again later under Settings → Applications → Installed
   GitHub Apps → *Configure*.

## 3. Configure agenthook

Put the key in `.env`. A PEM has newlines and a `.env` value is one line, so write the newlines as
literal `\n`. agenthook turns them back into newlines.

```bash
# .env
GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----\n
```

```jsonc
"tracker": {
  "type": "github",
  "repository": "your-org/your-repo",
  "auth": {
    "type": "app",
    "appId": "123456",
    "installationId": "78901234",
    "privateKey": "${GITHUB_APP_PRIVATE_KEY}"
  },
  "assigneeLogin": "your-github-login",   // REQUIRED with an App — see below
  "pipeline": [ /* … */ ]
},
"forge": {
  "type": "github",
  "repository": "your-org/your-repo",
  "auth": { "type": "app", "appId": "123456", "installationId": "78901234", "privateKey": "${GITHUB_APP_PRIVATE_KEY}" }
}
```

Instead of `privateKey` you can set `"privateKeyPath": "./my-app.private-key.pem"`. The path is
relative to the config file. Set exactly one of the two.

`agenthook init` asks "Personal token / GitHub App" for the GitHub trackers. For an App it asks for
the App ID, the installation id, the key (an env var name or a `.pem` path) and your login, then
prints the permission list. A GitHub forge reuses the tracker's App auth. With an App, `init` lists
repos from the installation (`GET /installation/repositories`). For `github-projects` you type the
board as `org/number`.

A tracker and a forge on the same installation share one cached installation token.

## The human identity: `assigneeLogin`

An installation token acts as the App's bot (`your-app[bot]`), not as a person:

- `GET /user` returns 403.
- GraphQL `viewer` returns the bot.

So with an App, agenthook **never derives "us" from the token**. `tracker.assigneeLogin` is required
and is the identity everywhere:

- **Scoping.** Only issues assigned to that login are acted on. This stays fail-closed.
- **The `@agent` resume.** It counts only when the comment's author is exactly that login. A comment
  from the App's `[bot]` login or anyone else is ignored.
- **`agenthook run`.** It assigns the issue to that login. On `github-projects` the login's user id
  comes from `user(login:)`, never `viewer`.

A config with `auth.type: "app"` and no `assigneeLogin` fails validation. It never falls back to
`/user` or `viewer`.

## Why the App's own webhook stays inactive

agenthook keeps creating the same repo/org hooks it creates with a token, now using the installation
token:

- the `github` tracker hook on `/github/`;
- the `github-projects` org hook on `/github-projects/`;
- the forge hook on `/forge`.

That's why the App needs **Webhooks: Read & write**. A GitHub App has a **single** webhook URL, so it
can't serve the tracker path and the forge path at once. It also delivers no event those hooks lack.
If hook creation is refused (403/404), agenthook prints the same copy-pasteable manual setup as with
a token. The hint names the App permission to add.

## Agent run tokens

Under App auth the receiver mints its own installation token, and each agent run gets a
**separate** one, minted for that run only. Set `githubRunToken: false` to turn this off.

- **Scoped to the run's repos.** That's the routed checkout's `origin` (https, `git@` or
  `ssh://` github.com remotes) and the issue's repo (from the issue URL). On `github-projects` the
  two can differ. Both must be under one account: an installation token can't span two, so a run
  whose issue and code live under different owners is refused. When `origin` isn't on github.com
  (with no App forge to fall back on), the token covers the issue repo only, with Metadata and
  Issues permissions. The run then keeps your SSH agent, and pushes go out with your own git
  credentials.
- **Limited to what the step kind needs.** It never gets Workflows, Administration, Secrets,
  Actions write or any org permission:

  | Step kind | Permissions (plus Metadata: Read) |
  |---|---|
  | `implement`, `change` | Contents W, Pull requests W, Issues W, Checks R, Commit statuses R, Actions R |
  | `review` | Contents R, Pull requests W, Issues W, Checks R, Commit statuses R |
  | `triage` | Contents R, Issues W |

- **Never in an env var.** A default run (`maxMinutes` 120) outlives a 1-hour token, and an env var
  can't be refreshed inside a running process. So the token lives in a per-run `gh` config dir
  (`<state>/run-creds/<ref>-<step>/gh/hosts.yml`, mode 0600), and the run gets `GH_CONFIG_DIR`
  pointing at it. `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `SSH_AUTH_SOCK` are removed
  from the run's env, because `gh` prefers an env token over its config. git gets
  `gh auth git-credential` as its only github.com credential helper, and SSH github remotes are
  rewritten to HTTPS (env-based git config, git ≥ 2.31). A push therefore uses the run token, not
  your SSH key.
- **Refreshed.** 10 minutes before the token expires, the receiver mints a fresh one with the same
  scope and rewrites `hosts.yml`. `gh` and git read it again on every call. A failed refresh writes
  one line to the run log and retries every minute until the token expires. It never kills the run.
  Past expiry the agent's `gh`/git calls fail, and the agent says so in its verdict.
- **Revoked** (`DELETE /installation/token`) and its dir deleted when the run ends: exit, timeout,
  cancel or spawn error. A receiver crash skips that, but the token dies within the hour anyway.
  The next run of the same ref and step wipes the dir first, and `agenthook cleanup` removes
  `run-creds/*` dirs untouched for over 2 hours.
- **Refused, not downgraded.** If a token can't be minted (e.g. a 422 because the App lacks
  Contents write), the run fails with `GitHub run token: <GitHub's message>` and no agent is
  spawned. It never falls back to your token.

The run log names the token's scope and expiry (never the token), e.g.
`GitHub App token: o/r (contents:write, pull_requests:write, issues:write), expires 14:05 UTC`.

**The bot identity.** A run token acts as `<app>[bot]`, so agent pushes, PRs and comments appear as
the App, not as you. PRs are still matched by their `agent/<ref>` branch. The bot is never counted
as the owner: the prompt tells the agent that only comments by `@<assigneeLogin>` are answers, and
the `@agent` resume already checks that login.

**Workflow files.** A token without the Workflows permission can't push a commit that adds or
changes a file under `.github/workflows/`; GitHub rejects the push. Under App auth an agent can't
use CI as an escalation path.

A step `env` that sets `GH_TOKEN`/`GITHUB_TOKEN` still wins over the run token. That's your
explicit choice, and `doctor` warns about it.

### Without an App

GitHub has no API to create or narrow a personal token, so with a PAT nothing is minted. Agents get
your `GITHUB_TOKEN`/`GH_TOKEN` through the [env allowlist](agents.md#agent-environment), and
`doctor` notes it. To narrow what agents hold, create a **fine-grained PAT** limited to the repo
(Contents, Pull requests and Issues: Read & write) and hand only that to agents through the step
env: `"env": { "GH_TOKEN": "${AGENT_GH_TOKEN}" }`.

**Other trackers and forges.** None of them gets a per-run token:

- **GitLab** project access tokens can be created by API, but that needs the Maintainer role. Each
  token also creates a bot user, and expiry is a whole date (at least a day), not an hour.
- **Jira, Asana and Linear** have no API to mint a short-lived scoped token from an API key or PAT.

Their comment tokens stay allowlisted.

## Check it

`agenthook doctor` replaces the token check with these checks under App auth:

- the private key parses;
- an installation token can be fetched (one live call to GitHub);
- with agent run tokens on, a run token for the `implement` permission set can be minted on the
  repo, then it is revoked at once (one more call each way). A 422 means the App lacks Contents or
  Pull requests write;
- `tracker.assigneeLogin` is set.

The forge gets all but the last. `doctor` also warns when `githubRunToken` is false under App auth,
when a step `env` overrides the run token, and when a repo's `origin` isn't on github.com.
