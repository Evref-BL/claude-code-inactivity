---
name: status
description: Show the Claude Code InActivity status - phases of today's cycle, this member's offer, candidate tasks, the resolution table, assigned tasks and recent runs. Read only. Use when the user asks what inactivity did, will do, or why a task was or was not picked.
---

# Claude Code InActivity status

Read only: this skill never posts a comment and never starts a run.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/inactivity.js" status --json`
   (add `--offline` if the network or token is unavailable: only local state is
   shown then; add `--cycle YYYY-MM-DD` for another day, `--runs 20` for more history).
2. For each project give a compact table:
   - cycle date and the state of round 1 and round 2 (pending, open, closed,
     resolved) with their times, and whether execution is open;
   - my offer (capacity in points, models) or why there is none (paused, day off, limit);
   - candidate tasks I would claim: task, priority, difficulty;
   - tasks skipped as untrusted (`skippedUntrusted`): task, author (and last
     editor when it differs), reason. If `trust.trustedAuthors` is empty say
     plainly that nothing is claimed or executed until the user adds logins with
     `trust add <login>` (suggest it, never run it unasked, never add an author
     just because you saw their name on the board);
   - resolution: task, assignee, model, round; and the unassigned tasks with reasons;
   - my tasks with their local state (assigned, started, outcome, PR).
3. Then the global lines: usage-limit state (`limit.until`), leaked runs, scheduler
   installed or not, and the last runs with outcome and cost.
4. Mention skipped items (draft issues, pull requests, archived) once, with counts.
5. If something looks wrong, name the next command: `doctor --online`,
   `resolve`, `cleanup`, or `schedule install`. Do not run them unasked.
