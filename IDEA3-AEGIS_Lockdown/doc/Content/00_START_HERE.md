# START HERE — AEGIS IDEA3 Codex Context

Purpose: let a new Codex conversation resume AEGIS IDEA3 without relying on old chat history.

## Read order
Read these files completely before changing code:

1. `01_PROJECT_CONTEXT_IDEA3.md`
2. `02_AUTONOMOUS_RUNTIME_TASK.md`
3. `03_PRODUCTION_CONSTRAINTS.md`
4. `04_SESSION_HANDOFF.md`

Then inspect the actual repository, README files, tests, Git branch/status, and implementation.

## Source-of-truth priority
When information conflicts, use this order:

1. Current source code + current automated tests
2. Current Git state and runtime configuration checked in the repository
3. `04_SESSION_HANDOFF.md`
4. This Content folder
5. Historical master reports / old screenshots / old chats

Never claim an old PASS still passes without rerunning relevant tests.

## First actions in every new Codex chat
Run/read enough to establish:

- current Git branch
- `git status --short`
- current HEAD
- repository structure
- active IDEA3 entry points
- current tests
- whether `04_SESSION_HANDOFF.md` matches the repository

Then summarize the actual state briefly before modifying code.

## Context / token preservation protocol
Do not rely on chat history as persistent memory.

`04_SESSION_HANDOFF.md` is the persistent state file.

Update it proactively:

- after each major milestone,
- after every 3–5 meaningful implementation changes,
- after an important failure/root-cause discovery,
- before a large refactor,
- before ending a work session,
- whenever the conversation has become long or context/token capacity may be approaching its limit.

If you believe context is becoming tight:

1. STOP starting new work.
2. Gather current Git state and exact test results.
3. Update `04_SESSION_HANDOFF.md` atomically.
4. Include the exact next command/step needed to resume.
5. Verify the handoff file exists and is readable.
6. Only then provide a concise chat response saying the handoff was saved.

Never put secrets in the handoff.

## Standard resume prompt
A user should be able to start a fresh Codex chat with only:

> Read `AGENTS.md` and `doc/Content/00_START_HERE.md` completely. Resume from `doc/Content/04_SESSION_HANDOFF.md`. Inspect the actual repository before modifying anything. Work autonomously on the active task, keep all production constraints, run tests, and proactively update the handoff before context gets tight.
