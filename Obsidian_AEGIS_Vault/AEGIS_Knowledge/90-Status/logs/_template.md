---
title: Task Receipt — <short task name>
date: YYYY-MM-DDTHH:MM:SS+07:00
owner: kla | pub | music
area: idea1 | idea2 | idea3 | infrastructure | shared
branch: <type>/<short-task-name>
status: complete | partial | blocked
edit_policy: append-by-new-file
---

# Task Receipt — <short task name>

> Copy this template to `YYYY-MM-DD_HHMMSS_<owner>_<lowercase-topic>.md`.
> A task creates one new receipt and never edits another task's receipt.
> For cross-scope work, repeat every exact path from the PR's
> `Shared surfaces touched` section here; the policy check compares both records.

## What changed

- <observable outcome>

## Source files changed

- `<exact path>` — <reason>

## Verification evidence

- `<exact command>` — pass | fail: <result>

## Canonical notes updated

- `<exact Obsidian path>` — <fact replaced or added>
- `None` — <why no durable project fact changed>

## Shared surfaces touched

- `<exact path>` — <why integration-owner review is required>
- `None` — task stayed inside its selected area

## Integration requests

- <reviewer/owner, decision required, downstream effect, and rollout or rollback>
- None — valid only when no cross-scope/shared path changed

## Known limitations

- <untested, blocked, deferred, or still-evolving work>
- None
