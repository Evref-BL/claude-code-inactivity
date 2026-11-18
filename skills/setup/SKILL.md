---
name: setup
description: Guided setup of Claude Code InActivity on this machine - environment checks, GitHub token, config, board subscription, Pharo image warmup and the morning scheduler. Use when the user wants to install, configure or repair inactivity.
disable-model-invocation: true
---

# Claude Code InActivity setup

Walk the user through the steps below, in order. Run every command as
`node "${CLAUDE_PLUGIN_ROOT}/bin/inactivity.js" <command> --json` and read
the JSON answer. Stop at the first red item, explain it in plain words, fix it
with the user, then continue. Never write outside the inactivity config and
state directories. Never ask the user to paste a token into the chat.

Spending notice to give once at the start: unattended runs use the user's own
Claude quota and push draft pull requests with the user's git credentials.

## 1. Environment

Run `doctor --skip-pharo`. Fix every `fail` (Node >= 22.12, git, `claude`
>= 2.1.259 and logged in, GitHub token). A `warn` on `anthropic-api-key` means
runs would bill the API instead of the subscription: the dispatcher strips it,
but suggest unsetting it for the scheduler.

## 2. GitHub token (never in chat)

The dispatcher reads `GH_TOKEN` or `GITHUB_TOKEN`, or `gh auth token`. The user
creates it, not you:

- with the GitHub CLI: `gh auth login -s repo -s project`, or
- a classic personal access token with scopes `repo` and `project`, exported as
  `GH_TOKEN` in their shell profile (and in the scheduler environment, see step 8).

`gh` itself is optional.

## 3. Pharo Launcher, and the optional interactive companion

Claude Code InActivity drives PLexus directly (`npx @evref-bl/plexus`), which needs
**Pharo Launcher** installed. The pharo-agent plugin is deliberately *not* a
dependency: it prepares a developer's own checkout and image, while unattended
runs use a throw-away worktree and image per task (see "Relationship to
pharo-agent" in the README). Do not run `pharo-agent init` inside task
checkouts.

If Pharo Launcher is missing (step 7 reports `pharo-launcher`), help the user
install it, per OS, or point them to the pharo-agent setup skill that installs
the launcher and a first image:

- macOS: download PharoLauncher.app from https://pharo.org/download into
  `/Applications`.
- Linux / Windows: install Pharo Launcher from https://pharo.org/download; the
  `plexus` doctor probe is authoritative for whether it works.
- Or, with pharo-agent (also useful for their own interactive Pharo work):
  ```
  /plugin marketplace add Evref-BL/pharo-agent-plugin
  /plugin install pharo-agent@evref-bl
  /pharo-agent:pharo-setup
  ```

## 4. Config

Run `init`. If it answers `config-exists`, keep the file unless the user asks
for `--force`. Then ask for their daily budget and set it with
`config set availability.dailyPoints <n>`, `availability.maxTasksPerDay <n>`,
`availability.models '["haiku","sonnet"]'`, `availability.hardDifficultyAllowed true|false`.
Points: easy = 1, medium = 2, hard = 4 by default. Also set
`pharo.defaultTemplate` to a template name that `plexus image templates` prints.

## 5. Subscribe to the board

Ask for the organization (or user), the Projects v2 number, the repos that hold
the tasks, and where the shared team policy lives. Then:

```
projects add --owner <o> --number <n> --policy-repo <owner/repo> --repo <owner/repo> [--repo ...]
```

Only repos listed with `--repo` are ever executed for this member. If the team
has no policy yet, run `team init --timezone <IANA zone> --member <login> ...`,
show the file, and tell the user to commit it as `.inactivity/team.json` in
the policy repo. A single-member setup can use `--team-file <file>` instead of
`--policy-repo`. Each task repo needs a `.inactivity.json` (see the
board-guide skill and docs/board.md).

## 6. Online check

Run `doctor --online --skip-pharo` and `projects check <id>`. Fix missing
fields, option names or roster membership. Items that are draft issues are
reported as skipped: they cannot be claimed.

## 7. Pharo warmup

Run `doctor` (without `--skip-pharo`). If `pharo-launcher` or `plexus` is red or
warns that Pharo Launcher is missing, go back to step 3 before continuing.
Then `warmup`. The first run downloads
the Pharo template and builds the PLexus base image, which can take minutes;
doing it now keeps the first morning fast.

## 8. Scheduler

Explain what the job does (calls `tick` every 10 minutes, window-aware, no
network before the claim window) and ask before installing. Show the plan with
`schedule print`, then run `schedule install --yes` once the user agrees.
On macOS also show, without running it, the optional wake suggestion
`sudo pmset repeat wakeorpoweron MTWRF 05:55:00`. On Linux mention
`loginctl enable-linger $USER`. For machines where nobody is logged in,
mention `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN`, which the user
must configure themselves.

## 9. Rehearsal

Run `tick --dry-run --now <tomorrow>T<window start + 10 minutes>:00Z` (use the
team time zone offset) and summarise what would be claimed. Nothing is posted.
Finish by pointing to `/clode-inactivity:status`.
