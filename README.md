# Claude Code InActivity

> **Your inactivity is Claude's *in activity*.**
> While you are away, your unused Claude quota is hard at work on your team's backlog.

The name is a pun: when you are *inactive*, Claude is *in activity*. The plugin id
is `clode-inactivity` (Claude Code reserves ids starting with `claude-`, so the
product is spelled "Clode" there), the CLI is `inactivity`, and the product is
**Claude Code InActivity**.

A task scheduler for Pharo teams. It spreads the tasks of a GitHub Projects (v2)
board over the Claude accounts of the team members: every morning each member's
machine claims tasks through comments, a deterministic resolution decides who
gets what, and the winners run the tasks unattended and open **draft pull
requests**. Priorities, per-member availability and per-task difficulty control
how much quota is spent and which model does the work.

Status: beta (v0.1). Pharo repositories only (Tonel + Metacello baseline).
There is no server: the board is the only shared medium.

## How it works

1. Each member runs a small OS job (launchd, systemd, cron or Task Scheduler)
   that calls `inactivity tick` every 10 minutes.
2. In the claim window (default 06:00-10:00 in the team time zone) each client
   posts one hidden-marker `claim` comment per task it wants (ranked, within its
   declared capacity and models).
3. After the window plus a grace period every client recomputes the same pure
   function and gets the same assignment table. Assigned members post an
   `assign` comment, set Status to `Claimed`, then run their tasks.
4. A run creates a git worktree and a disposable Pharo image (through
   [PLexus](https://github.com/Evref-BL/PLexus)), loads the baseline, runs
   headless `claude -p` with the right model, verifies, commits, pushes a branch
   and opens a draft PR. Image and worktree are deleted afterwards.
5. A member who hits a usage limit releases the rest; a second claim round
   (default 11:30-12:00) lets others take over.

See [docs/protocol.md](docs/protocol.md) for the claim protocol and
[docs/design.md](docs/design.md) for the full specification.

## Install

```
/plugin marketplace add Evref-BL/claude-code-inactivity
/plugin install clode-inactivity@clode-inactivity
/clode-inactivity:setup
```

The CLI also works without the plugin: `node bin/inactivity.js <command>`.
Requirements: Node >= 22.12, git, Claude Code >= 2.1.259 logged in, a GitHub
token with `repo` and `project` scopes (`GH_TOKEN` or `gh auth login`), Pharo
Launcher (used by PLexus, fetched with `npx`). No runtime npm dependencies.

Step-by-step: [docs/setup.md](docs/setup.md). Before the first run add the GitHub
logins you trust (`inactivity trust add <login>`) and restrict the board to your
group ([docs/board-lockdown.md](docs/board-lockdown.md)).

## Plugin skills

| Skill | Purpose |
| --- | --- |
| `/clode-inactivity:setup` | Guided setup: doctor, token, config, board, warmup, scheduler. |
| `/clode-inactivity:status` | Read-only snapshot of cycle, offer, resolution and runs. |
| `/clode-inactivity:run-now` | Run one assigned task immediately (asks first). |
| `/clode-inactivity:board-guide` | How to write tasks the agent can finish. |

## Commands

<!-- commands:start (generated from src/cli.js `commands`) -->
| Command | Purpose |
| --- | --- |
| `inactivity init [--force]` | Create the config directory and a default config.json. |
| `inactivity config path\|show\|validate\|set <dotted.key> <json-value>` | Show, validate or edit the user config. |
| `inactivity trust add <login>... \| remove <login>... \| list` | Manage YOUR whitelist of trusted GitHub logins (empty: nothing is claimed or run). |
| `inactivity projects add --owner <o> --number <n> (--policy-repo <o/r> \| --team-file <f>) [--repo <o/r>[=url]]... \| list \| remove <id> \| check <id>` | Manage subscribed GitHub Projects boards. |
| `inactivity team init [--out <file>] [--timezone <tz>] [--member <login>]... \| show \| check <file>` | Create, check or show the shared team policy. |
| `inactivity doctor [--online] [--skip-pharo] [--smoke-claude]` | Check the environment (Node, claude, GitHub token, PLexus, scheduler). |
| `inactivity tick` | Window-aware, idempotent step called by the OS scheduler. |
| `inactivity claim [--round 1\|2] [--cycle <date>] [--force-window]` | Post this member's claims now if a claim round is open. |
| `inactivity resolve [--round 1\|2] [--cycle <date>] [--post-assign]` | Recompute the deterministic assignment table. |
| `inactivity run [--item <owner/repo#n>] [--model <alias\|id>] [--no-pr] [--keep] [--force]` | Execute one assigned task now (spends quota, posts comments, opens a draft PR). |
| `inactivity status [--cycle <date>] [--runs <n>]` | Board snapshot: phases, offer, resolution, my tasks, last runs, scheduler. |
| `inactivity pause [--until <ISO\|YYYY-MM-DD>] [--for <3d\|12h\|90m>]` | Pause this member (optionally until a date or for a duration). |
| `inactivity resume` | Clear the pause. |
| `inactivity schedule install [--interval <min>] [--platform <p>] [--no-copy] [--yes] \| uninstall \| print [--platform <p>]` | Install, remove or print the OS scheduler job that calls tick. |
| `inactivity warmup [--template <t>]` | Create and delete a scratch Pharo image so the first morning run is fast. |
| `inactivity cleanup [--older-than <hours>]` | Remove leaked images and worktrees recorded in state. |
<!-- commands:end -->

Global options: `--json`, `--dry-run`, `--offline`, `--project <id>`,
`--now <ISO>` (needs `--dry-run` or `--yes`), `--home <dir>`, `--yes`, `-q`,
`-v`. Exit codes: 0 ok, 1 error, 2 usage, 3 `doctor` found a failing check,
4 a run ended with a task-level failure. With `--json` the answer is one JSON
document: `{"ok":true,...}` or `{"ok":false,"code":"...","error":"..."}`.

## Configuration in one minute

Per member, `config.json` (never contains secrets): **`trustedAuthors`** (your own
whitelist of GitHub logins, empty by default: nothing is claimed or run until you
add some, see "Security model"), subscribed projects and the
repo allowlist, `allowPublicBoard`, `availability` (days, `dailyPoints`, `maxTasksPerDay`, `models`,
`hardDifficultyAllowed`, `creditHeadroom`), execution limits per difficulty,
`permissions`, `pharo`, `claude`, `git`. Per team, `.inactivity/team.json`
in a policy repo: time zone, claim window (default 06:00-10:00), grace, start
deadline, round 2, field names, priority weights, difficulty to model mapping,
roster (trust is **not** shared: it is per member). Details in [docs/setup.md](docs/setup.md) and
[docs/board.md](docs/board.md).

## Security model

An unattended `claude -p` edits code from issue text, and anyone who can create or
edit a task on the board could try to prompt-inject your Claude. Mitigations:

- **Your own whitelist of trusted GitHub logins** (`inactivity trust add <login>...`,
  stored in your config, never shared, **empty by default**: nothing is claimed
  or executed until you add logins). It is checked three times on your machine:
  when you build claims, when an assignment arrives, and right before a run on a
  freshly fetched issue, where both the author **and the last editor** (body and
  title) must be on your list, so an issue cannot be rewritten after it was
  vetted. Being on the team roster or an organization member grants no trust.
  Claim resolution does not depend on anybody's whitelist: a task nobody trusts
  simply gets no claim.
- **Lock the board down on GitHub** (private project, access limited to the
  group, no outside collaborators): [docs/board-lockdown.md](docs/board-lockdown.md).
  `inactivity projects check` and `doctor --online` fail on a public board.

Other mitigations: task text is wrapped as untrusted data, the agent has
no shell at all (`Read`/`Glob`/`Grep`/`Edit`/`Write` scoped to its worktree,
secrets paths denied) and only an explicit list of Pharo inspection, edit, test
and export tools (never `image_evaluate`, never the image lifecycle), the machine's
Claude settings are not loaded, the agent and PLexus get an allowlisted
environment (no cloud, registry or database credentials), the dispatcher (not
the agent) commits and pushes only `inactivity/<login>/...` branches, draft
PRs only, forbidden paths checked after the run, agent text is stripped of links,
images and HTML before it is published, state and logs are owner-only (0600/0700).
**Residual risk**: opting into `permissions.allowImageEvaluate` gives the agent
arbitrary code execution; use a dedicated OS user or machine for team-wide use.
Read [docs/security.md](docs/security.md) before enabling the scheduler.

## Relationship to pharo-agent

The interactive [pharo-agent](https://github.com/Evref-BL/pharo-agent-plugin)
plugin is **intentionally not a dependency**. It prepares a developer's own
checkout and image (`.pharo-agent/`, `CLAUDE.md`, per-clone init), which is the
opposite of what unattended runs need: a throw-away worktree and a throw-away
image per task, nothing written into the checkout, no per-clone setup. Pharo
Dispatch therefore drives [PLexus](https://github.com/Evref-BL/PLexus) directly,
which is also what pharo-agent uses underneath. Use pharo-agent for your day-to-day
Pharo work (`/pharo-agent:pharo-setup` installs Pharo Launcher and a first image);
use Claude Code InActivity for the unattended runs.

## Troubleshooting

Run `inactivity doctor --online`. Check ids: `node`, `config`, `projects`,
`trusted-authors`, `timezone`, `git`, `claude-cli`, `claude-auth`, `anthropic-api-key`,
`claude-smoke`, `github-token`, `gh-cli`, `github-viewer`, `github-scopes`,
`board-exposure`, `projects-online`, `npx`, `plexus`, `pharo-launcher`, `scheduler`,
`state-dir`, `disk`. Each failing check prints a `fix`. Leaked images or
worktrees: `inactivity cleanup`.

## Uninstall

```
node bin/inactivity.js schedule uninstall
/plugin uninstall clode-inactivity@clode-inactivity
```

Then delete the config directory (`~/.config/inactivity`) and the state
directory (`~/.local/state/inactivity`) if you no longer need them.

## Development

```
npm test        # node --test, offline: no network, no gh, no claude, no Pharo
npm run check   # syntax check
```

MIT.
