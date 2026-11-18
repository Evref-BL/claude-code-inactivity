# Board lockdown (GitHub side)

Claude Code InActivity runs a member's Claude on tasks taken from a GitHub
Projects board. Two things keep a stranger from steering that Claude:

1. **Your own whitelist of trusted GitHub logins** (`inactivity trust add <login>`),
   enforced on your machine. See [security.md](security.md).
2. **A board that only the members of the group can read and change.** This page.

The first one is code. The second one is GitHub configuration that **humans do in
the GitHub UI**: the tool cannot (and should not) change your organization's
settings. It can only look: `inactivity projects check <id>` and
`inactivity doctor --online` read what the API shows and complain, see
"What the tool checks" at the end.

Why both: anybody who can create or edit a task on the board can try to
prompt-inject the Claude of whoever runs it. The whitelist makes that useless for
people you did not vouch for; the lockdown removes them from the board in the
first place, and keeps claims, assignments and task text away from the public.

Menu names below are those of github.com at the time of writing; GitHub moves
them around from time to time, the setting names are what matter.

## 1. Make the project private and limit who can use it

Open the project, click the `...` menu at the top right, then **Settings**.

1. **Visibility.** In **Manage access**, set the project to **Private**. A public
   project can be read by anyone on the internet, including every claim,
   assignment and task text on it. (Organization-owned and user-owned projects
   both have this switch. Organization owners can forbid public projects
   altogether under Organization settings > Member privileges > "Allow members to
   change project visibilities".)
2. **Base role** (organization projects only). Still in **Manage access**, set the
   **Base role** to **No access**. "Read" is acceptable if every member of the
   organization may see the board; it must never be "Write". The base role applies
   to *all* members of the organization.
3. **Add the group, not individuals.** Under **Invite collaborators**, add one
   team (for example `@acme/inactivity-members`) with the role **Write**, and
   nobody else. The members of that team are the people who may create, move and
   edit tasks. Keep **Admin** for one or two owners.
4. **No outside collaborators.** Never invite an outside collaborator, a bot
   account or a guest to the project. If a contractor must see tasks, give them
   **Read** at most, through the team, and tell the members: tasks they edit are
   judged by each member's own whitelist anyway.
5. **Workflows.** Open the project's **Workflows** (the `...` menu > Workflows)
   and check these built-in rules, because they let *repository* activity put
   items on the board without anybody on the board team touching it:
   - **Auto-add to project**: disable it, or restrict its filter to repos that
     only the group can open issues in (step 2 below). An auto-added issue from a
     stranger is a task candidate.
   - **Item added to project** (set Status): do **not** make it set `Todo`
     (the `ready` status of the team policy). `Todo` is the human "approved"
     gate: a new item should land in `Backlog` (or no status) and a member of the
     group moves it to `Todo` after reading it.

## 2. Control who can create and edit the *issues*

The board only references issues; the text that reaches the agent is the text of
the issue, and issues live in repositories. The same people-control is needed there.

1. **Repository access.** Repo **Settings > Collaborators and teams**: grant
   write access to the group's team only; remove individuals and outside
   collaborators who do not need access. For a private repo, only people with
   access can open issues, which is the simplest lockdown. Prefer **private
   repositories** for the task repos and for the policy repo.
2. **Public repositories.** If a task repo must stay public, anyone can open
   issues and comment. Restrict it with **Interaction limits**: repo **Settings >
   Moderation options > Interaction limits**, choose "Limit to repository
   collaborators" (or "existing users" / "prior contributors" as a weaker option).
   Limits expire (24 hours up to 6 months): put a reminder in your calendar and
   re-apply. Organization owners can set the same limit for every repository under
   Organization settings > Moderation > Interaction limits.
3. **Issue editing.** Anyone with write access to a repo can edit any issue
   there. That is the "bait and switch": a trusted member opens an issue, somebody
   else rewrites it. The tool re-reads the issue before every run and refuses it if
   its last editor (body or title) is not on *your* trusted list, but fewer people
   with write access is still better. Keep the list of people with write access to
   the task repos short and equal to the group.

## 3. Branch protection: the bot's pull requests need a review

Runs push branches named `inactivity/<login>/<n>-<slug>` with the member's git
credentials and open **draft** pull requests. Nothing merges automatically, and
that must stay true on GitHub's side too.

In each task repo, **Settings > Branches** (or **Rules > Rulesets**), protect the
default branch (and any release branch):

- **Require a pull request before merging**, with at least **1 approval**.
- **Dismiss stale pull request approvals when new commits are pushed.**
- **Require review from Code Owners** if you have a `CODEOWNERS` file; make the
  group's team the owner of `.github/` and of `.inactivity.json`.
- **Restrict who can push to matching branches** (nobody, or the release
  managers) and **do not allow bypassing**; tick **Do not allow bypassing the
  above settings** so that administrators follow the rule too.
- **Block force pushes** and **branch deletion**.
- Require the CI status checks that matter.

Treat every draft PR from the bot as untrusted code from an unknown contributor:
read it before approving. Nobody should approve their own bot's PR without reading it.

## 4. Accounts and tokens

- **Two-factor authentication** for everybody: Organization settings >
  Authentication security > **Require two-factor authentication for everyone**.
  Add SAML single sign-on if your plan has it.
- **Tokens.** The dispatcher needs a token with repo and project access. The
  setup flow and `doctor` use a **classic personal access token** (scopes `repo` +
  `project`, or `gh auth login -s repo -s project`): that is the combination
  known to work, and the only one that reaches a *user-owned* project. It also
  reaches every repo you can see, so use a dedicated account or keep that token
  out of shared machines. A **fine-grained personal access token** is narrower
  (limited to the task repos: Issues, Pull requests, Contents: read and write;
  Organization projects: read and write) and is preferable **only if you have
  verified that it works for your organization's project** (support for Projects
  v2 is not verified by this tool, see `docs/design.md` section 12.1). Its
  limits: a fine-grained token has a single resource owner (one organization or
  one user, so it cannot span a user-owned project and an organization's repos),
  and it cannot reach user-owned Projects v2. If you use fine-grained tokens, in
  Organization settings > Personal access tokens **require approval** and review
  the list of tokens that can reach the organization. Tokens never belong in a
  chat or in a config file.
- **Outside collaborators**: Organization settings > People > Outside
  collaborators. The list should be empty, or every entry should be explained.

## 5. Review access periodically

Once a month (put it in the calendar), and whenever somebody leaves the group:

1. Project **Settings > Manage access**: the base role is still No access or
   Read, only the group's team has Write, admins are the expected ones, nobody
   unknown was invited.
2. Organization **People** (members, outside collaborators, pending invitations)
   and **Teams** (membership of the group's team).
3. Each task repo **Settings > Collaborators and teams**, interaction limits not
   expired, branch protection rules still in place.
4. Organization **Settings > Audit log** (organization owners): filter on
   `project`, `repo.add_member`, `team.add_member` and `org.add_member` events since
   the last review.
5. Every member runs `inactivity trust list` and removes logins they no longer
   vouch for, then `inactivity doctor --online`.

## What the tool checks (and what it cannot)

`inactivity projects check <id>` and `inactivity doctor --online` (check id
`board-exposure`):

| Finding | Level |
| --- | --- |
| Project board is **public** | **fail**, unless `allowPublicBoard` is `true` (global key, or per project: `config set projects.0.allowPublicBoard true`), then warn |
| Task repo or policy repo is **public** | warn: anyone can open issues there and claim comments are world-readable |
| Teams linked to the board, linked repositories | listed when the token can see them |
| Direct collaborators of the board, base role | **unknown**: the GraphQL API does not expose them; read them in the UI (step 1) |
| Visibility could not be read | warn (the check never silently passes) |

The GraphQL API has no privacy flag for the organization or user that owns the
project, so there is nothing more to read there. A failing check exits with code
1 (`projects check`) or 3 (`doctor`). `tick` also logs a warning each time it
reads a public board.

Only the board's *visibility* is a hard failure. Everything about *who may write*
is configuration the tool cannot verify: that is why step 5 (review) matters, and
why the whitelist is enforced on every member's machine regardless.
