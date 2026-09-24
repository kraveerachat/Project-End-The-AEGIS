---
title: Task Receipt — IDEA3 PR11 Phase 4 L6b handler tests and guards
date: 2026-09-24T13:06:00+07:00
owner: music
area: idea3
branch: fix/idea3-pr11-l6b-broker-guards
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L6b handler tests and guards

## What changed

- The L6b handler had no behavioural tests (only registration tests); 20 fixture-root characterization tests now cover apply/verify/rollback, legacy preservation, config and identity guards.
- New guards: secret files must be owned by the broker user (`mosquitto` in live mode; `AEGIS_L6B_BROKER_USER` in fixtures), port 8883 must be free before installing the unit, and apply/verify require a stable service (`NRestarts=0`) so `Restart=on-failure` cannot hide a crash loop.
- Finding recorded (not fixed here): no stage installs `/etc/aegis-idea3/mqtt/{conf,acl,passwd,ca.crt,broker.crt,broker.key}`; that install step is currently an undocumented owner action.
- Repository-only. `PRODUCTION_MUTATION_PERFORMED=NO`, live stage not executed, `PR11_COMPLETE=NO`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L6b/apply.sh`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L6b/verify.sh`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l6b_handler.py`

## Verification evidence

- `pytest tests/test_pr11_phase4_l6b_handler.py tests/test_pr11_phase4_t4_broker_migration.py` — pass: 33 passed
- `pytest tests/test_pr11_phase4_*.py tests/test_pr11_k10_server_ca.py` — pass: 885 passed
- `pytest tests` (IDEA3 full) — pass: 1936 passed, 6 skipped
- `bash -n` on touched shell scripts — pass
- `git diff --cached --check` — pass
- `node scripts/validate-vault.mjs` — pass (2 pre-existing canvas warnings)
- staged-diff secret scan — pass: no hits
- `scripts/validate-collaboration-policy.mjs` on the PR body and changed files — pass

## Canonical notes updated

- `None` — repository-only fix; no durable project status fact changed (the L3 fix PR carries the canonical status update, avoiding parallel edits to the same note).

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Live L6b not executed; the 8883 and stability guards are live-only branches covered by static tests.
- mosquitto 2.1.2 ownership semantics after privilege drop are not proven; the guard follows the legacy `mosquitto:mosquitto 0600` convention.
