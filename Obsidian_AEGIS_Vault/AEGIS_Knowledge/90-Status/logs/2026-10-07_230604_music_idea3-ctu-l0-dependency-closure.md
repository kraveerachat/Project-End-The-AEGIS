---
title: Task Receipt — IDEA3 CTu L0 Capture Dependency Closure Repair
date: 2026-10-07T23:06:04+07:00
owner: music
area: idea3
branch: fix/idea3-ctu-l0-capture-dependency-closure
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 CTu L0 Capture Dependency Closure Repair

## Operational truth

- `CTU_ATTEMPT_CONSUMED=NO`
- `CTU_LIVE_EXECUTED=NO`
- `RECOVERY_ATTEMPT_CONSUMED=NO`
- `RECOVERY_LIVE_EXECUTED=NO`
- `PRODUCTION_RUNTIME_MUTATION_PERFORMED=NO`
- `MERGE_PERFORMED=NO`
- `FAILURE_PHASE=PRE_CAPTURE`
- `FAILURE_REASON=PRE_CAPTURE`
- `L0_CAPTURE_RESULT=PARTIAL`
- `CTU_BUNDLE_TRAVERSAL=PASS`
- `CTU_BUNDLE_INTEGRITY=PASS`
- `L0_LOCAL_DEPENDENCY_CLOSURE=FAIL` before repair; repaired repository closure is covered by PASS regressions
- `MISSING_HELPER=p4-l6c-tree-digest.py`
- `ADDITIONAL_MISSING_LOCAL_HELPER=p4-l5-clock.py`
- `PRECONSUME_MUTATION=0`
- `SUCCESS_CORE_RESTARTS=1` (governance contract preserved; no live restart performed)
- `POSTCONSUME_FAILURE_MAX_CORE_RESTARTS=2` (governance contract preserved)
- `EXPLICIT_DETECTOR_LIFECYCLE_COMMANDS=0`
- `MARKER_ORDER=PASS`

The repository behavior reproduces the reported failure: a frozen-style bundle with a non-empty release catalog but without `p4-l6c-tree-digest.py` records `rel-a:UNREADABLE`, emits `L0_CAPTURE=PARTIAL`, and exits nonzero before marker consumption. The repaired bundle includes both direct `$P4_HERE` helpers and reaches `L0_CAPTURE=COMPLETE` with a valid 64-hex tree-state digest. The protected historical PRE evidence was requested with the exact `sudo -n sed` loop, but this host returned `sudo: a password is required`; no evidence file, marker, service, or Production state was modified.

## What changed

- Added `p4-l5-clock.py` and `p4-l6c-tree-digest.py` to `ctu_prepare_bundle()` so both direct L0 runtime dependencies receive the existing exact-main, root-owned, non-writable, manifest, and strict verification treatment.
- Added both helpers to `ctu_verifier_snapshot.py` trust closure.
- Added executable frozen-bundle/L0 capture regression coverage for BASE_MAIN failure behavior, COMPLETE positive behavior, missing/tampered helper refusal, and mechanically derived direct local dependency closure.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — bundle both direct L0 helpers.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_verifier_snapshot.py` — include both helpers in immutable control trust closure.
- `IDEA3-AEGIS_Lockdown/tests/test_ctu_l0_dependency_closure.py` — behavior-level closure and integrity regressions.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — current CTu-S9 status and limitation.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — current dependency-closure repair truth.

## Verification evidence

- `pytest -q IDEA3-AEGIS_Lockdown/tests/test_ctu_l0_dependency_closure.py` — PASS: 5 passed.
- `pytest -q IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l6c_capture_gap.py -k 'not unrelated_host_listener_churn' IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — PASS: 362 passed, 1 deselected.
- Same affected suite without deselection — PARTIAL: 357 passed, 1 failed because sandbox socket creation returned `Operation not permitted` in the pre-existing listener-churn test.
- `bash -n IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh` — PASS.
- `python3 -m py_compile IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_verifier_snapshot.py IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l5-clock.py IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l6c-tree-digest.py` — PASS.
- `git diff --check` — PASS.
- `sudo -n sed -n '1,240p' .../pre-root/<file>` for all requested historical evidence files — BLOCKED: sudo requires a password; read-only loop made no changes.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added CTu-S9 dependency-closure repair, evidence-access limitation, and unchanged no-live-execution truth.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — added both helper closure facts and the protected-evidence limitation to current repair state.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh` — CTu bundle/provenance contract used by the governed deployment path; requires Kla integration review.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_verifier_snapshot.py` — immutable CTu control trust closure; requires Security/Governance integration review.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — owner-maintained operational state.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` — owner-maintained IDEA3 current truth.

## Integration requests

- Music owner and Kla integration reviewer must inspect that both helpers remain exact-main, regular non-symlink, root-owned `0555`, manifest-listed, strictly verified, and included in the control snapshot closure. Confirm downstream fresh authority/freeze generation after human merge; do not reuse runner `7e31328f6e6576c4c7514b02e0125f871be8f6734d59030c43e36152bb64bc95` or its Authorization/K3. Human merge only; no live CTu/Recovery execution is authorized by this receipt.

## Known limitations

- Historical host evidence remains unread because `sudo -n` is unavailable; exact per-file UNAVAILABLE/UNREADABLE enumeration could not be independently completed on this host.
- One existing listener-churn regression requires host socket capability and is not runnable in this sandbox.
- No Production host, service, detector, marker, or historical evidence was touched.
