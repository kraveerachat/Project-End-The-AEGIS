---
title: AEGIS Development Session Workflow
aliases:
  - AEGIS Agent Workflow
  - AEGIS Session Reporting Rules
  - AEGIS Task and Session Governance
tags: [aegis, governance, workflow, agent, obsidian, git, testing]
type: governance
status: canonical
created: 2026-09-09
updated: 2026-09-09
sources: ["AGENTS.md"]
owner: kla
edit_policy: owner-only
---

# AEGIS Development Session Workflow

> [!important] Canonical session rule
> Every human or AI agent working on AEGIS reads `AGENTS.md`, then this note,
> before planning, editing, testing, configuring infrastructure, committing, or
> preparing a Pull Request. `AGENTS.md` remains the repository-wide authority;
> this note defines how one task continues safely across meaningful sessions.

This workflow makes task state, evidence, Git checkpoints, handoffs, and final
closeout recoverable from the repository without relying on chat history.

## 1. Task lifecycle is unchanged

AEGIS uses one lifecycle:

```text
one task
→ one task branch
→ one Pull Request
→ exactly one immutable final task receipt
```

A task may contain several coherent sessions. A new session does **not** create
a new task, branch, Pull Request, or receipt:

```text
same task branch
→ multiple session plans and Git checkpoints
→ one final task closeout
```

Session count follows changes in scope, risk, environment, or evidence—not chat
length, token count, elapsed time, or which agent continues the work.

## 2. Mandatory reading order

Before any task action, read in this order:

1. repository-root `AGENTS.md`;
2. this note, `core/development-session-workflow.md`;
3. [[START_HERE]];
4. [[core/agent-operating-rules]] and [[core/core-moc]] for shared rules;
5. [[summaries/08_Outstanding_Items_Consolidated]];
6. the selected area's MOC and current status note;
7. the relevant architecture, design, source, test, deployment, and open-PR
   dependency files;
8. the 3–5 newest receipts plus any older receipt directly relevant to the task.

Current source and measured runtime evidence are primary operational truth.
Canonical notes are the durable current-state record. Receipts are immutable
historical evidence. Old screenshots, chats, filenames, broad design documents,
and stale receipts cannot override newer verified evidence.

If sources disagree, report the conflict before editing and state which rule or
evidence resolves it.

## 3. Required state models

The following values are the preferred/common canonical task-state vocabulary:

```text
NOT STARTED
PLANNED
IN PROGRESS
BLOCKED
PRE-EXPOSURE PASS
ACCEPTANCE PENDING
PASS
CLOSED
```

Use the smallest applicable set. A task does not need to pass through every
state. Domain- or task-specific states such as `PARTIAL` may be used when they
are explicitly defined and evidence-safe. A custom state must never falsely
upgrade implementation maturity, deployment maturity, acceptance, or task
closure. `PRE-EXPOSURE PASS` and `ACCEPTANCE PENDING` are available only where
they apply to that task.

Task state, session state, result, and evidence maturity are separate fields;
do not use one as a substitute for another.

Use only these session states:

```text
NOT STARTED
IN PROGRESS
BLOCKED
PASS
CLOSED
```

`PASS` means the stated acceptance boundary has evidence. `CLOSED` additionally
means documentation, cleanup, and checkpoint work for that boundary are done.
Never use either while required evidence is pending.

For runtime-sensitive work, distinguish all applicable maturity layers:

```text
SOURCE IMPLEMENTED
LOCAL VERIFIED
PRE-EXPOSURE VERIFIED
PRODUCTION DEPLOYED
REAL EXTERNAL ACCEPTANCE PASSED
FULLY CLOSED
```

Code present is not proof of deployment. A reachable endpoint is not proof of a
working user flow. A passing mock is not evidence from a real integration.

## 4. Current Task record

Each meaningful active task must be understandable from the relevant
owner-maintained canonical status note. Respect the ownership rules in
`AGENTS.md`. A non-owner may not silently rewrite another area's truth. The
functional owner must either make the live Current Task/Session Register update
or explicitly co-author/review that narrowly scoped block before its
documentation checkpoint. If neither is available, the session is `BLOCKED`;
chat or a future receipt is not a substitute for the required live record.

Use this compact structure:

```markdown
## Current Task

Task:
Branch:
Owner:
PR:
Current state:
Started:
Last checkpoint:
Production mutation allowed: YES / NO

### Goal
...

### Scope
...

### Out of scope
...

### Safety boundaries
...

### Acceptance criteria
...
```

Update it when scope, safety boundaries, dependencies, or acceptance conditions
materially change. Do not replace durable module status with transient chat
notes.

## 5. Session Register

Every meaningful session is represented in the same canonical task record. At
minimum the register contains these fields:

```markdown
## Session Register

| ID | Scope | State | Evidence | Checkpoint | Result | Remaining | Next |
|---|---|---|---|---|---|---|---|
| S1 | Architecture and constraints | CLOSED | owner approval | `<sha>` | PASS | implementation | S2 |
| S2 | Implementation | IN PROGRESS | pending | — | pending | tests and docs | continue S2 |
```

The register must answer, at a glance:

- what each session is allowed to change;
- what is planned, complete, blocked, or still open;
- what evidence supports the result;
- which exact implementation/evidence checkpoint contains completed work;
- what remains and what happens next.

A meaningful session includes one or more of:

- source implementation or behavior-changing defect repair;
- security, database, migration, identity, or authorization work;
- Docker, gateway, network, storage, backup, or system configuration;
- integration, deployment, acceptance, recovery, or incident work;
- a material architecture or risk decision.

Tiny read-only checks and administrative messages may be folded into the current
session row. They do not need artificial session ceremony.

## 6. Start a meaningful session

Before making the session's first mutation, record:

```markdown
## Session S<n> — <name>

State: IN PROGRESS
Started:
Branch:
Starting SHA:

### Plan
...

### Why
...

### Scope
...

### Expected changes
...

### Expected evidence
...

### Safety / Do-not-touch
...

### Dependencies
...
```

For a small coherent session, the Session Register row plus a concise checkpoint
entry is sufficient. The amount of documentation scales with risk.

## 7. End or pause a session

Before calling a session complete or handing it off, update the same canonical
task record with:

```markdown
### Work performed
...

### Implementation details
...

### Exact changes
...

### Defects discovered
...

### Fixes applied
...

### Tests / Evidence
...

### Result
PASS / BLOCKED / PARTIAL / PENDING EXTERNAL ACCEPTANCE

### Known limitations
...

### Remaining work
...

### Next session
...
```

Classify every failure or gap honestly as introduced by this task, pre-existing,
environmental, blocked by a missing dependency, or not yet tested. Never erase a
failed or flaky run merely because a later run passes.

## 8. Session closure

A session may be `CLOSED` only when:

- its planned work and session-level acceptance are complete;
- evidence exists at the environment and boundary claimed;
- test mutations and disposable resources are restored or removed;
- the canonical task record is current;
- `git diff --check` passes;
- the working tree is understood; and
- a coherent implementation/evidence checkpoint exists when the session
  produced durable change, followed by a documentation checkpoint that records
  its SHA.

A session may be `PASS` but not `CLOSED` while documentation, cleanup, or the
checkpoint is pending. A blocked session does not close the task and does not
create a receipt unless the task itself is deliberately ending in a terminal
blocked handoff.

## 9. Git checkpoint rules

Keep every session on the same task branch. Do not create a branch because a
session starts, an agent changes, or work moves between machines.

Before a checkpoint:

```bash
git fetch origin
git branch --show-current
git status --short
git rev-parse HEAD
git rev-parse origin/main
git diff --check
```

If `origin/main` advances and the task is based on `main`, reconcile with:

```bash
git merge origin/main
```

Resolve both sides deliberately and rerun affected verification. Do not rebase
shared task work. Do not force-push. Never push directly to `main`. Stage exact
reviewed paths; do not use `git add .` without first proving every changed path
belongs to the task.

Use focused checkpoint commits when a coherent behavior, evidence layer, or
defect repair is stable enough to preserve. A checkpoint is not a receipt.

When a canonical Session Register must contain an exact checkpoint SHA, use a
two-commit boundary:

1. commit the coherent implementation and its evidence-bearing tests;
2. record that completed commit's SHA in the canonical Session Register and
   commit the canonical documentation update.

The `Checkpoint` column names the first commit—the implementation/evidence
checkpoint—not the later documentation commit that contains the table. A commit
is never required to contain its own SHA.

## 10. Obsidian and Git move together

For every meaningful session that produces durable change:

```text
implementation / testing
        ↓
implementation/evidence checkpoint
        ↓
canonical session update records that checkpoint SHA
        ↓
validation
        ↓
documentation checkpoint
```

Do not let implementation advance across meaningful sessions while its
canonical status remains stale. Do not update Obsidian to claim behavior that
has not been implemented or measured.

Each completed session row binds three things:

```text
truth claim ↔ evidence ↔ Git checkpoint SHA
```

## 11. One immutable receipt—at task closeout

Each task/Pull Request creates exactly one new immutable receipt at its final
task handoff:

```text
90-Status/logs/YYYY-MM-DD_HHMMSS_<owner>_<topic>.md
```

Do not create a receipt for a session or checkpoint. Do not edit, append to,
rename, or replace a receipt already present in the Pull Request's base. Do not
use a receipt as a live session log. Ongoing truth belongs in the
owner-maintained canonical task record.

The task's one receipt is created when the task reaches its final PR-ready state
(`complete`, intentionally `partial`, or terminally `blocked`) and records:

```text
TASK
BRANCH
BASE SHA
FINAL IMPLEMENTATION/EVIDENCE CHECKPOINT SHA
PLAN AND SCOPE
EXACT CHANGED FILES
IMPLEMENTATION
EXACT TEST RESULTS
NEGATIVE CONTROLS
PRODUCTION SAFETY EVIDENCE
KNOWN LIMITATIONS
SHARED SURFACES TOUCHED
INTEGRATION REQUESTS
REMAINING EXTERNAL OR OPERATIONAL STEPS
FINAL TASK STATE
```

The one receipt newly added by the current unmerged task may be corrected in
place before merge when review or reconciliation changes the task's final truth;
it remains one added receipt in the same PR. This is not permission to change a
historical receipt from the PR base. At merge, the receipt becomes immutable.

The receipt records the final implementation/evidence checkpoint SHA—the commit
immediately preceding receipt closeout—not the SHA of the commit that contains
the receipt itself. The receipt-bearing commit SHA is recorded in the PR and
final report after Git assigns it. A commit is never expected to predict its own
SHA.

## 12. Status dashboard and planned/completed/remaining

Large tasks keep a compact dashboard:

```markdown
## Task Status Dashboard

| Area | Status | Evidence / Note |
|---|---|---|
| Architecture | PASS | design approved |
| Source implementation | PASS | focused tests green |
| Local integration | PASS | isolated harness |
| Production deployment | NOT RUN | outside current approval |
| External acceptance | PENDING | owner-gated |
| Final gate | OPEN | human decision |
```

Also keep explicit `Planned`, `Completed`, and `Remaining` views. A checked item
requires evidence; source existence alone is not evidence of deployment or
acceptance.

## 13. Configuration and production safety

Document every meaningful change to Docker/Compose, network topology, VLAN,
MikroTik, UFW, Twingate, Cloudflare, DNS, TLS, systemd, environment contracts,
database migrations, feature flags, reverse proxies, public ingress, storage,
backup, or recovery settings.

Use:

```markdown
### Configuration Change

System:
Before:
Change:
Reason:
Command / mechanism:
Expected effect:
Measured effect:
Rollback:
Evidence:
```

Never record passwords, tokens, keys, cookies, session secrets, database
credentials, or secret-bearing command output.

Every Production-sensitive task states:

```text
PRODUCTION MUTATION ALLOWED = YES / NO
```

When `NO`, use isolated disposable resources and prove cleanup. When `YES`, the
session still needs explicit scope and blast-radius authorization. Capture
before/after identity, state, listeners, networks, volumes, rows, configuration,
and residue where those facts matter. Never infer unchanged Production merely
from a passing local test.

## 14. Evidence and environment binding

Evidence must be exact and bound to the environment where it was observed.
Record, as applicable:

- command, exit code, pass/fail/skip counts, and duration;
- branch and source SHA;
- host or runner identity and operating system;
- Node/Python/database/container/runtime versions;
- container and image identity;
- network path and source identity;
- payload size, digest, latency, and concurrency;
- rollback and cleanup result.

Use explicit evidence such as:

```text
suite = publicShareSecurityRegression
passed = 16
failed = 0
skipped = 0
exit = 0
source_sha = <sha>
environment = local Windows checkout
```

Never write only “tests look good,” “everything passed,” or “seems fine.” Do not
reuse evidence from another SHA or environment without labelling it as
carried-forward and explaining why it remains applicable. Owner-supplied,
simulated, local, pre-exposure, Production, and real-external evidence are
different evidence classes and must stay visibly separate.

## 15. Negative controls

For load-bearing security or safety controls, positive tests alone may be
insufficient. Where practical and safe:

```text
temporarily break one invariant
→ observe the expected failure
→ restore source/configuration
→ observe the final pass
→ prove no mutation residue
```

Record the control, mutation, expected and observed failure, restoration, final
pass, and residue check. Never commit the mutation and never perform a negative
control against Production unless separately designed and authorized.

## 16. Handoff contract

Before pausing a task or handing it to another agent/environment, update:

```markdown
## Handoff

### Current branch
...

### Current HEAD
...

### Current task state
...

### Sessions closed
...

### Session currently open
...

### Verified evidence
...

### Known issues
...

### Exact remaining work
...

### Next command / next action
...

### Do not do
...
```

The receiving agent verifies branch, HEAD, origin, worktree status, and evidence
availability before continuing. It does not reconstruct authority from chat.

## 17. Narrow publication-only transfer exception

Publication is normally part of the same task/session flow. A narrow exception
exists only when all implementation, validation, canonical documentation, and
the one immutable receipt are already committed on the authoritative task branch,
but that exact commit cannot be pushed or submitted from its current environment
because publication credentials or connectivity are unavailable.

A neutral publication environment may then:

1. fetch the authoritative repository;
2. verify the expected full branch name and full commit SHA;
3. verify the commit's tree and intended PR base;
4. push that exact existing branch/commit without rewriting history; and
5. create or recover the same task's Pull Request.

This transfer:

- is not a new task or development session;
- creates no second branch, receipt, canonical-note update, or Obsidian commit;
- makes no source, documentation, configuration, or test change;
- does not substitute new validation claims;
- never pushes to `main`, force-pushes, rebases, merges, deploys, or changes
  Production;
- records publication facts in the PR/final handoff, not by editing the receipt.

If any tracked change is required, the publication-only exception no longer
applies. Continue the original unmerged task under its normal workflow or open a
separately scoped task when the original task is already closed.

## 18. Final task closeout

The final sequence is:

```text
implementation complete
→ required acceptance evidence complete
→ canonical status final
→ exactly one immutable receipt
→ collaboration-policy validation
→ vault validation
→ Git diff validation
→ final commit
→ push task branch
→ Pull Request
→ required human review
→ human merge
→ post-merge verification when applicable
```

An AI agent may prepare, push, open, and maintain a task Pull Request. An AI
agent must **never merge it**. Merge is performed by the responsible human owner
or reviewer after required checks and approvals. No instruction in a task prompt
may authorize direct push to `main`, force-push, or agent merge.

## 19. Final session report

At the end of a meaningful AI-assisted session, report every field below. Use
`NOT APPLICABLE` rather than silently omitting a field:

```text
TASK
SESSION
BRANCH
START_SHA
END_SHA

PLAN
WORK_COMPLETED
FILES_CHANGED
CONFIG_CHANGED

TESTS
NEGATIVE_CONTROLS
PRODUCTION_SAFETY

SESSION_STATE
SESSIONS_CLOSED
SESSIONS_REMAINING

OBSIDIAN_UPDATED
OBSIDIAN_FILES
GIT_CHECKPOINT
CHECKPOINT_SHA

BLOCKERS
KNOWN_LIMITATIONS
NEXT_ACTION
```

## 20. Truth and history

Always distinguish planned, implemented, locally verified, runtime verified,
Production deployed, externally accepted, and closed. Canonical notes replace
stale current-state claims. Immutable receipts retain what was observed at their
own checkpoint and are never rewritten when later evidence supersedes them.

## 21. Precedence and enforcement

If instructions conflict:

1. platform safety rules and repository `AGENTS.md` govern;
2. explicit human-owner instructions govern where repository policy permits;
3. this note governs session planning, evidence, checkpoint, handoff, and
   closeout behavior;
4. stale chat or historical documentation never overrides current policy.

The shared vault validator requires this note and requires routes from
[[START_HERE]] and [[core/core-moc]]. If the repository and Obsidian cannot
answer what is being done, why, on which branch/SHA, with what evidence, what
remains, and what comes next, the session is not durably documented.

## Quick checklist

Before work:

- [ ] Read `AGENTS.md`, this workflow, [[START_HERE]], and area truth.
- [ ] Verify branch, HEAD, `origin/main`, dependency, and worktree state.
- [ ] Record scope, session plan, evidence target, and safety boundary.

At a meaningful session boundary:

- [ ] Record work, failures, evidence, limitations, remaining work, and next step.
- [ ] Update Session Register and status dashboard.
- [ ] Prove cleanup and mutation restoration where applicable.
- [ ] Validate the vault and Git diff.
- [ ] Create and record a coherent checkpoint when appropriate.

At final task closeout:

- [ ] All in-scope acceptance is complete or truthfully bounded.
- [ ] Canonical status is current.
- [ ] Exactly one immutable task receipt exists.
- [ ] Collaboration policy, vault validation, tests, and diff checks pass.
- [ ] Push one task branch and open/maintain one PR.
- [ ] Stop for human review and human merge.
