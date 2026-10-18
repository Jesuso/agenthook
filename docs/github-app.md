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

If the tracker and the forge use the same App, grant the union of the two lists.

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

## What still uses your own credentials

The App authenticates **the receiver** only. The agents it spawns (`claude -p` …) inherit the
receiver's environment and still use **their own** `$GITHUB_TOKEN` / `gh auth` for the comments,
pushes and PRs they make. Keep those set up as before. Handing the agent a short-lived installation
token is a possible follow-up, not part of this.

## Check it

`agenthook doctor` replaces the token check with three checks under App auth:

- the private key parses;
- an installation token can be fetched (one live call to GitHub);
- `tracker.assigneeLogin` is set.

The forge gets the first two.
