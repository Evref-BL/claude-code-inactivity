# Board conventions

## Requirements

- A GitHub Projects v2 board (organization or user).
- Items are **issues** in repositories. Draft issues have no comments and are
  skipped (reported by `status` and `projects check`). Pull requests are skipped
  unless the team policy sets `includePullRequests`. Archived and redacted items
  are skipped.
- Every repository holding tasks contains `.inactivity.json` and appears in
  the `--repo` allowlist of each executing member.

## Fields (names configurable in `team.fields`)

| Field | Type | Values | If absent |
| --- | --- | --- | --- |
| Priority | single select | P0, P1, P2, P3 (weights 1000/100/10/1) | label `priority:<X>`, else `defaultPriority` (P2) |
| Difficulty | single select | easy, medium, hard | label `difficulty:<x>`, else `defaultDifficulty` (medium) |
| Status | single select | Todo, Claimed, In progress, In review, Blocked, Done | required |
| Agent | text | `@login` of the assignee | optional |

The label `inactivity:skip` excludes an issue. `projects check <id>`
validates field and option names.

Status lifecycle (a cache; comments are authoritative):

```
Todo -> Claimed -> In progress -> In review -> Done (a human merges)
                       |-- task-level failure --> Blocked
                       '-- release / infrastructure failure --> Todo
```

A human setting Status to `Todo` is the approval gate. A task is a candidate
only when it is open, `Todo` (or a stale `Claimed`) and not started today.
Whether a member *claims* it is a personal decision: each member claims and runs
only tasks whose author **and last editor** are on their own `trustedAuthors`
list (`inactivity trust add <login>`, empty by default, so nothing runs until it
is filled) **and that the member approved** after reading it (`inactivity review` /
`inactivity approve`, bound to the exact title and body: a later edit voids the
approval). A task nobody trusts or approved receives no claim from that member and
stays `Todo`. Who may
write to the board at all is a GitHub setting: see
[board-lockdown.md](board-lockdown.md). Two task-level failures in seven days make a task ineligible
until a human resets it.

## Difficulty to model and budget

| Difficulty | Points | Default model | Timeout | Max turns | Budget |
| --- | --- | --- | --- | --- | --- |
| easy | 1 | haiku | 20 min | 40 | 1 USD |
| medium | 2 | sonnet | 45 min | 80 | 3 USD |
| hard | 4 | opus | 90 min | 150 | 10 USD |

Changeable in the team policy (`difficultyModel`, `difficultyCost`) and in each
member's config (`execution`, `modelOverrides`, `effort`). The budget is an
API-equivalent estimate, not a subscription quota. Members must opt in to hard
tasks with `availability.hardDifficultyAllowed`.

## `.inactivity.json`

```json
{
  "version": 1,
  "pharo": { "template": "Pharo 14.0 - 64bit (stable)", "category": null },
  "baseline": { "name": "MyProject", "sourceDirectory": "src", "group": "default", "repository": null },
  "verify": {
    "expression": "(MyProjectTests suite run) hasPassed ifTrue: ['PASS'] ifFalse: ['FAIL']",
    "mcp": null
  },
  "baseBranch": null,
  "forbiddenPaths": [],
  "maxChangedFiles": 200,
  "extraInstructions": "Use Pharo 14 coding conventions. Run MyProject-Tests before finishing."
}
```

- `pharo.template` is the exact Pharo Launcher template name as printed by
  `plexus image templates`.
- `baseline.name` is the Metacello baseline without the `BaselineOf` prefix.
  Without this file the dispatcher autodetects `src/BaselineOf*` and warns.
- `verify.expression` runs in the image after the agent finished and must
  answer a string starting with `PASS`. Without any verify the PR is flagged
  unverified.
- The dispatcher reads this file from the base ref; the agent cannot change it.
  `forbiddenPaths` adds to the defaults `.github/**`, `.inactivity.json`,
  `**/.git/**`, `*.pem`, `.env*`.

## Writing good tasks

Short imperative title, one outcome; where in the code (package, class);
reproduction; acceptance checklist ending in the tests that must pass; what not
to touch; no secrets and no links the agent must open. Unsuitable: draft issues,
unverifiable work, anything needing credentials, network, a GUI or a human
decision, wide refactors, CI changes. The `board-guide` skill carries the same
advice.
