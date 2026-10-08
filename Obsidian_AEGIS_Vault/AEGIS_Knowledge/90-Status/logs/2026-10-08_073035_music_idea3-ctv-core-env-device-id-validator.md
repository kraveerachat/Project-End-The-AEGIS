---
title: Task Receipt — IDEA3 CTv core.env Device ID validator hotfix
date: 2026-10-08T07:30:35+07:00
owner: music
area: idea3
branch: fix/idea3-ctv-core-env-device-id-validator
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 CTv core.env Device ID validator hotfix

## What changed

Added the missing `ctv_validate_core_env_device_id` to the CTv library. It delegates to the reviewed `ctu_validate_core_env_device_id` (CTU_SUDO taken from CTV_SUDO) and fails closed with `CTV_DEVICE_ID_VALIDATOR_MISSING` if the CTu validator is not loaded. Fixes the first non-hermetic rehearsal failure `ctv_validate_core_env_device_id: command not found`, which occurs before CTv attempt consumption. Baseline: `00234dce8579f1256003e5299c33f4ee4492fcd8`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctv-run-lib.sh` — new delegating validator.
- `IDEA3-AEGIS_Lockdown/tests/test_ctv_successor.py` — 3 regression tests (availability, valid/invalid Device ID, missing-validator rejection with no canonical-dir writes, runner ordering before marker/consume).

## Verification evidence

- `pytest -q IDEA3-AEGIS_Lockdown/tests/test_ctv_successor.py` — PASS: 75 passed (2 new tests fail without the fix)
- `pytest -q IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py` — PASS: 30 passed
- `pytest -q test_ctu_l0_dependency_closure.py test_recovery_stage.py test_pr11_phase4_harness.py` — 297 passed, 1 failed: `test_only_reviewed_stage_handlers_are_registered` (CTv handler not in expected set); identical failure on unmodified baseline, unrelated
- `bash -n` on p4-ctv-run-lib.sh, run-ctv-owner.sh, p4-ctu-run-lib.sh — PASS
- `git diff --check` — PASS

## Canonical notes updated

None — narrow PRE-LIVE hotfix; no durable project fact changed.

## Shared surfaces touched

None — IDEA3-owned paths only.

## Integration requests

Independent security/governance review of the exact PR head before a new CTv authority/rehearsal. Human merge only.

## Known limitations

No CTv rehearsal, LIVE or Recovery executed; no CTu rerun; CTv and Recovery remain unconsumed; no Production mutation. The frozen runner and control snapshot must be regenerated from the merged main before any new attempt. Pre-existing harness test failure noted above is not addressed.
