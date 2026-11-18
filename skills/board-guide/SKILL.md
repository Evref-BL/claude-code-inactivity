---
name: board-guide
description: How to write GitHub issues and project fields that Claude Code InActivity can pick up and finish well - acceptance criteria, difficulty, priority, Status, the .inactivity.json file and what makes a task unsuitable. Use when the user writes, reviews or triages tasks for the dispatch board.
---

# Writing tasks for Claude Code InActivity

An unattended agent reads the issue and nothing else. Write it as if for a
capable contractor who cannot ask questions. Full reference: `docs/board.md`.

## A good task

- Title in the imperative, one outcome: "Fix parser crash on empty input".
- Context: where it lives (package, class, method names), how to reproduce.
- Acceptance criteria as a checklist, ending with the tests that must pass
  (name the test classes or packages).
- Scope limits: what must not change.
- No secrets, no credentials, no links the agent must open (it has no network).

## Project fields

| Field | Values | Guidance |
| --- | --- | --- |
| Status | Todo, Claimed, In progress, In review, Blocked, Done | A human sets `Todo` to approve a task. Only `Todo` tasks are claimed. |
| Priority | P0 to P3 | Decides the order of resolution (weights 1000/100/10/1). |
| Difficulty | easy, medium, hard | Selects model and budget: easy = small model, about 1 point; medium = 2; hard = 4 and a large model. |
| Agent | text | Filled in by the dispatcher (`@login`). Leave empty. |

Difficulty guide: easy = one method or class, clear test, under 20 minutes;
medium = a few classes or a new test plus a fix; hard = design decisions,
cross-package change, or an unclear root cause. Hard tasks only run for
members who enabled them. Labels `priority:P1` and `difficulty:easy` work as
fallbacks; the label `inactivity:skip` excludes an issue.

## The repository declaration

Every repo that holds tasks needs `.inactivity.json` at its root:
`pharo.template`, `baseline.name` and `sourceDirectory`, a deterministic
`verify.expression` that answers `PASS`, optional `extraInstructions`. The
agent cannot change this file or `.github/**`. See `docs/board.md`.

## Unsuitable tasks

Draft issues (no comments possible), pull requests, tasks without a way to
verify, anything needing credentials, network access, a GUI, a decision from a
human, repo-wide refactors, or changes to CI. Issues written by people outside
the trusted associations are skipped until a trusted author recreates or
re-labels them. Mark such work `Blocked` or leave it out of `Todo`.
