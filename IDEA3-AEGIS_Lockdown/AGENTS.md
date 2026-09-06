# AEGIS Codex Instructions

This repository contains AEGIS IDEA3, a cyber-physical lockdown system. Treat the current repository source code and current tests as the source of truth.

## Required reading order
Before making code changes, read:

1. `doc/Content/00_START_HERE.md`
2. `doc/Content/01_PROJECT_CONTEXT_IDEA3.md`
3. `doc/Content/02_AUTONOMOUS_RUNTIME_TASK.md`
4. `doc/Content/03_PRODUCTION_CONSTRAINTS.md`
5. `doc/Content/04_SESSION_HANDOFF.md`

Read `doc/Content/06_REFERENCE_INDEX.md` only when deeper historical context is needed.

## Persistent handoff rule
Maintain `doc/Content/04_SESSION_HANDOFF.md` as the current operational state of the work.

Update it:
- after every major milestone,
- after meaningful architectural or security decisions,
- after test failures that change the plan,
- before ending a long session,
- before context becomes crowded or you suspect the remaining context/token budget is getting low,
- before asking the user to continue in a new Codex conversation.

Do not wait until the last possible moment. If context is getting tight, stop new implementation work first, write the handoff, verify the file was written, then continue only if safe.

The handoff must never contain secrets, passwords, tokens, PIN values, private keys, or HMAC secret values.

## Safety
Do not modify MikroTik, TP-Link, UFW production rules, production routing/VLANs, or physical relay state as part of software implementation unless the user explicitly gives a production-change instruction in the current conversation.

Do not automatically run penetration tests or attack tools against external or production systems.

Do not bypass HMAC, nonce, timestamp, ACK, Dead Man's Switch, or explicit recovery protections.

## Work style
Inspect the repository before guessing filenames or architecture. Prefer incremental changes, tests, dry-run validation, and reversible commits.
