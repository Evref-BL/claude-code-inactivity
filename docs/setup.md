# Setup guide

The `/clode-inactivity:setup` skill walks through this; the commands below are
what it runs. Prefix with `node "${CLAUDE_PLUGIN_ROOT}/bin/inactivity.js"`
inside Claude Code, or `node bin/inactivity.js` from a checkout.

## 1. Prerequisites

| Need | Why | Check |
| --- | --- | --- |
| Node >= 22.12 | the dispatcher | `doctor` id `node` |
| git | mirrors, worktrees, push | `git` |
| Claude Code >= 2.1.259, logged in | headless `claude -p` with `--permission-prompts` | `claude-cli`, `claude-auth` |
| GitHub token (`repo`, `project`) | board, comments, PRs | `github-token`, `github-scopes` |
| Pharo Launcher + network for `npx` | PLexus creates the images | `npx`, `plexus`, `pharo-launcher` |

Token: `gh auth login -s repo -s project`, or export a classic PAT as `GH_TOKEN`.
A classic PAT is the verified option and the only one for a user-owned project. A fine-grained token is
narrower but has a single resource owner and is unverified for Projects v2: use it only if you have checked it
works for your org project (it then needs Issues, Pull requests, Contents and Projects access).
The `gh` CLI itself is optional. Never paste a token into a chat or a config file.

## 2. Config

`inactivity init` creates `<H>/config.json`, where `H` is
`$INACTIVITY_HOME`, else `$XDG_CONFIG_HOME/inactivity` or
`~/.config/inactivity` (Windows `%APPDATA%\inactivity`). State lives in
`$INACTIVITY_STATE`, else `H/state` when `INACTIVITY_HOME` is set, else
`~/.local/state/inactivity`. `config path` prints both.

Edit with `config set <dotted.key> <json>`; every change is validated before it
is written. Main knobs:

```
config set availability.dailyPoints 6
config set availability.maxTasksPerDay 3
config set availability.models '["haiku","sonnet","opus"]'
config set availability.hardDifficultyAllowed true
config set availability.creditHeadroom '"low"'
config set pharo.defaultTemplate '"Pharo 14.0 - 64bit (stable)"'
```

Security-related knobs (defaults are the safe choice, see [security.md](security.md)):

```
config set claude.passEnv '["ANTHROPIC_BASE_URL"]'      # extra variables the agent may inherit (allowlisted env)
config set pharo.passEnv '["JAVA_HOME"]'                # extra variables PLexus and the image may inherit
config set claude.loadUserSettings true                 # load ~/.claude settings (default false)
config set permissions.allowPharoTools '["class_list"]' # extra Pharo MCP tools for the agent
config set permissions.allowImageEvaluate true          # arbitrary Smalltalk: default false, read security.md first
```

The agent and PLexus do not inherit your whole environment: `CLAUDE_CODE_OAUTH_TOKEN`
and proxy variables pass, cloud or registry credentials do not. If runs need a gateway
variable (for example `ANTHROPIC_BASE_URL`), name it in `claude.passEnv`.

Points: easy = 1, medium = 2, hard = 4 (team policy `difficultyCost`).
`creditHeadroom` scales `dailyPoints` by 0.5 / 1 / 1.5. Several accounts on one
machine: set `claude.configDir` (exported as `CLAUDE_CONFIG_DIR`) and use one
`INACTIVITY_HOME` per account.

## 3. Whom you trust (before anything can run)

Anyone who can create or edit a task on the board could try to prompt-inject your
Claude, so **you** decide whose tasks you accept. The list is yours (config key
`trustedAuthors`), empty by default, never shared with the team, and nothing is
claimed or executed while it is empty:

```
inactivity trust add alice bob          # GitHub logins (case-insensitive, @ optional)
inactivity trust list
inactivity trust remove bob
```

Add yourself if you write tasks you want your own machine to run. Being on the
team roster, or an owner or member of the organization, grants nothing by itself.
A GitHub App must be listed with its suffix (`dependabot[bot]`). The author and
the last editor of an issue must both be on the list at run time. `doctor` warns
while the list is empty, and `status` lists the tasks skipped as untrusted with
their author.

### Approve every ticket yourself

The whitelist is not enough on its own: an account can be compromised and an
issue can be rewritten. By default (`approval: "local"`) a task is claimed and run
only after **you read it and approved its exact content**:

```
inactivity review                       # tasks awaiting your approval: full title and body, author, hash
inactivity approve acme/widgets#12 --hash 3fa91c0d77ab   # the hash `review` displayed
inactivity approvals                    # what you approved (list | revoke <ref> | prune)
```

Do it in the evening, before the claim window (or use `/clode-inactivity:review`,
which shows each ticket and asks you one by one). The approval is bound to the
author, title and body: if the ticket is edited afterwards the approval is void
(`review` then shows it as `changed-since-approval`), the task is not claimed, an
assignment is released with the reason `not-approved`, and a run refuses to start,
`--force` included. Approvals live in `approvals.json` in your state directory and
are never shared; `tick` reports how many tasks await approval. `--hash` makes
`approve` fail if the text changed since you read it; `--all-pending --yes` exists
but approves tasks you did not name, so avoid it. Turning approval off
(`config set approval none --yes`) lets any task of a trusted author run unread:
`doctor` warns about it.

Also restrict the board to the members of the group: see
[board-lockdown.md](board-lockdown.md) (private project, base role, team access,
branch protection, 2FA, periodic review). `projects check` and `doctor --online`
fail on a public board; `config set allowPublicBoard true` (or per project,
`projects.<i>.allowPublicBoard`) accepts it knowingly.

## 4. Subscribe to a board

```
inactivity projects add --owner Evref-BL --number 3 \
  --policy-repo Evref-BL/MCP \
  --repo Evref-BL/MCP --repo Evref-BL/Sandbox=https://github.com/Evref-BL/Sandbox.git
inactivity projects check evref-bl-3
```

`--repo` builds the **allowlist**: a member never executes for a repo that is
not listed. Single-member use: replace `--policy-repo` with `--team-file team.json`.

Create the shared policy once per team:

```
inactivity team init --timezone Europe/Paris --member alice --member bob --out team.json
```

Commit it as `.inactivity/team.json` in the policy repo. The policy of a
day is the file at the last commit before that day's window start, so edits
take effect from the next cycle. Fields and defaults are in
[protocol.md](protocol.md) and the specification.

## 5. Check, warm up, schedule

```
inactivity doctor --online
inactivity warmup
inactivity schedule print
inactivity schedule install --yes
inactivity tick --dry-run --now 2026-11-19T05:10:00Z
```

`schedule install` copies the app into `<state>/app/current`, so a plugin update
cannot break the job; re-run it after updating the plugin (`doctor` id
`scheduler` tells you). Platform notes:

- macOS: LaunchAgent (needs the login keychain for Claude). It does not fire
  during sleep; the next tick after wake catches up. Optional wake:
  `sudo pmset repeat wakeorpoweron MTWRF 05:55:00` (never run for you).
- Linux: systemd user timer, or cron when systemd is absent. For runs without a
  session: `loginctl enable-linger $USER`.
- Windows: `schtasks`; scheduler generation and unit tests are supported,
  executing Pharo there is untested.
- Headless machines: authenticate Claude with `claude setup-token` and export
  `CLAUDE_CODE_OAUTH_TOKEN` in the job environment yourself; the plugin never
  stores it.

## 6. Day-to-day

`review` before each morning; `status` shows what happened (and what awaits approval); `pause --for 3d` and `resume` control
availability (open claims are withdrawn, unstarted assignments released on the
next tick); `run` executes a task immediately; `cleanup` removes recorded
leaks. Uninstall: `schedule uninstall`.
