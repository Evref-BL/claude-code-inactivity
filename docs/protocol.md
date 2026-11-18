# Claim protocol (summary)

The normative text is section 5 of [design.md](design.md). This page is the
operator's view.

## Timeline of a cycle (defaults, team time zone)

| Time | What happens |
| --- | --- |
| 06:00-10:00 | Round 1 claim window. Each client posts claims once, in any order. |
| 10:00:00 | Window closes (GitHub server time). Later or later-edited claims are ignored. |
| 10:01 | Grace over: every client resolves the same table. Winners post `assign` and run. |
| 11:30 | Start deadline. Unstarted or released tasks go to round 2 (30 minutes), previous assignee excluded. |
| 20:00 | Execution ends; no new task starts. |

Only server timestamps (`createdAt`, `lastEditedAt`) count; the local clock only
decides when a client acts.

## Comments

Human text first, exactly one machine marker line last:

```
<!-- inactivity:v1 {"capacity":6,"cfg":"sha256:...","cycle":"2026-11-19","kind":"claim","member":"alice","models":["sonnet","opus"],"rank":1,"round":1,"runId":"...","task":"owner/repo#42","ts":"...","v":1} -->
```

Kinds: `claim`, `withdraw`, `assign`, `release`, `start`, `done`, `failed`. A
comment is valid only if the payload `member` equals the comment author, the
author is on the roster and not a bot, `task` is the issue it sits on, `cfg`
equals the team policy digest, and the marker is a full line (quoted replies,
two markers or fenced markers are rejected). Minimized comments are ignored.
The marker format is public API: a change needs `v2`.

## Resolution

Candidates are sorted by priority weight, then repo, then issue number. For each
candidate, among members with an eligible claim (model covers the difficulty,
cost within capacity) the winner minimises, in order: fill ratio (load plus a
weighted history of recent work, over capacity), claim rank, a SHA-256 hash of
`cycle|round|task|login`, then login. The result does not depend on comment order, claim
time or alphabetical order, and every client computes it independently.
`assign` comments are an audit trail; recomputation is authoritative.

## Execution lock and failures

Before running, a client re-fetches the item and posts `start`; the earliest
valid `start` that still holds the lock wins, a loser posts
`release(reason=lost-lock)`. A `start` followed by a `release` of the same member
no longer holds the lock (the task can be started by someone else, and a round-2
candidate again even if the start was before the cutoff). A `failed` alone does not
release: it is a terminal outcome that needs a human; infrastructure failures post
`failed` and `release` together. A member who hits a usage limit posts
`failed(reason=limit)` and `release` for the rest. A run killed before any outcome
is reconciled by the next tick of that machine (`failed(reason=crashed)` +
`release`). Round 2 re-offers released, stale and unclaimed tasks.

Claims are only valid inside the window by the server's `createdAt`: a client
checks its clock before every post and never counts a claim the server stamped
after the window.

## Withdrawal and edits

`withdraw` removes your own claim before the window closes (used by `pause`).
Editing a claim inside the window uses the new body; editing after the window
invalidates it. Deleted claims vanish for everyone who reads after the deletion.
