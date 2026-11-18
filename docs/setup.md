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
Fine-grained tokens need Issues, Pull requests, Contents and Projects access.
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

## 3. Subscribe to a board

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

## 4. Check, warm up, schedule

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

## 5. Day-to-day

`status` shows what happened; `pause --for 3d` and `resume` control
availability (open claims are withdrawn, unstarted assignments released on the
next tick); `run` executes a task immediately; `cleanup` removes recorded
leaks. Uninstall: `schedule uninstall`.
