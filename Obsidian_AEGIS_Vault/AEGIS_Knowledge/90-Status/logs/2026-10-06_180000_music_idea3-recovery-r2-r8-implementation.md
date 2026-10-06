---
title: Task Receipt — IDEA3 Recovery R2-R8 repository implementation
date: 2026-10-06T18:00:00+07:00
owner: music
area: idea3
branch: feat/idea3-recovery-r2-r8-stage
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Recovery R2-R8 repository implementation

## What changed

- Implemented exactly one governed mutating Recovery Phase-4 stage after R1Bv and before L8.
- Reworked inherited raw R1Bv clones into Recovery-specific Core orchestration, one exclusive attempt marker, normal D4 exit-code-only handling, owner/K3 gates, immutable freeze inputs, Recovery handlers, intended-change preservation allowlist, and final Core/evidence/hash-chain verification.
- Preserved R1B_RESULT=FAIL_IMMUTABLE, R1BV_RESULT=PASS, and the unclaimed F1_REAL_DETECTOR_ACCEPTANCE, R1_VERIFIED, LVR, L8, and L9 boundaries.

## Source files changed

- IDEA3-AEGIS_Lockdown/aegis_soc/recovery_stage.py — Core Recovery ladder, marker semantics, normal D4 boundary, WAL-aware final proof.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-recovery-run-lib.sh — Recovery owner gates and reuse of the existing R1B/R1Bv predecessor function.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-recovery-owner.sh — Recovery owner-run template with Authorization + K3, exact-main and no-secret boundary.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/recovery_runner_freeze.py — Recovery-specific frozen pin set.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/recovery_verifier_snapshot.py — immutable verifier snapshot tooling retained for Recovery.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/Recovery/apply.sh — Core-mediated Recovery steps.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/Recovery/verify.sh — final evidence/claim boundary.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/Recovery/rollback.sh — human reconciliation only; no automatic reopen/retry.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/Recovery/allow-keys.txt and allow-listeners.txt — narrow intended-change and listener boundaries.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh — registered Recovery stage order and gap contract.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-stage-gate.sh — Recovery treated as mutating and K3-required.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md — current implementation/live boundary.
- IDEA3-AEGIS_Lockdown/tests/test_recovery_stage.py — focused Recovery contract tests.
- IDEA3-AEGIS_Lockdown/tests/r1bv/test_r1bv_contract.py, tests/r1i/test_r1i_input_instrumentation.py, tests/test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope.py, tests/test_pr11_phase4_f1u_stage.py, tests/test_pr11_phase4_r1du_stage.py, tests/test_r1_acceptance.py — affected registry-order expectations.
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md and idea3-moc.md — durable current state.

## Verification evidence

- /usr/bin/python3 -m pytest -q focused Recovery, R1Bv, registry, and acceptance suites — pass: 1,169 passed.
- /usr/bin/python3 -m pytest -q IDEA3-AEGIS_Lockdown/tests/r1bv IDEA3-AEGIS_Lockdown/tests/test_core_recovery.py IDEA3-AEGIS_Lockdown/tests/test_core_recovery_security.py IDEA3-AEGIS_Lockdown/tests/test_core_restore_policy.py IDEA3-AEGIS_Lockdown/tests/test_core_break_glass.py IDEA3-AEGIS_Lockdown/tests/test_recovery_evidence.py — pass after registry expectation reconciliation; initial stale-contract run was 708 passed / 2 stale assertion failures.
- node --test tests/collaborationPolicy.test.mjs — pass: 33 passed.
- node scripts/validate-vault.mjs — pass with 2 existing canvas owner-review warnings.
- git diff --check, bash -n on affected shell files, and /usr/bin/python3 -m py_compile on affected Python files — pass.
- No Production, Recovery LIVE, R1B/R1Bv rerun, CUT/RESTORE live operation, or ESP32 operation was performed.

## Canonical notes updated

- Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md — Recovery repository implementation is complete; LIVE remains NO.
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md — current Recovery state and superseded historical wording.
- IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md — Phase-4 Recovery sequence and safety boundary.

## Shared surfaces touched

- None — all changed paths are within the IDEA3/Music-owned code, tests, Phase-4 knowledge, and IDEA3 canonical notes.

## Integration requests

- Music functional owner review and Kla integration review of the governed stage registration, K3/Authorization boundary, Core Recovery reuse, and preservation allowlist before any future LIVE authorization. Human owner must open/review/merge the Draft PR; no agent merge.

## Known limitations

- Recovery LIVE is intentionally not executed by this implementation PR; no Production result or Recovery PASS is claimed.
- The two vault canvas warnings are pre-existing owner-review warnings.
- The repository default PlatformIO Python lacks pytest; the system Python runner was used successfully.
- The untracked .impeccable/hook.cache.json was observed as unrelated worktree state and is not included.

