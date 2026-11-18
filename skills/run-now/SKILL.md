---
name: run-now
description: Run one assigned Claude Code InActivity task right now instead of waiting for the morning scheduler. Spends Claude quota, posts comments and opens a draft pull request, so it asks first.
disable-model-invocation: true
---

# Run a task now

This spends the user's Claude quota, posts comments on a GitHub issue, creates
a disposable Pharo image, pushes a branch and opens a draft pull request. Get
an explicit yes before the `run` step.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/inactivity.js" resolve --json`
   and show the assignment table: which tasks are mine, model, round.
2. Pick the task with the user. If nothing is assigned to them, say so. A
   manual override exists (`run --item <owner/repo#n> --force`): it bypasses
   the claim checks, so only offer it for development on a sandbox repo and
   say clearly that it posts a normal start comment.
3. Offer a rehearsal first: `run --dry-run [--item ...] --json`. It performs no
   comment, push, claude call or image creation.
4. After the yes, run `run [--item <owner/repo#n>] [--model <alias>] [--keep] --json`
   (`--no-pr` skips the pull request, `--keep` keeps the worktree and image for
   inspection and the user must then run `cleanup`). It can take up to an hour:
   run it in the background and report when it finishes.
5. Report `outcome`, `reason`, the PR link, branch, cost, turns and `runDir`.
   Exit code 4 means a task-level failure (tests failed, no change, policy
   violation); exit 1 with a code such as `limit`, `pharo-env` or `auth` is an
   infrastructure problem: suggest `doctor` and say the task was released.
6. Never merge the pull request, never edit the branch for the user unasked.
