# Security model

Claude Code InActivity runs `claude -p` unattended with a member's credentials on text
that other people can write. Read this before enabling the scheduler. The full
threat table is in section 1.5 of [design.md](design.md).

## What protects you

- **Your own whitelist of trusted GitHub logins.** Anyone who can create or edit
  a task on the board could try to prompt-inject your Claude, so every member
  keeps **their own** list (`trustedAuthors` in their config, managed with
  `inactivity trust add|remove|list`). It is **empty by default**: nothing is
  claimed or executed until you add logins, and the tool says so (`doctor` warns,
  `tick` and `claim` report `empty-trust-list`, `status` shows the skipped tasks
  with their author). It is applied on your machine at three points:
  1. *building claims*: a task whose issue author is not on your list is never claimed;
  2. *an assignment arrives*: the task is verified again, and released with the
     reason `untrusted-author` (a `release` comment, Status back to `Todo`) if it
     no longer passes (the list changed, the issue was edited);
  3. *the runner start gate*, on a freshly fetched issue, `--force` included: the
     author **and the last editor** of the body and the last person who renamed
     the issue must all be on your list, otherwise the run is released with
     `untrusted-author` and nothing starts (no clone, no image, no `claude`). What
     the agent reads is exactly the text that passed this check.

  Logins compare case-insensitively. A bot (a GitHub App) is trusted only when
  listed explicitly with its `[bot]` suffix (`trust add dependabot[bot]`); a
  mannequin or a deleted account never is. Neither the GitHub association (owner,
  member, collaborator) nor the team roster grants trust: the roster is the group
  that shares quota, your list is who you believe. The list is not shared (not in
  `team.json`) and is not an input of claim resolution, which stays a
  deterministic function every member computes identically: a task nobody trusts
  simply receives no claim. A human still sets Status to `Todo`. Comments from
  non-roster authors never enter the prompt. The deprecated `trustedAssociations`
  key of an old `team.json` is ignored.
- **A locked-down board.** Only the group should be able to read the board and
  create or edit tasks on it: private project, access limited to a team, no outside
  collaborators, protected branches, 2FA, periodic review. Humans do that in the
  GitHub UI: [board-lockdown.md](board-lockdown.md). `projects check` and
  `doctor --online` fail on a public board (unless `allowPublicBoard` is true) and
  warn on public repositories.
- **Untrusted data wrapper.** Issue title and body are escaped, truncated and
  placed in an `<untrusted_task_data>` block; the system prompt says it is data.
- **Least authority for the agent.** Never `--dangerously-skip-permissions`,
  never `--bare`. `--permission-mode dontAsk` with an allowlist:
  - file tools scoped to the worktree: `Read(./**)`, `Glob(./**)`, `Grep(./**)`,
    `Edit(./**)`, `Write(./**)`, with deny rules for `~/.ssh`, `~/.config/gh`,
    `~/.claude`, `~/.aws`, `/etc`, `.env*`, keys and credential files (and for a
    second Claude config dir when `claude.configDir` is set);
  - **no `Bash` at all** (git is the dispatcher's job; `git grep -O` and
    `git diff --output` run commands and write files, so no prefix rule is
    safe), and a generic `Bash` deny rule that wins over any allow rule;
  - **an explicit list of Pharo tools** (`PHARO_AGENT_TOOLS` in
    `src/claudeRun.js`): `tool_search`, `tool_get`, class and method tools,
    `package_search`, repository search/change-list/identity/export/reload,
    `test_run`, history tools. Never the whole `mcp__pharo` server: PLexus also
    forwards `image_evaluate` (arbitrary Smalltalk, hence arbitrary code on the
    host) and the image lifecycle tools, which are denied
    (`PHARO_DENIED_TOOLS`). Extra tools: `permissions.allowPharoTools`;
    `image_evaluate`: `permissions.allowImageEvaluate` (off by default, see
    "Residual risk");
  - no web tools, no commit, push or checkout.
- **Machine settings are not loaded.** The agent runs with
  `--setting-sources ""` and an explicit minimal `--settings` (hooks disabled):
  a broad `Bash(*)` allow rule, a hook or a plugin in your own
  `~/.claude/settings.json` cannot widen the dispatcher's allowlist. Login still
  works (credentials and `CLAUDE_CONFIG_DIR`). `claude.loadUserSettings: true`
  brings user settings back; `doctor` then warns about broad allow rules and hooks.
- **The dispatcher commits and pushes**, never the agent: branch
  `inactivity/<login>/<n>-<slug>`, no force push, never the base branch,
  draft PR only, nothing merges automatically.
- **Post-run gates.** Diff checked against forbidden paths (`.github/**`,
  `.inactivity.json`, ...), file count and size, symlink escapes.
- **Hostile checkout settings** are ignored (no setting source is loaded,
  `--strict-mcp-config`).
- **Secrets.** No token in config, comments, prompts or the run record; log
  lines and the stored agent stream are redacted for token shapes (the stream is
  redacted once the run ends and is owner-only from the first byte; it can still
  contain file contents the agent read, so treat `runs/` as private). The agent,
  PLexus and the Pharo image get an **allowlisted environment** (PATH, HOME,
  locale, temp dir, proxy and certificate variables, `CLAUDE_CODE_OAUTH_TOKEN`
  and `CLAUDE_CONFIG_DIR` for the agent only, `PLEXUS_*`, `PHARO_*`): no AWS,
  npm, OpenAI, GitLab, database credentials or `SSH_AUTH_SOCK`. Add variables
  you really need with `claude.passEnv` / `pharo.passEnv`; GitHub tokens are
  never passed. `ANTHROPIC_API_KEY` is passed only with `claude.allowApiKey`.
  The MCP server's environment is written explicitly into `mcp.json` (no
  credential, no proxy URL). The dispatcher's own `git` calls keep your
  environment (they need your credential helper or SSH agent) but run only
  dispatcher commands. Claim comments carry only login, model aliases, capacity
  and ranks, and are public on public repos.
- **Nothing the agent writes is published verbatim.** The summary, notes and
  test detail that land in the PR body, commit message and Done comment lose
  markdown images and links (their target), raw HTML and bare URLs: a GitHub
  image is fetched through its proxy when the page is viewed, which would
  otherwise be a data exfiltration channel. @mentions and closing keywords are
  defanged, token shapes masked.
- **Private state.** State, run, work and log directories are created `0700`,
  files `0600` (state, run record, prompts, stream, verify output, lock, ledger,
  `mcp.json`).
- **Anti-forgery.** The member in a payload must equal the comment author; time
  comes only from server fields.
- **Cost control.** Per-difficulty turns, budget and timeout, daily caps,
  usage-limit detection, one task at a time per machine.

## Residual risk

Pharo's `image_evaluate` tool is arbitrary code execution inside the image, and
Smalltalk can shell out. It is **denied by default**, so a prompt injection that
gets past the trusted-author whitelist cannot reach it. Only if you set
`permissions.allowImageEvaluate` (or add it through `extraAllowedTools`) does
that risk come back, with the member's OS privileges. If you do:

- run dispatch under a **dedicated OS user or machine** for team-wide use;
- keep your trusted-author list short (only people you would hand your keyboard
  to) and review issues before moving them to `Todo`;
- keep the repository allowlist small; use a token with the minimum scopes;
- review every draft PR as untrusted code.

The tool list is a snapshot: refresh `PHARO_AGENT_TOOLS` from the image's
`tools/list` when PLexus or the Pharo MCP server changes, and never add a tool
that evaluates code, runs a shell or touches the file system outside the
worktree. `Claude Code --restricted` (newer versions) additionally confines file
tools to the working directory; it is not used so that older versions keep working.

Image lifecycle tools are denied to the agent, and each task gets its own
PLexus scope, so a run can never touch the member's own images.

## Reporting

Report vulnerabilities privately to the repository maintainers rather than in a
public issue.
